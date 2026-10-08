import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { DEFAULT_SETTINGS, INITIAL_SESSION, type SessionState, type Settings } from '../src/shared/types';

type Message = { type: string; [key: string]: unknown };
const bundles = new Map<string, Promise<string>>();
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function loadUI(name: 'popup' | 'options', handler: (message: Message) => Promise<object>) {
  if (!bundles.has(name)) {
    bundles.set(name, build({ entryPoints: [`src/ui/${name}.ts`], bundle: true, format: 'iife', write: false })
      .then(result => result.outputFiles[0].text));
  }
  const [html, source] = await Promise.all([readFile(`extension/${name}.html`, 'utf8'), bundles.get(name)!]);
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `https://extension.test/${name}.html` });
  let poll = () => {};
  Object.defineProperty(dom.window, 'chrome', { value: {
    runtime: { sendMessage: handler, openOptionsPage: async () => {} },
    tabs: { query: async () => [{ id: 41 }], create: async () => ({ id: 42 }) }
  } });
  Object.defineProperty(dom.window, 'setInterval', { value: (callback: () => void) => { poll = callback; return 1; } });
  dom.window.eval(source);
  await flush();
  return {
    dom, poll: () => poll(),
    element: <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T
  };
}

test('popup distinguishes actual OpenAI responses from demo and retains review explanations without enabling approval', async () => {
  let state: SessionState = { ...INITIAL_SESSION, log: [] };
  const commands: string[] = [];
  const ui = await loadUI('popup', async message => {
    commands.push(message.type);
    return { ok: true, state, settings: DEFAULT_SETTINGS };
  });
  try {
    assert.equal(ui.element('bridge-mode').hidden, true);
    assert.equal(ui.element('response-metadata').hidden, true);
    state = {
      ...state, running: true, phase: 'review', bridgeMode: 'openai',
      pending: {
        question: { source: 'practice', eventKey: 'test', questionId: 'q1', text: 'Read this diagram.',
          choices: [{ id: 'a', text: 'Choice A' }, { id: 'b', text: 'Choice B' }], multiple: false, imageKeys: [] },
        answer: { selectedChoiceIds: ['a'], explanation: '<img src=x onerror=alert(1)> The diagram is unclear.', needsReview: true },
        fingerprint: 'test', occurrence: 1, demo: false
      },
      lastResponse: { model: 'gpt-example', elapsedMs: 1420, usage: { inputTokens: 712, outputTokens: 44 }, demo: false }
    };
    ui.poll();
    await flush();
    assert.equal(ui.element('bridge-mode').textContent, 'Session source: OpenAI via local bridge');
    assert.equal(ui.element('response-source').textContent, 'OpenAI response received');
    assert.equal(ui.element('response-model').textContent, 'gpt-example');
    assert.equal(ui.element('response-latency').textContent, '1.4 s response time');
    assert.equal(ui.element('response-tokens').textContent, '712 input / 44 output tokens');
    assert.match(ui.element('answer-explanation').textContent!, /The diagram is unclear/);
    assert.equal(ui.element('answer-explanation').querySelector('img'), null);
    assert.equal(ui.element<HTMLButtonElement>('approve-button').disabled, true);
    assert.equal(ui.element<HTMLButtonElement>('skip-button').disabled, false);
    ui.element<HTMLButtonElement>('approve-button').click();
    assert.equal(commands.includes('APPROVE'), false);
    ui.element<HTMLButtonElement>('skip-button').click();
    await flush();
    assert.equal(commands.at(-1), 'SKIP');

    state = { ...state, pending: null, phase: 'waiting', bridgeMode: 'demo',
      lastResponse: { model: 'local-demo', elapsedMs: 12, usage: null, demo: true } };
    ui.poll();
    await flush();
    assert.match(ui.element('bridge-mode').textContent!, /local demo/);
    assert.equal(ui.element('response-source').textContent, 'Local demo');
    assert.equal(ui.element('response-tokens').textContent, 'No API tokens used');
  } finally { ui.dom.window.close(); }
});

test('a delayed status poll cannot replace the result of pausing a session', async () => {
  const active: SessionState = { ...INITIAL_SESSION, running: true, phase: 'waiting', log: [] };
  const paused: SessionState = { ...active, running: false, phase: 'paused', detail: 'Session paused.' };
  let reads = 0;
  let finishOldPoll: (value: object) => void = () => { throw new Error('No pending poll'); };
  const ui = await loadUI('popup', async message => {
    if (message.type === 'PAUSE') return { ok: true, state: paused, settings: DEFAULT_SETTINGS };
    if (++reads === 1) return { ok: true, state: active, settings: DEFAULT_SETTINGS };
    return new Promise(resolve => { finishOldPoll = resolve; });
  });
  try {
    ui.poll();
    await flush();
    ui.element<HTMLButtonElement>('pause-button').click();
    await flush();
    assert.equal(ui.element('phase').dataset.phase, 'paused');
    finishOldPoll({ ok: true, state: active, settings: DEFAULT_SETTINGS });
    await flush();
    assert.equal(ui.element('phase').dataset.phase, 'paused');
    assert.equal(ui.element<HTMLButtonElement>('pause-button').disabled, true);
    assert.equal(ui.element<HTMLButtonElement>('start-button').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('bridge health reports key configuration without claiming verified OpenAI access', async () => {
  const ui = await loadUI('options', async message => {
    if (message.type === 'CHECK_BRIDGE') return { ok: true, health: { ready: true, demo: false, model: 'gpt-example' } };
    return { ok: true, settings: DEFAULT_SETTINGS };
  });
  try {
    ui.element<HTMLButtonElement>('check-bridge').click();
    await flush();
    assert.match(ui.element('bridge-status').textContent!, /API key configured/);
    assert.match(ui.element('bridge-status').textContent!, /checked when answering/);
    assert.doesNotMatch(ui.element('bridge-status').textContent!, /AI ready|verified/i);
  } finally { ui.dom.window.close(); }
});

test('background settings migrate unchecked, persist explicit changes, and survive reopening options', async () => {
  const { backgroundMode: _backgroundMode, ...legacy } = DEFAULT_SETTINGS;
  let stored: Partial<Settings> = { ...legacy, selectors: { ...legacy.selectors } };
  const messages: Message[] = [];
  const handler = async (message: Message) => {
    messages.push(message);
    if (message.type === 'SAVE_SETTINGS') stored = message.settings as Settings;
    return { ok: true, settings: stored };
  };
  const initial = await loadUI('options', handler);
  try {
    const input = initial.element<HTMLInputElement>('background-mode');
    assert.equal(input.checked, false);
    input.checked = true;
    input.dispatchEvent(new initial.dom.window.Event('input', { bubbles: true }));
    assert.equal(initial.element('save-status').dataset.state, 'unsaved');
    initial.element<HTMLButtonElement>('save-settings').click();
    await flush();
    assert.equal(stored.backgroundMode, true);
    assert.equal(initial.element('save-status').dataset.state, 'success');
    assert.equal(stored.captureImages, true);
  } finally { initial.dom.window.close(); }

  const reopened = await loadUI('options', handler);
  try {
    const input = reopened.element<HTMLInputElement>('background-mode');
    assert.equal(input.checked, true);
    assert.match(reopened.element('background-help').textContent!, /debugging banner/);
    input.checked = false;
    reopened.element<HTMLButtonElement>('check-bridge').click();
    await flush();
    assert.equal(stored.backgroundMode, false);
    assert.equal(messages.at(-2)?.type, 'SAVE_SETTINGS');
    assert.equal(messages.at(-1)?.type, 'CHECK_BRIDGE');
  } finally { reopened.dom.window.close(); }
});

test('options report a rejected background setting without claiming that it was saved', async () => {
  const ui = await loadUI('options', async message => message.type === 'SAVE_SETTINGS'
    ? { ok: false, error: 'Reload the extension to grant the debugger permission.' }
    : { ok: true, settings: DEFAULT_SETTINGS });
  try {
    const input = ui.element<HTMLInputElement>('background-mode');
    input.checked = true;
    input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.element<HTMLButtonElement>('save-settings').click();
    await flush();
    assert.equal(ui.element('error-message').hidden, false);
    assert.match(ui.element('error-message').textContent!, /debugger permission/);
    assert.equal(ui.element('save-status').dataset.state, 'unsaved');
    assert.equal(ui.element<HTMLButtonElement>('save-settings').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('popup identifies background mode and directs approval to the monitored session', async () => {
  let settings = { ...DEFAULT_SETTINGS, backgroundMode: true };
  const ui = await loadUI('popup', async () => ({ ok: true, state: INITIAL_SESSION, settings }));
  try {
    assert.match(ui.element('mode').textContent!, /Suggestion mode.*Background/);
    assert.match(ui.element('approve-button').title, /monitored session tab/);
    settings = { ...settings, backgroundMode: false };
    ui.poll();
    await flush();
    assert.equal(ui.element('mode').textContent, 'Suggestion mode');
  } finally { ui.dom.window.close(); }
});

test('numeric answer edits survive popup polls and invalid values cannot be approved', async () => {
  const state: SessionState = { ...INITIAL_SESSION, running: true, phase: 'suggestion', log: [], pending: {
    question: { kind: 'numeric', source: 'wooclap', eventKey: 'event', questionId: null, text: 'A number between 0 and 100?',
      choices: [], multiple: false, imageKeys: [], constraints: { min: 0, max: 100 }, application: 'automatic' },
    answer: { selectedChoiceIds: [], value: '42', explanation: 'A test response.', needsReview: false },
    fingerprint: 'numeric-question', occurrence: 1, demo: false
  } };
  const messages: Message[] = [];
  const ui = await loadUI('popup', async message => { messages.push(message); return { ok: true, state, settings: DEFAULT_SETTINGS }; });
  try {
    const input = ui.element('answer-choices').querySelector('textarea')!;
    assert.equal(input.value, '42');
    input.value = '101'; input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    assert.equal(ui.element<HTMLButtonElement>('approve-button').disabled, true);
    input.value = '56'; input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.poll(); await flush();
    assert.equal(ui.element('answer-choices').querySelector('textarea')!.value, '56');
    assert.equal(ui.element<HTMLButtonElement>('approve-button').disabled, false);
    ui.element<HTMLButtonElement>('approve-button').click(); await flush();
    const sent = messages.find(message => message.type === 'APPROVE')!;
    assert.equal((sent.answer as { value: string }).value, '56');
    assert.equal(sent.fingerprint, 'numeric-question');
  } finally { ui.dom.window.close(); }
});

test('image point previews show coordinates and never enable automatic application', async () => {
  const state: SessionState = { ...INITIAL_SESSION, running: true, phase: 'suggestion', log: [], pending: {
    question: { kind: 'point', source: 'wooclap', eventKey: 'event', questionId: null, text: 'Locate the item.',
      choices: [{ id: 'point-1', text: 'Target point' }], multiple: false, imageKeys: ['diagram'], application: 'preview' },
    answer: { selectedChoiceIds: [], points: [{ id: 'point-1', x: 0.25, y: 0.75 }], explanation: 'A test response.', needsReview: false },
    fingerprint: 'image-question', occurrence: 1, demo: false
  } };
  const ui = await loadUI('popup', async () => ({ ok: true, state, settings: DEFAULT_SETTINGS }));
  try {
    assert.match(ui.element('answer-choices').textContent!, /25.0% from left, 75.0% from top/);
    assert.match(ui.element('review-note').textContent!, /preview/);
    assert.equal(ui.element<HTMLButtonElement>('approve-button').disabled, true);
  } finally { ui.dom.window.close(); }
});
