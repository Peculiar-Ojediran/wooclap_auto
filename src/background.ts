import { sourceForUrl } from './content/adapter';
import { fingerprint, normalizeSettings, QuestionLedger, validateAnswer, validateAnswerPayload } from './shared/core';
import { BRIDGE_URL, PROTOCOL_VERSION, DEFAULT_SETTINGS, INITIAL_SESSION, type Settings, type SessionState, type Observation, type PendingAnswer, type CaptureRect, type SolveResponse } from './shared/types';

let settings: Settings = DEFAULT_SETTINGS;
let state: SessionState = { ...INITIAL_SESSION, log: [] };
let ledger = new QuestionLedger();
let answerCache: Record<string, PendingAnswer> = {};
let budgetDocument = '';
let runId: string | null = null;
let generation = 0;
let work: AbortController | null = null;
let currentDocument = '';
let pendingKey = '';
let eventKey = '';
let submitting = false;
let startInProgress = false;
let persistence: Promise<void> = Promise.resolve();

const initialized = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.local.get('settings');
  if (saved.settings) { try { settings = normalizeSettings(saved.settings); } catch { /* Use defaults for invalid/old settings. */ } }
  const session = await chrome.storage.session.get(['session', 'ledger', 'answerCache', 'budgetDocument']) as { session?: SessionState; ledger?: string[]; answerCache?: Record<string, PendingAnswer>; budgetDocument?: string };
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
    if (session.session.running) {
      state.phase = 'paused';
      state.detail = 'The background service restarted. Press Start to resume; previous requests will not be repeated.';
    }
  }
})();

function persist(): Promise<void> {
  const snapshot = structuredClone({ session: state, ledger: ledger.serialize(), answerCache, budgetDocument });
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
  invalidate();
  runId = null;
  state.running = false;
  const tabId = state.tabId;
  await update('paused', detail);
  if (tabId !== null) await chrome.tabs.sendMessage(tabId, { type: 'MONITOR_STOP' }).catch(() => undefined);
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

async function activeTab(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !sourceForUrl(tab.url)) throw new Error('Open a Wooclap participant question or the local practice page.');
  if (!tab.active) throw new Error('Keep the monitored tab active while answering.');
  return tab;
}

async function readCurrent(): Promise<{ observation: Observation; occurrence: number; documentKey: string; runId: string }> {
  if (state.tabId === null) throw new Error('No tab is selected.');
  await activeTab(state.tabId);
  const result = await chrome.tabs.sendMessage(state.tabId, { type: 'READ_CURRENT' });
  if (!result?.ok) throw new Error('Could not read the question. Refresh the page and press Start.');
  return result;
}

function isCurrent(expectedRun: string, expectedGeneration: number): boolean {
  return state.running && runId === expectedRun && generation === expectedGeneration;
}

async function capture(rect: CaptureRect, tabId: number): Promise<string> {
  const tab = await activeTab(tabId);
  const { x, y, width, height, viewportWidth, viewportHeight } = rect;
  if (![x, y, width, height, viewportWidth, viewportHeight].every(Number.isFinite) || x < 0 || y < 0 || width < 1 || height < 1
    || x + width > viewportWidth + 1 || y + height > viewportHeight + 1) throw new Error('The entire question and its images must be visible. Adjust zoom or scroll, then restart.');
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  // Capture is active-tab-only. Check again before using any pixels.
  await activeTab(tabId);
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

async function start(tabId: number): Promise<void> {
  if (startInProgress) throw new Error('A session is already starting.');
  startInProgress = true;
  const startGeneration = generation;
  try {
    if (state.running) throw new Error('Pause the current session before starting another.');
    const tab = await activeTab(tabId);
    const health = await bridge('/health');
    if (health.protocolVersion !== PROTOCOL_VERSION) throw new Error('The local bridge needs an update. Restart it with npm start, then reload the extension.');
    if (generation !== startGeneration) throw new Error('Starting was cancelled. Press Start when ready.');
    if (!health.ready) throw new Error('Add OPENAI_API_KEY to .env and restart the local service, or run npm run demo for practice.');
    if (health.demo && sourceForUrl(tab.url!) !== 'practice') throw new Error('The demo service only answers the local practice page. Run npm start for Wooclap.');
    invalidate();
    runId = crypto.randomUUID();
    eventKey = '';
    currentDocument = '';
    state = { ...state, running: true, tabId, mode: settings.mode, pending: null, bridgeMode: health.demo ? 'demo' : 'openai' };
    await update('waiting', health.demo ? 'Practice mode. Waiting for a supported question.' : 'Watching this tab for a supported question.');
    const message = { type: 'MONITOR_START', runId, selectors: settings.selectors };
    try { await chrome.tabs.sendMessage(tabId, message); }
    catch {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tabId, message);
    }
  } catch (error) {
    if (state.running) await pause('Could not start monitoring. Refresh the page and try again.');
    throw error;
  } finally { startInProgress = false; }
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
  if (eventKey && question.eventKey !== eventKey) { await pause('The event changed. Press Start to monitor the new event.'); return; }
  eventKey = question.eventKey;
  const fp = fingerprint(question);
  const key = JSON.stringify([state.bridgeMode, state.bridgeMode === 'openai' ? settings.model : 'local-demo', documentKey, occurrence, fp]);
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
      if (!cached.answer.needsReview && cached.question.application !== 'preview' && settings.mode === 'auto' && isCurrent(expectedRun, expectedGeneration)) await applyPending();
    } else await update('review', 'This question was already requested or submitted. Waiting for the next question to avoid a duplicate.');
    return;
  }
  const controller = new AbortController();
  work = controller;
  try {
    if (state.requestCount >= settings.requestLimit) { await pause('The request limit was reached. Increase it in Settings to continue.'); return; }
    await activeTab(state.tabId);
    let screenshot: string | undefined;
    if (question.imageKeys.length) {
      if (!settings.captureImages) throw new Error('This question needs its image. Enable image capture in Settings.');
      if (!observation.rect) throw new Error('Could not locate all question images. Review this question manually.');
      screenshot = await capture(observation.rect, state.tabId);
    }
    const latest = await readCurrent();
    if (!isCurrent(expectedRun, expectedGeneration) || latest.documentKey !== documentKey || latest.occurrence !== occurrence
      || !latest.observation.question || fingerprint(latest.observation.question) !== fp) return;
    if (screenshot && JSON.stringify(latest.observation.rect) !== JSON.stringify(observation.rect)) throw new Error('The question moved during image capture. Keep the entire question visible and restart.');
    if (!ledger.claim(key)) return;
    state.requestCount += 1;
    // Record the claim and budget before making a billable request.
    await update('solving', state.bridgeMode === 'demo' ? 'Preparing a local practice answer.' : `Asking OpenAI (${settings.model}) for an answer.`);
    if (!isCurrent(expectedRun, expectedGeneration)) return;
    const requestStarted = Date.now();
    const response: SolveResponse = await bridge('/solve', { protocolVersion: PROTOCOL_VERSION, question, model: settings.model, ...(screenshot ? { screenshot } : {}) }, controller.signal);
    if (!isCurrent(expectedRun, expectedGeneration)) return;
    if (response.demo && question.source !== 'practice') throw new Error('A demo answer cannot be used on Wooclap.');
    state.lastResponse = { model: response.model, usage: response.usage, elapsedMs: Date.now() - requestStarted, demo: response.demo };
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
    if (question.application !== 'preview' && settings.mode === 'auto' && isCurrent(expectedRun, expectedGeneration)) await applyPending();
  } catch (error) {
    if (isCurrent(expectedRun, expectedGeneration)) await update('error', error instanceof Error ? error.message : 'The answer request failed.', { pending: null });
  } finally { if (work === controller) work = null; }
}

async function handleContent(message: any, sender: chrome.runtime.MessageSender): Promise<object> {
  if (!state.running || sender.tab?.id !== state.tabId || sender.frameId !== 0 || message.runId !== runId) return { ok: true, stop: true };
  if (!sender.url || !sourceForUrl(sender.url)) return { ok: false, stop: true };
  if (message.type === 'TAB_HIDDEN') { await pause('The monitored tab became inactive. Return to it and press Start.'); return { ok: true }; }
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
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) {
    if (sender.tab) return handleContent(message, sender);
    throw new Error('Only the extension can change settings.');
  }
  switch (message.type) {
    case 'GET_STATE': return { ok: true, state, settings };
    case 'CHECK_BRIDGE': return { ok: true, health: await bridge('/health') };
    case 'SAVE_SETTINGS': {
      const next = normalizeSettings(message.settings);
      if (state.running) await pause('Settings changed. Press Start to apply them.');
      settings = next;
      state.mode = settings.mode;
      await chrome.storage.local.set({ settings });
      await persist();
      return { ok: true, state, settings };
    }
    case 'START': await start(message.tabId); break;
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
chrome.tabs.onRemoved.addListener(tabId => { void initialized.then(() => { if (state.tabId === tabId && state.running) return pause('The monitored tab was closed.'); }); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') void initialized.then(() => { if (state.tabId === tabId && state.running) return pause('The page navigated. Press Start on the new question page.'); });
});
chrome.tabs.onActivated.addListener(info => {
  void initialized.then(async () => {
    if (!state.running || state.tabId === null || info.tabId === state.tabId) return;
    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    if (!tab || tab.windowId === info.windowId) await pause('The monitored tab became inactive. Return to it and press Start.');
  });
});
