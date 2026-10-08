import { BRIDGE_URL, type Answer, type SessionState, type Settings } from '../shared/types';
import { validateAnswer } from '../shared/core';
import { renderAnswerEditor } from './answer-editor';

interface StateResponse { ok: boolean; state?: SessionState; settings?: Settings; error?: string }

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}

const startButton = element<HTMLButtonElement>('start-button');
const pauseButton = element<HTMLButtonElement>('pause-button');
const approveButton = element<HTMLButtonElement>('approve-button');
const skipButton = element<HTMLButtonElement>('skip-button');
const errorMessage = element('error-message');
let busy = false;
let lastState: SessionState | undefined;
let lastSettings: Settings | undefined;
let polling = false;
let requestSequence = 0;
let latestResponseSequence = 0;
let draftKey = '';
let draftAnswer: Answer | undefined;

function updateApproval(): void {
  const pending = lastState?.pending;
  approveButton.disabled = busy || !pending || lastState?.phase !== 'suggestion' || pending.question.application === 'preview'
    || !draftAnswer || Boolean(validateAnswer(pending.question, draftAnswer));
}

const phaseLabels: Record<SessionState['phase'], string> = {
  idle: 'Ready to begin', waiting: 'Watching for questions', solving: 'Preparing an answer',
  suggestion: 'Answer ready', submitting: 'Submitting answer', submitted: 'Answer submitted',
  review: 'Needs your review', error: 'Something needs attention', paused: 'Session paused'
};

function showError(error: unknown): void {
  errorMessage.textContent = error instanceof Error ? error.message : String(error);
  errorMessage.hidden = false;
}

function render(state: SessionState, settings: Settings): void {
  lastState = state;
  lastSettings = settings;
  const phase = element('phase');
  phase.textContent = phaseLabels[state.phase] ?? state.phase;
  phase.dataset.phase = state.phase;
  const answerMode = (state.running ? state.mode : settings.mode) === 'auto' ? 'Auto-submit mode' : 'Suggestion mode';
  element('mode').textContent = `${answerMode}${settings.backgroundMode ? ' · Background' : ''}`;
  element('session-detail').textContent = state.detail;
  element('request-count').textContent = `${state.requestCount} / ${settings.requestLimit} requests`;
  const bridgeMode = element('bridge-mode');
  bridgeMode.hidden = !state.bridgeMode;
  bridgeMode.textContent = state.bridgeMode === 'demo' ? 'Session source: local demo · no AI requests'
    : state.bridgeMode === 'openai' ? 'Session source: OpenAI via local bridge' : '';
  const response = state.lastResponse;
  element('response-metadata').hidden = !response;
  if (response) {
    element('response-source').textContent = response.demo ? 'Local demo' : 'OpenAI response received';
    element('response-model').textContent = response.model;
    element('response-model').title = response.model;
    element('response-latency').textContent = Number.isFinite(response.elapsedMs) && response.elapsedMs >= 0
      ? `${response.elapsedMs < 1000 ? `${Math.round(response.elapsedMs)} ms` : `${(response.elapsedMs / 1000).toFixed(1)} s`} response time`
      : 'Response time unavailable';
    element('response-tokens').textContent = response.usage
      ? `${response.usage.inputTokens.toLocaleString()} input / ${response.usage.outputTokens.toLocaleString()} output tokens`
      : response.demo ? 'No API tokens used' : 'Token usage unavailable';
  }
  startButton.disabled = busy || state.running;
  startButton.firstChild!.textContent = state.running ? 'Session running ' : 'Start on this tab ';
  pauseButton.disabled = busy || !state.running;

  const pending = state.pending;
  element('answer-card').hidden = !pending;
  element('empty-state').hidden = Boolean(pending);
  if (pending) {
    element('question-text').textContent = pending.question.text;
    element('answer-explanation').textContent = pending.answer.explanation;
    element('demo-badge').hidden = !pending.demo;
    element('review-note').hidden = state.phase !== 'review' && !pending.answer.needsReview && pending.question.application !== 'preview';
    element('review-note').textContent = pending.question.application === 'preview'
      ? 'Answer preview. Apply this answer on the Wooclap page; automatic interaction is not yet verified for this layout.'
      : 'This answer needs review. Answer on the page yourself, or skip this question.';
    const choices = element<HTMLUListElement>('answer-choices');
    const key = JSON.stringify([pending.fingerprint, pending.occurrence, pending.answer]);
    if (key !== draftKey) {
      draftKey = key;
      draftAnswer = JSON.parse(JSON.stringify(pending.answer)) as Answer;
      renderAnswerEditor(choices, pending.question, draftAnswer, updateApproval);
    }
    const actionable = state.phase === 'suggestion' || state.phase === 'review';
    element('suggestion-actions').hidden = !actionable;
    updateApproval();
    skipButton.disabled = busy;
  } else { draftKey = ''; draftAnswer = undefined; }
  const entry = state.log[0];
  element('last-log').textContent = entry
    ? `${new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${entry.message}`
    : 'No activity yet.';
}

async function send(message: Record<string, unknown>): Promise<void> {
  const sequence = ++requestSequence;
  const response = await chrome.runtime.sendMessage(message) as StateResponse;
  // A poll that started before an action must not undo its newer result.
  if (sequence < latestResponseSequence) return;
  latestResponseSequence = sequence;
  if (!response?.ok) throw new Error(response?.error || 'The extension did not respond. Reload it from Edge’s extensions page.');
  if (response.state && (response.settings || lastSettings)) render(response.state, response.settings || lastSettings!);
}

async function action(callback: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  if (lastState && lastSettings) render(lastState, lastSettings);
  errorMessage.hidden = true;
  try { await callback(); } catch (error) { showError(error); }
  finally {
    busy = false;
    if (lastState && lastSettings) render(lastState, lastSettings);
  }
}

startButton.addEventListener('click', () => void action(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('Open a Wooclap tab or the practice page first.');
  await send({ type: 'START', tabId: tab.id });
}));
pauseButton.addEventListener('click', () => void action(() => send({ type: 'PAUSE' })));
approveButton.addEventListener('click', () => void action(() => send({ type: 'APPROVE', answer: draftAnswer,
  fingerprint: lastState?.pending?.fingerprint, occurrence: lastState?.pending?.occurrence })));
skipButton.addEventListener('click', () => void action(() => send({ type: 'SKIP' })));
element('settings-button').addEventListener('click', () => void chrome.runtime.openOptionsPage().catch(showError));
element('practice-button').addEventListener('click', () => void chrome.tabs.create({ url: `${BRIDGE_URL}/practice` }).catch(showError));

async function refresh(): Promise<void> {
  if (polling || busy) return;
  polling = true;
  try { await send({ type: 'GET_STATE' }); } catch (error) { showError(error); }
  finally { polling = false; }
}
void refresh();
const timer = window.setInterval(() => void refresh(), 1000);
window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
