import { SessionScheduler, SCHEDULE_ALARM_PREFIX } from './scheduler';
import type { ScheduledSession } from './shared/schedules';
import { sourceForUrl } from './content/adapter';
import { BackgroundTab } from './background-tab';
import { CredentialVault } from './credentials';
import { DirectRequestGate } from './direct-request-gate';
import { createOpenAISolver, demoSolver } from './ai/solver';
import { createAnthropicSolver } from './ai/anthropic';
import { createNvidiaSolver } from './ai/nvidia';
import { createHostedSolver, hostedHealth } from './ai/hosted';
import { isSettingsUi } from './shared/urls';
import { fingerprint, normalizeSettings, QuestionLedger, validateAnswer, validateAnswerPayload } from './shared/core';
import { BRIDGE_URL, PROTOCOL_VERSION, PROVIDER_LABELS, DEFAULT_SETTINGS, INITIAL_SESSION, type Settings, type SessionState, type Observation, type PendingAnswer, type CaptureRect, type SolveResponse } from './shared/types';

let settings: Settings = DEFAULT_SETTINGS;
let state: SessionState = { ...INITIAL_SESSION, log: [] };
let ledger = new QuestionLedger();
let answerCache: Record<string, PendingAnswer> = {};
let budgetDocument = '';
let runId: string | null = null;
let generation = 0;
let scheduleInterruption = 0;
let work: AbortController | null = null;
let currentDocument = '';
let pendingKey = '';
let eventKey = '';
let submitting = false;
let startInProgress = false;
let startingTabId: number | null = null;
let persistence: Promise<void> = Promise.resolve();
const backgroundTab = new BackgroundTab();
let stopping: Promise<void> = Promise.resolve();
const credentials = new CredentialVault(chrome.storage.session, chrome.storage.local);
let credentialChanges = 0;
let credentialMutation: Promise<void> = Promise.resolve();
let providerProtocol = false;
let directRequests = new DirectRequestGate();

const scheduler = new SessionScheduler({
  busy: () => state.running || startInProgress || Boolean(credentialChanges),
  guard: () => {
    const expected = scheduleInterruption;
    return () => { if (scheduleInterruption !== expected) throw new Error('Scheduled startup was interrupted. Schedule again when ready.'); };
  },
  start: (tabId, job, guard) => start(tabId, job, guard),
  stop: async (tabId, detail) => {
    if ((state.tabId === tabId && state.running) || startingTabId === tabId) await pause(detail);
  }
});
const backgroundEnabled = () => state.backgroundMode ?? settings.backgroundMode;

const initialized = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.local.get('settings');
  if (saved.settings) { try { settings = normalizeSettings(saved.settings); } catch { /* Use defaults for invalid/old settings. */ } }
  const session = await chrome.storage.session.get(['session', 'ledger', 'answerCache', 'budgetDocument', 'directRequestTimes']) as { session?: SessionState; ledger?: string[]; answerCache?: Record<string, PendingAnswer>; budgetDocument?: string; directRequestTimes?: number[] };
  directRequests = new DirectRequestGate(session.directRequestTimes);
  ledger = new QuestionLedger(session.ledger || []);
  answerCache = session.answerCache || {};
  // Keep consumed claims across upgrades. Only discard cache entries whose
  // payload no longer conforms to the current answer contracts.
  for (const [key, pending] of Object.entries(answerCache)) {
    try { if (validateAnswerPayload(pending.question, pending.answer)) delete answerCache[key]; }
    catch { delete answerCache[key]; }
  }
  budgetDocument = session.budgetDocument || '';
  if (session.session) {
    state = { ...INITIAL_SESSION, ...session.session, running: false, pending: null };
    state.connectionMode ??= 'bridge';
    if (state.lastResponse) state.lastResponse.connectionMode ??= 'bridge';
    if (state.lastResponse && !state.lastResponse.demo && !state.lastResponse.provider) {
      state.lastResponse.provider = state.bridgeMode === 'anthropic' ? 'anthropic' : 'openai';
    }
    if (session.session.running) {
      state.phase = 'paused';
      state.detail = 'The background service restarted. Press Start to resume; previous requests will not be repeated.';
    }
  }
  // A browser/worker restart never silently resumes a submission. Clean up the
  // prior session's tab protection while retaining its request ledger.
  await backgroundTab.recover();
  await scheduler.initialize();
})();

function persist(): Promise<void> {
  const snapshot = structuredClone({ session: state, ledger: ledger.serialize(), answerCache, budgetDocument, directRequestTimes: directRequests.serialize() });
  persistence = persistence.catch(() => undefined).then(() => chrome.storage.session.set(snapshot));
  return persistence;
}

async function update(phase: SessionState['phase'], detail: string, extra: Partial<SessionState> = {}): Promise<void> {
  const changed = state.phase !== phase || state.detail !== detail;
  state = { ...state, ...extra, phase, detail };
  if (changed) state.log = [{ time: Date.now(), message: detail }, ...state.log].slice(0, 20);
  await persist();
  await chrome.action.setBadgeText({ text: state.running ? (state.mode === 'auto' ? 'AUTO' : 'ON') : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
}

function invalidate(): void {
  generation += 1;
  work?.abort();
  work = null;
  state.pending = null;
  pendingKey = '';
}

async function pause(detail = 'Paused. Press Start when you are ready.'): Promise<void> {
  scheduleInterruption++;
  void scheduler.stopped(startingTabId ?? state.tabId, detail).catch(() => undefined);
  invalidate();
  runId = null;
  state.running = false;
  const tabId = state.tabId;
  stopping = Promise.all([
    update('paused', detail),
    tabId !== null ? chrome.tabs.sendMessage(tabId, { type: 'MONITOR_STOP' }).catch(() => undefined) : Promise.resolve(),
    backgroundTab.release()
  ]).then(() => undefined);
  await stopping;
}

async function bridge(path: string, body?: object, signal?: AbortSignal): Promise<any> {
  if (!settings.bridgeToken) throw new Error('Add the local service pairing token in Settings first.');
  const timeout = AbortSignal.timeout(28_000);
  let response: Response;
  try {
    response = await fetch(BRIDGE_URL + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${settings.bridgeToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(timeout.aborted ? 'The AI request timed out. Check the page before trying again.' : 'Local service unavailable. Run npm start or npm run demo, then check Settings.');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : typeof result?.error?.message === 'string' ? result.error.message : `Local service returned HTTP ${response.status}.`);
  return result;
}

async function bridgeHealth(): Promise<any> {
  const health = await bridge('/health');
  if (health.protocolVersion !== PROTOCOL_VERSION) throw new Error('The local bridge needs an update. Restart it with npm start, then reload the extension.');
  if (health.demo) return health;
  const stored = (await credentials.status())[settings.provider].configured;
  if ((stored || settings.provider !== 'openai') && (health.acceptsClientKeys !== true || !health.providers?.[settings.provider])) {
    throw new Error('Restart the updated local bridge with npm start to use this provider or API keys from Settings.');
  }
  return { ...health, provider: settings.provider,
    ready: stored || Boolean(health.providers?.[settings.provider]?.ready ?? (settings.provider === 'openai' && health.ready)) };
}

async function connectionHealth(): Promise<any> {
  if (settings.connectionMode === 'bridge') return { ...await bridgeHealth(), connectionMode: 'bridge' };
  if (settings.connectionMode === 'demo') return { ready: true, demo: true, model: 'local-demo', connectionMode: 'demo' };
  const stored = (await credentials.status())[settings.provider].configured;
  if (!stored) return hostedHealth();
  return { ready: true, demo: false, model: settings.model, provider: settings.provider, connectionMode: 'direct' };
}

async function monitoredTab(tabId: number, requireForeground = !backgroundEnabled()): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !sourceForUrl(tab.url)) throw new Error('Open a Wooclap participant question or the local practice page.');
  if (tab.discarded) throw new Error('The monitored page was unloaded. Return to it and press Start.');
  if (requireForeground && (!tab.active || (await chrome.windows.get(tab.windowId)).state === 'minimized')) {
    throw new Error('Keep the monitored tab visible, or enable background mode in Settings.');
  }
  return tab;
}

async function readCurrent(): Promise<{ observation: Observation; occurrence: number; documentKey: string; runId: string }> {
  if (state.tabId === null) throw new Error('No tab is selected.');
  await monitoredTab(state.tabId);
  if (backgroundEnabled() && !backgroundTab.owns(state.tabId)) throw new Error('The background connection ended. Press Start to reconnect.');
  const result = await chrome.tabs.sendMessage(state.tabId, { type: 'READ_CURRENT' });
  if (!result?.ok) throw new Error('Could not read the question. Refresh the page and press Start.');
  return result;
}

function isCurrent(expectedRun: string, expectedGeneration: number): boolean {
  return state.running && runId === expectedRun && generation === expectedGeneration
    && (state.endsAt === undefined || Date.now() < state.endsAt);
}

async function capture(rect: CaptureRect, tabId: number): Promise<string> {
  const captureRun = runId, captureGeneration = generation;
  const tab = await monitoredTab(tabId);
  if (!captureRun || !isCurrent(captureRun, captureGeneration)) throw new Error('Image capture was cancelled.');
  const { x, y, width, height, viewportWidth, viewportHeight } = rect;
  if (![x, y, width, height, viewportWidth, viewportHeight].every(Number.isFinite) || x < 0 || y < 0 || width < 1 || height < 1
    || x + width > viewportWidth + 1 || y + height > viewportHeight + 1) throw new Error('The entire question and its images must be visible. Adjust zoom or scroll, then restart.');
  let dataUrl: string;
  if (backgroundEnabled()) {
    try { dataUrl = await backgroundTab.capture(tabId); }
    catch (error) {
      // A timed-out CDP command cannot be canceled with Promise.race. Detach
      // before allowing another session, and never capture a different tab.
      if (captureRun && isCurrent(captureRun, captureGeneration)) await pause(error instanceof Error ? error.message : 'Background capture failed.');
      throw error;
    }
  } else dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  await monitoredTab(tabId);
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const pixelBytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([pixelBytes], { type: 'image/png' }));
  try {
    const sx = bitmap.width / viewportWidth, sy = bitmap.height / viewportHeight;
    const canvas = new OffscreenCanvas(Math.ceil(width * sx), Math.ceil(height * sy));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not crop the screenshot.');
    context.drawImage(bitmap, x * sx, y * sy, width * sx, height * sy, 0, 0, canvas.width, canvas.height);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    if (bytes.length > 4_000_000) throw new Error('Question screenshot is too large. Reduce the browser zoom.');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return 'data:image/png;base64,' + btoa(binary);
  } finally { bitmap.close(); }
}

async function start(tabId: number, scheduled?: ScheduledSession, scheduleGuard?: () => void): Promise<void> {
  if (credentialChanges) throw new Error('Wait for the API key change to finish before starting.');
  if (startInProgress) throw new Error('A session is already starting.');
  if (state.running) throw new Error('Pause the current session before starting another.');
  startInProgress = true;
  startingTabId = tabId;
  const startGeneration = generation;
  const backgroundMode = scheduled ? true : settings.backgroundMode;
  try {
    await stopping;
    const stillStarting = () => { scheduleGuard?.(); if (generation !== startGeneration) throw new Error('Starting was cancelled. Press Start when ready.'); };
    stillStarting();
    const tab = await monitoredTab(tabId, !backgroundMode);
    const health = await connectionHealth();
    stillStarting();
    if (!health.ready) throw new Error(health.detail || `Add a ${PROVIDER_LABELS[settings.provider]} API key in Settings${settings.connectionMode === 'bridge' ? ' or configure it on the local bridge' : ''}.`);
    if (health.demo && sourceForUrl(tab.url!) !== 'practice') throw new Error('Demo mode only answers the practice page. Select Direct API and add a key to answer Wooclap questions.');
    const latestTab = await monitoredTab(tabId, !backgroundMode);
    stillStarting();
    if (latestTab.url !== tab.url) throw new Error('The page changed while starting. Press Start on the new page.');
    invalidate();
    runId = crypto.randomUUID();
    eventKey = '';
    currentDocument = '';
    providerProtocol = health.acceptsClientKeys === true;
    state = { ...state, running: true, tabId, mode: scheduled?.mode ?? settings.mode, pending: null,
      backgroundMode, scheduleId: scheduled?.id, endsAt: scheduled?.endsAt,
      connectionMode: health.connectionMode, bridgeMode: health.demo ? 'demo' : health.provider ?? settings.provider,
      model: health.connectionMode === 'hosted' ? health.model : settings.model };
    const expectedRun = runId, startedGeneration = generation;
    const guard = () => { scheduleGuard?.(); if (!isCurrent(expectedRun, startedGeneration)) throw new Error('Starting was cancelled. Press Start when ready.'); };
    if (backgroundMode) await backgroundTab.acquire(tabId, guard);
    guard();
    await update('waiting', backgroundMode ? 'Background mode is watching the selected tab. You can switch tabs or minimize Edge.'
      : health.demo ? 'Practice mode. Waiting for a supported question.' : 'Watching this tab for a supported question.');
    guard();
    const message = { type: 'MONITOR_START', runId, selectors: settings.selectors, backgroundMode, endsAt: scheduled?.endsAt };
    try { await chrome.tabs.sendMessage(tabId, message); }
    catch {
      guard();
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      guard();
      await chrome.tabs.sendMessage(tabId, message);
    }
    guard();
  } catch (error) {
    if (state.running) await pause('Could not start monitoring. Refresh the page and try again.');
    throw error;
  } finally { startInProgress = false; startingTabId = null; }
}

async function applyPending(): Promise<void> {
  if (submitting) throw new Error('An answer is already being submitted.');
  const pending = state.pending;
  const expectedRun = runId;
  const expectedGeneration = generation;
  const submittedKey = pendingKey;
  if (!pending || !expectedRun || !state.running) throw new Error('There is no current answer to submit.');
  if (pending.question.application === 'preview') throw new Error('This question currently supports answer previews. Apply the answer on the page.');
  submitting = true;
  try {
    const latest = await readCurrent();
    if (!isCurrent(expectedRun, expectedGeneration) || latest.runId !== expectedRun || latest.documentKey !== currentDocument
      || latest.occurrence !== pending.occurrence || !latest.observation.question || fingerprint(latest.observation.question) !== pending.fingerprint) {
      throw new Error('The question changed. The previous answer was discarded.');
    }
    const issue = validateAnswer(pending.question, pending.answer);
    if (issue) throw new Error(issue);
    if (pending.inputSignature !== undefined && latest.observation.inputSignature !== pending.inputSignature) {
      throw new Error('The page inputs changed while the answer was being prepared. Your entries were left unchanged.');
    }
    await update('submitting', 'Selecting the answer and submitting once.');
    if (!isCurrent(expectedRun, expectedGeneration)) return;
    // Consume the cached answer before any clicks. An uncertain submission must
    // never become a retry when the user pauses, reloads the worker, or resumes.
    delete answerCache[submittedKey];
    await persist();
    if (!isCurrent(expectedRun, expectedGeneration)) return;
    const result = await chrome.tabs.sendMessage(state.tabId!, { type: 'APPLY_ANSWER', runId: expectedRun, documentKey: currentDocument, pending });
    if (!isCurrent(expectedRun, expectedGeneration)) return;
    if (!result?.ok) throw new Error(result?.error || 'Could not submit the answer.');
    state.pending = null;
    if (result.confirmed) await update('submitted', result.detail);
    else await pause(result.detail);
  } catch (error) {
    if (isCurrent(expectedRun, expectedGeneration)) await pause(error instanceof Error ? error.message : 'Could not submit this answer.');
  } finally { submitting = false; }
}

async function solve(observation: Observation, occurrence: number, documentKey: string): Promise<void> {
  const question = observation.question;
  if (!question || !runId || state.tabId === null) return;
  const solvingTabId = state.tabId;
  if (eventKey && question.eventKey !== eventKey) { await pause('The event changed. Press Start to monitor the new event.'); return; }
  eventKey = question.eventKey;
  const fp = fingerprint(question);
  // Freeze the route chosen at Start; key/settings changes pause the session.
  const transport = state.connectionMode ?? settings.connectionMode;
  const provider = state.bridgeMode && state.bridgeMode !== 'demo' ? state.bridgeMode : settings.provider;
  const model = state.model ?? settings.model;
  // Preserve legacy bridge claims while isolating direct/demo answers.
  const key = JSON.stringify([...(transport === 'bridge' ? [] : [transport]), state.bridgeMode,
    state.bridgeMode === 'demo' ? 'local-demo' : model, documentKey, occurrence, fp]);
  currentDocument = documentKey;
  pendingKey = key;
  const expectedRun = runId;
  const expectedGeneration = generation;
  if (budgetDocument !== documentKey) {
    budgetDocument = documentKey;
    state.requestCount = 0;
  }
  if (ledger.has(key)) {
    const cached = answerCache[key];
    if (cached) {
      await update(cached.answer.needsReview ? 'review' : 'suggestion', 'Restored the answer for this question without another AI request.', { pending: cached });
      if (!cached.answer.needsReview && cached.question.application !== 'preview' && state.mode === 'auto' && isCurrent(expectedRun, expectedGeneration)) await applyPending();
    } else await update('review', 'This question was already requested or submitted. Waiting for the next question to avoid a duplicate.');
    return;
  }
  const controller = new AbortController();
  work = controller;
  let releaseRequest: (() => void) | undefined;
  try {
    if (state.requestCount >= settings.requestLimit) { await pause('The request limit was reached. Increase it in Settings to continue.'); return; }
    await monitoredTab(solvingTabId);
    if (!isCurrent(expectedRun, expectedGeneration)) return;
    if (backgroundEnabled() && !backgroundTab.owns(solvingTabId)) throw new Error('The background connection ended. Press Start to reconnect.');
    let screenshot: string | undefined;
    if (question.imageKeys.length && settings.connectionMode !== 'demo') {
      if (!settings.captureImages) throw new Error('This question needs its image. Enable image capture in Settings.');
      if (!observation.rect) throw new Error('Could not locate all question images. Review this question manually.');
      screenshot = await capture(observation.rect, solvingTabId);
    }
    const latest = await readCurrent();
    if (!isCurrent(expectedRun, expectedGeneration) || latest.documentKey !== documentKey || latest.occurrence !== occurrence
      || !latest.observation.question || fingerprint(latest.observation.question) !== fp) return;
    if (screenshot && JSON.stringify(latest.observation.rect) !== JSON.stringify(observation.rect)) throw new Error('The question moved during image capture. Keep the entire question visible and restart.');
    const apiKey = state.bridgeMode === 'demo' || transport === 'hosted' ? undefined : await credentials.read(provider);
    if (!isCurrent(expectedRun, expectedGeneration)) return;
    if (transport === 'direct' || transport === 'hosted') {
      if (transport === 'direct' && !apiKey) throw new Error(`Add a ${PROVIDER_LABELS[provider]} API key in Settings.`);
      releaseRequest = directRequests.claim();
    }
    if (!ledger.claim(key)) return;
    state.requestCount += 1;
    // Record the claim and budget before making a billable request.
    await update('solving', state.bridgeMode === 'demo' ? 'Preparing a local practice answer.' : `Asking ${PROVIDER_LABELS[provider]} (${model})${transport === 'hosted' ? ' through the shared service' : ''} for an answer.`);
    if (!isCurrent(expectedRun, expectedGeneration)) return;
    const requestStarted = Date.now();
    const request = { protocolVersion: PROTOCOL_VERSION as typeof PROTOCOL_VERSION, question, model, ...(screenshot ? { screenshot } : {}) };
    let response: SolveResponse;
    if (transport === 'bridge') {
      response = await bridge('/solve', { ...request,
        ...(providerProtocol && state.bridgeMode !== 'demo' ? { provider } : {}), ...(apiKey ? { apiKey } : {}) }, controller.signal);
    } else if (transport === 'demo') response = await demoSolver(request, controller.signal);
    else if (transport === 'hosted') response = await createHostedSolver()({ ...request, provider }, controller.signal);
    else {
      const solver = provider === 'nvidia' ? createNvidiaSolver(apiKey!)
        : provider === 'anthropic' ? createAnthropicSolver(apiKey!, { allowBrowser: true }) : createOpenAISolver(apiKey!, { allowBrowser: true });
      response = await solver({ ...request, provider }, controller.signal);
    }
    if (!isCurrent(expectedRun, expectedGeneration)) return;
    if (response.demo !== (state.bridgeMode === 'demo') || (response.provider && response.provider !== provider)) throw new Error('The service returned an answer from a different provider. Restart the session.');
    if (response.demo && question.source !== 'practice') throw new Error('A demo answer cannot be used on Wooclap.');
    state.lastResponse = { connectionMode: transport, provider: response.demo ? undefined : response.provider ?? provider, model: response.model, usage: response.usage, elapsedMs: Date.now() - requestStarted, demo: response.demo };
    const issue = validateAnswer(question, response.answer);
    const pending: PendingAnswer = { question, answer: response.answer, fingerprint: fp, occurrence, demo: response.demo,
      ...(observation.inputSignature !== undefined ? { inputSignature: observation.inputSignature } : {}) };
    if (issue) {
      if (response.answer.needsReview) answerCache[key] = pending;
      await update('review', issue, { pending: response.answer.needsReview ? pending : null });
      return;
    }
    answerCache[key] = pending;
    await update('suggestion', question.application === 'preview' ? 'Answer preview ready. Apply it on the Wooclap page.'
      : response.demo ? 'Practice answer ready. Review it below.' : 'Answer ready. Review it below.', { pending });
    if (question.application !== 'preview' && state.mode === 'auto' && isCurrent(expectedRun, expectedGeneration)) await applyPending();
  } catch (error) {
    if (isCurrent(expectedRun, expectedGeneration)) await update('error', error instanceof Error ? error.message : 'The answer request failed.', { pending: null });
  } finally { releaseRequest?.(); if (work === controller) work = null; }
}

async function handleContent(message: any, sender: chrome.runtime.MessageSender): Promise<object> {
  if (!state.running || sender.tab?.id !== state.tabId || sender.frameId !== 0 || message.runId !== runId) return { ok: true, stop: true };
  if (state.endsAt !== undefined && Date.now() >= state.endsAt) { await pause('Scheduled duration ended.'); void scheduler.tick(); return { ok: true, stop: true }; }
  if (!sender.url || !sourceForUrl(sender.url)) return { ok: false, stop: true };
  if (message.type === 'PAGE_DEPARTED') { await pause('The monitored page was left. Press Start on the new page.'); return { ok: true }; }
  if (message.type === 'TAB_HIDDEN') {
    if (!backgroundEnabled()) await pause('The monitored tab became inactive. Return to it and press Start.');
    return { ok: true };
  }
  if (message.type === 'CONTENT_DIRTY') {
    if (!submitting) { invalidate(); await update('waiting', 'The page changed. Waiting for the question to settle.'); }
    return { ok: true };
  }
  if (message.type !== 'OBSERVATION' || submitting) return { ok: true };
  const observation: Observation = message.observation;
  if (observation.state === 'question' && observation.question) {
    // Long work is intentionally detached so Pause and newer observations remain responsive.
    void solve(observation, message.occurrence, message.documentKey);
  } else {
    invalidate();
    await update(observation.state === 'submitted' ? 'submitted' : observation.state === 'unsupported' ? 'review' : 'waiting', observation.detail);
  }
  return { ok: true };
}

async function handle(message: any, sender: chrome.runtime.MessageSender): Promise<object> {
  await initialized;
  if (sender.id !== chrome.runtime.id) throw new Error('Unknown extension sender.');
  if (!isSettingsUi(sender.url) || (sender.frameId !== undefined && sender.frameId !== 0)) {
    if (sender.tab && ['OBSERVATION', 'CONTENT_DIRTY', 'PAGE_DEPARTED', 'TAB_HIDDEN'].includes(message.type)) return handleContent(message, sender);
    throw new Error('Only the extension can change settings.');
  }
  switch (message.type) {
    case 'GET_SCHEDULES': return { ok: true, schedules: scheduler.list() };
    case 'ADD_SCHEDULE': return { ok: true, schedules: await scheduler.add(message) };
    case 'CANCEL_SCHEDULE': return { ok: true, schedules: await scheduler.cancel(message.id) };
    case 'REMOVE_SCHEDULE': return { ok: true, schedules: await scheduler.remove(message.id) };
    case 'GET_STATE': return { ok: true, state, settings, credentials: await credentials.status() };
    case 'CHECK_BRIDGE':
    case 'CHECK_CONNECTION': return { ok: true, health: await connectionHealth() };
    case 'SAVE_API_KEY':
    case 'CLEAR_API_KEY': {
      credentialChanges++;
      // Serialize the whole transition, including asynchronous tab cleanup.
      // Otherwise a slower earlier Save could run after a subsequent Forget.
      const mutation = credentialMutation.catch(() => undefined).then(async () => {
        await pause('API key settings changed. Press Start to continue.');
        // Discard answers associated with previous credentials, but preserve
        // consumed ledger claims to avoid repeating uncertain submissions.
        answerCache = {};
        await persist();
        if (message.type === 'SAVE_API_KEY') await credentials.save(message.provider, message.apiKey, message.remember, message.consent);
        else await credentials.clear(message.provider);
      });
      credentialMutation = mutation;
      try {
        await mutation;
        return { ok: true, credentials: await credentials.status() };
      } finally { credentialChanges--; }
    }
    case 'SAVE_SETTINGS': {
      const next = normalizeSettings(message.settings);
      if (state.running || startInProgress || scheduler.starting) await pause('Settings changed. Press Start to apply them.');
      settings = next;
      state.mode = settings.mode;
      await chrome.storage.local.set({ settings });
      await persist();
      return { ok: true, state, settings };
    }
    case 'START': if (scheduler.starting) throw new Error('A scheduled session is starting. Cancel it first.'); await start(message.tabId); break;
    case 'PAUSE': await pause(); break;
    case 'APPROVE': {
      if (message.answer !== undefined) {
        const pending = state.pending;
        if (!pending || state.phase !== 'suggestion' || pending.answer.needsReview
          || message.fingerprint !== pending.fingerprint || message.occurrence !== pending.occurrence) throw new Error('The suggestion changed. Review the current answer.');
        const issue = validateAnswer(pending.question, message.answer);
        if (issue) throw new Error(issue);
        state.pending = { ...pending, answer: message.answer };
      }
      await applyPending(); break;
    }
    case 'SKIP': delete answerCache[pendingKey]; await update('waiting', 'Suggestion skipped. Waiting for the next question.', { pending: null }); break;
    default: throw new Error('Unknown extension command.');
  }
  return { ok: true, state, settings };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  void handle(message, sender).then(reply).catch(error => reply({ ok: false, error: error instanceof Error ? error.message : 'Extension request failed.' }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith(SCHEDULE_ALARM_PREFIX)) void initialized.then(() => scheduler.tick()).catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => { void initialized.then(() => scheduler.tick()).catch(() => undefined); });
chrome.tabs.onRemoved.addListener(tabId => { void initialized.then(() => {
  void scheduler.removed(tabId);
  if ((state.tabId === tabId && state.running) || startingTabId === tabId) return pause('The monitored tab was closed.');
}); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' || change.discarded) void initialized.then(() => {
    if ((state.tabId === tabId && state.running) || startingTabId === tabId) return pause('The page navigated or was unloaded. Press Start on the new question page.');
  });
});
chrome.tabs.onActivated.addListener(info => {
  void initialized.then(async () => {
    if (!state.running || backgroundEnabled() || state.tabId === null || info.tabId === state.tabId) return;
    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    if (!tab || tab.windowId === info.windowId) await pause('The monitored tab became inactive. Return to it and press Start.');
  });
});
chrome.debugger.onDetach.addListener(source => {
  if (source.tabId !== undefined && backgroundTab.handleDetach(source.tabId)) {
    // pause invalidates pending work synchronously, before any cleanup awaits.
    void pause('The background connection was closed. Close DevTools if needed, then press Start to reconnect.');
  }
});
