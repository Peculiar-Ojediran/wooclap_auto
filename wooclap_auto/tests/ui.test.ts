import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { DEFAULT_SETTINGS, INITIAL_SESSION, PROVIDER_MODELS, type Provider, type SessionState, type Settings } from '../src/shared/types';

type Message = { type: string; [key: string]: unknown };
const bundles = new Map<string, Promise<string>>();
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function loadUI(name: 'popup' | 'options', handler: (message: Message) => Promise<object>, hostedUrl = '') {
  const bundleKey = `${name}:${hostedUrl}`;
  if (!bundles.has(bundleKey)) {
    bundles.set(bundleKey, build({ entryPoints: [`src/ui/${name}.ts`], bundle: true, format: 'iife', write: false,
      define: { __HOSTED_FALLBACK_URL__: JSON.stringify(hostedUrl) } })
      .then(result => result.outputFiles[0].text));
  }
  const [html, source] = await Promise.all([readFile(`extension/${name}.html`, 'utf8'), bundles.get(bundleKey)!]);
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `https://extension.test/${name}.html` });
  let poll = () => {};
  const openedTabs: string[] = [];
  Object.defineProperty(dom.window, 'chrome', { value: {
    runtime: { sendMessage: handler, openOptionsPage: async () => {}, getURL: (path: string) => `chrome-extension://test-extension/${path}` },
    tabs: { query: async () => [{ id: 41 }], create: async ({ url }: { url: string }) => { openedTabs.push(url); return { id: 42 }; } }
  } });
  Object.defineProperty(dom.window, 'setInterval', { value: (callback: () => void) => { poll = callback; return 1; } });
  dom.window.eval(source);
  await flush();
  return {
    dom, openedTabs, poll: () => poll(),
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

test('connection health reports key configuration without claiming verified OpenAI access', async () => {
  const ui = await loadUI('options', async message => {
    if (message.type === 'CHECK_CONNECTION') return { ok: true, health: { ready: true, demo: false, provider: 'openai', model: 'gpt-example' } };
    return { ok: true, settings: { ...DEFAULT_SETTINGS, provider: 'openai', model: PROVIDER_MODELS.openai } };
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
    assert.equal(messages.at(-1)?.type, 'CHECK_CONNECTION');
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

function credentialHarness(provider: Provider = 'openai') {
  const credentials = {
    openai: { configured: false, storage: 'none' as 'none' | 'session' | 'local' },
    anthropic: { configured: false, storage: 'none' as 'none' | 'session' | 'local' },
    nvidia: { configured: false, storage: 'none' as 'none' | 'session' | 'local' }
  };
  const messages: Message[] = [];
  let settings = { ...DEFAULT_SETTINGS, provider, model: PROVIDER_MODELS[provider] };
  return {
    credentials, messages,
    handler: async (message: Message) => {
      messages.push(message);
      if (message.type === 'SAVE_SETTINGS') settings = message.settings as Settings;
      if (message.type === 'SAVE_API_KEY') credentials[message.provider as Provider] = {
        configured: true, storage: message.remember ? 'local' : 'session'
      };
      if (message.type === 'CLEAR_API_KEY') credentials[message.provider as Provider] = { configured: false, storage: 'none' };
      return { ok: true, settings, credentials };
    }
  };
}

test('API keys default to session-only and never enter ordinary settings or reappear in password fields', async () => {
  const harness = credentialHarness();
  const ui = await loadUI('options', harness.handler);
  try {
    const key = ui.element<HTMLInputElement>('api-key');
    assert.equal(key.type, 'password');
    assert.equal(key.autocomplete, 'off');
    assert.equal(ui.element<HTMLInputElement>('remember-api-key').checked, false);
    assert.equal(ui.element<HTMLButtonElement>('forget-api-key').disabled, true);
    key.value = 'session-test-secret';
    let confirms = 0;
    ui.dom.window.confirm = () => { confirms++; return true; };
    ui.element<HTMLButtonElement>('save-api-key').click();
    await flush();
    const saved = harness.messages.find(message => message.type === 'SAVE_API_KEY');
    assert.deepEqual(JSON.parse(JSON.stringify(saved)), { type: 'SAVE_API_KEY', provider: 'openai', apiKey: 'session-test-secret', remember: false, consent: false });
    assert.equal(confirms, 0);
    assert.equal(key.value, '');
    assert.equal(ui.element<HTMLButtonElement>('forget-api-key').disabled, false);
    assert.match(ui.element('credential-status').textContent!, /browser session only/);
    ui.element<HTMLButtonElement>('save-settings').click();
    await flush();
    const settings = harness.messages.find(message => message.type === 'SAVE_SETTINGS')!.settings;
    assert.doesNotMatch(JSON.stringify(settings), /session-test-secret|apiKey|remember/);
    assert.equal(ui.dom.window.document.body.textContent!.includes('session-test-secret'), false);
  } finally { ui.dom.window.close(); }
  const reopened = await loadUI('options', harness.handler);
  try {
    assert.equal(reopened.element<HTMLInputElement>('api-key').value, '');
    assert.equal(reopened.element<HTMLInputElement>('remember-api-key').checked, false);
    assert.match(reopened.element('credential-status').textContent!, /browser session only/);
  } finally { reopened.dom.window.close(); }
});

test('remembering a key requires explicit confirmation and forgetting clears its status', async () => {
  const harness = credentialHarness();
  const ui = await loadUI('options', harness.handler);
  try {
    ui.element<HTMLInputElement>('api-key').value = 'persistent-test-secret';
    ui.element<HTMLInputElement>('remember-api-key').checked = true;
    let prompt = '';
    ui.dom.window.confirm = message => { prompt = message!; return false; };
    ui.element<HTMLButtonElement>('save-api-key').click();
    await flush();
    assert.match(prompt, /without encryption/);
    assert.match(prompt, /after Edge exits/);
    assert.equal(harness.messages.some(message => message.type === 'SAVE_API_KEY'), false);
    assert.match(ui.element('credential-action-status').textContent!, /not saved/);
    assert.equal(ui.element<HTMLInputElement>('api-key').value, 'persistent-test-secret');

    ui.dom.window.confirm = () => true;
    ui.element<HTMLButtonElement>('save-api-key').click();
    await flush();
    const saved = harness.messages.find(message => message.type === 'SAVE_API_KEY')!;
    assert.equal(saved.remember, true);
    assert.equal(saved.consent, true);
    assert.match(ui.element('credential-status').textContent!, /remembered on this device/);
    assert.equal(ui.element<HTMLInputElement>('api-key').value, '');
    assert.equal(ui.element<HTMLInputElement>('remember-api-key').checked, false);
    ui.element<HTMLButtonElement>('forget-api-key').click();
    await flush();
    assert.equal(harness.messages.at(-1)!.type, 'CLEAR_API_KEY');
    assert.equal(harness.messages.at(-1)!.provider, 'openai');
    assert.match(ui.element('credential-status').textContent!, /No OpenAI key saved/);
    assert.equal(ui.element<HTMLButtonElement>('forget-api-key').disabled, true);
    assert.equal(ui.dom.window.document.body.textContent!.includes('persistent-test-secret'), false);
  } finally { ui.dom.window.close(); }
});

test('saving a session key replaces a remembered key without requesting persistent consent again', async () => {
  const harness = credentialHarness();
  harness.credentials.openai = { configured: true, storage: 'local' };
  const ui = await loadUI('options', harness.handler);
  try {
    assert.match(ui.element('credential-status').textContent!, /remembered/);
    assert.equal(ui.element<HTMLInputElement>('remember-api-key').checked, false);
    ui.dom.window.confirm = () => { throw new Error('Session saves must not prompt to remember'); };
    ui.element<HTMLInputElement>('api-key').value = 'replacement-session-key';
    ui.element<HTMLButtonElement>('save-api-key').click();
    await flush();
    assert.equal(harness.credentials.openai.storage, 'session');
    assert.match(ui.element('credential-action-status').textContent!, /previously remembered copy was removed/);
  } finally { ui.dom.window.close(); }
});

test('switching providers selects the correct model and clears an unsaved key and consent', async () => {
  const harness = credentialHarness();
  harness.credentials.anthropic = { configured: true, storage: 'session' };
  const ui = await loadUI('options', harness.handler);
  try {
    const provider = ui.element<HTMLSelectElement>('provider');
    ui.element<HTMLInputElement>('model').value = 'gpt-custom';
    ui.element<HTMLInputElement>('api-key').value = 'never-transfer-this-key';
    ui.element<HTMLInputElement>('remember-api-key').checked = true;
    provider.value = 'anthropic';
    provider.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    assert.equal(ui.element<HTMLInputElement>('model').value, PROVIDER_MODELS.anthropic);
    assert.match(ui.element('credential-status').textContent!, /Claude.*browser session only/);
    assert.equal(ui.element<HTMLInputElement>('api-key').value, '');
    assert.equal(ui.element<HTMLInputElement>('remember-api-key').checked, false);
    ui.element<HTMLInputElement>('api-key').value = 'claude-session-secret';
    ui.element<HTMLButtonElement>('save-api-key').click();
    await flush();
    assert.equal(harness.messages.at(-1)!.provider, 'anthropic');
    ui.element<HTMLInputElement>('model').value = 'claude-custom';
    ui.element<HTMLButtonElement>('save-settings').click();
    await flush();
    const saved = harness.messages.at(-1)!.settings as Settings;
    assert.equal(saved.provider, 'anthropic');
    assert.equal(saved.model, 'claude-custom');
    provider.value = 'openai';
    provider.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    assert.equal(ui.element<HTMLInputElement>('model').value, 'gpt-custom');
    provider.value = 'anthropic';
    provider.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    assert.equal(ui.element<HTMLInputElement>('model').value, 'claude-custom');
    assert.equal(harness.messages.some(message => JSON.stringify(message).includes('never-transfer-this-key')), false);
  } finally { ui.dom.window.close(); }
});

test('Claude responses and selected-provider connection status are attributed accurately', async () => {
  const settings = { ...DEFAULT_SETTINGS, provider: 'anthropic' as const, model: PROVIDER_MODELS.anthropic };
  const popup = await loadUI('popup', async () => ({ ok: true, settings, state: {
    ...INITIAL_SESSION, bridgeMode: 'anthropic', lastResponse: {
      provider: 'anthropic', model: 'claude-test-model', demo: false, elapsedMs: 250, usage: { inputTokens: 100, outputTokens: 20 }
    }
  } }));
  try {
    assert.match(popup.element('bridge-mode').textContent!, /Claude.*via local bridge/);
    assert.match(popup.element('response-source').textContent!, /Claude.*response received/);
  } finally { popup.dom.window.close(); }
  const options = await loadUI('options', async message => message.type === 'CHECK_CONNECTION'
    ? { ok: true, health: { ready: true, demo: false, model: settings.model, provider: 'anthropic' } }
    : { ok: true, settings });
  try {
    options.element<HTMLButtonElement>('check-bridge').click();
    await flush();
    assert.match(options.element('bridge-status').textContent!, /Claude.*checked when answering/);
    assert.doesNotMatch(options.element('bridge-status').textContent!, /OpenAI|verified/i);
  } finally { options.dom.window.close(); }
});

test('automatic connection defaults to NVIDIA and reports an unavailable shared service honestly', async () => {
  const { connectionMode: _connectionMode, ...legacySettings } = DEFAULT_SETTINGS;
  const messages: Message[] = [];
  const ui = await loadUI('options', async message => {
    messages.push(message);
    if (message.type === 'CHECK_CONNECTION') return { ok: true, health: { ready: false, demo: false, model: legacySettings.model,
      provider: 'nvidia', connectionMode: 'hosted', detail: 'Shared NVIDIA service is not configured. Save your own API key.' } };
    return { ok: true, settings: message.type === 'SAVE_SETTINGS' ? message.settings : legacySettings };
  });
  try {
    assert.equal(ui.element<HTMLSelectElement>('connection-mode').value, 'direct');
    assert.equal(ui.element<HTMLSelectElement>('provider').value, 'nvidia');
    assert.equal(ui.element<HTMLInputElement>('model').value, 'deepseek-ai/deepseek-v4.1-flash');
    assert.equal(ui.element('bridge-settings').hidden, true);
    assert.equal(ui.element<HTMLInputElement>('bridge-token').disabled, true);
    assert.match(ui.element('connection-help').textContent!, /directly to your selected provider/);
    assert.doesNotMatch(ui.element('credential-status').textContent!, /bridge/);
    assert.match(ui.element('hosted-fallback-help').textContent!, /unavailable in this build/);
    assert.equal(ui.element<HTMLAnchorElement>('practice-link').href, 'chrome-extension://test-extension/practice.html');
    ui.element<HTMLButtonElement>('check-bridge').click();
    await flush();
    const saved = messages.find(message => message.type === 'SAVE_SETTINGS')!.settings as Settings;
    assert.equal(saved.connectionMode, 'direct');
    assert.equal(saved.bridgeToken, '');
    assert.equal(messages.at(-1)!.type, 'CHECK_CONNECTION');
    assert.match(ui.element('bridge-status').textContent!, /Shared NVIDIA service is not configured.*Save your own API key/);
    assert.doesNotMatch(ui.element('bridge-status').textContent!, /bridge|Connected|verified/i);
    assert.equal(ui.element('bridge-status').dataset.state, 'pending');
  } finally { ui.dom.window.close(); }
});

test('connection choices persist and demo mode permits key management without requiring an AI connection', async () => {
  const harness = credentialHarness();
  const ui = await loadUI('options', async message => message.type === 'CHECK_CONNECTION'
    ? { ok: true, health: { ready: true, demo: true, model: 'local-demo', connectionMode: 'demo' } }
    : harness.handler(message));
  try {
    const connection = ui.element<HTMLSelectElement>('connection-mode');
    connection.value = 'bridge';
    connection.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    assert.equal(ui.element('bridge-settings').hidden, false);
    assert.equal(ui.element<HTMLInputElement>('bridge-token').disabled, false);
    assert.match(ui.element('api-key-help').textContent!, /paired local bridge/);
    assert.equal(ui.element<HTMLAnchorElement>('practice-link').href, 'http://127.0.0.1:4318/practice');
    ui.element<HTMLInputElement>('bridge-token').value = 'local-test-token';
    ui.element<HTMLButtonElement>('save-settings').click();
    await flush();
    assert.equal((harness.messages.at(-1)!.settings as Settings).connectionMode, 'bridge');

    connection.value = 'demo';
    connection.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    assert.equal(ui.element('bridge-settings').hidden, true);
    assert.equal(ui.element<HTMLInputElement>('model').required, false);
    assert.match(ui.element('connection-help').textContent!, /without an API key/);
    ui.element<HTMLInputElement>('api-key').value = 'future-session-secret';
    ui.element<HTMLButtonElement>('save-api-key').click();
    await flush();
    assert.equal(harness.credentials.openai.storage, 'session');
    ui.element<HTMLButtonElement>('check-bridge').click();
    await flush();
    assert.equal((harness.messages.at(-1)!.settings as Settings).connectionMode, 'demo');
    assert.match(ui.element('bridge-status').textContent!, /No API key needed/);
    assert.equal(ui.element('bridge-status').dataset.state, 'success');
    assert.equal(ui.element<HTMLInputElement>('bridge-token').value, 'local-test-token');
  } finally { ui.dom.window.close(); }
  const reopened = await loadUI('options', harness.handler);
  try {
    assert.equal(reopened.element<HTMLSelectElement>('connection-mode').value, 'demo');
    assert.equal(reopened.element('bridge-settings').hidden, true);
    assert.match(reopened.element('credential-status').textContent!, /browser session only/);
  } finally { reopened.dom.window.close(); }
});

test('popup attributes direct provider responses and opens the bundled practice page without a bridge', async () => {
  let settings: Settings = { ...DEFAULT_SETTINGS, connectionMode: 'direct', provider: 'anthropic' };
  const state: SessionState = { ...INITIAL_SESSION, bridgeMode: 'anthropic', connectionMode: 'direct', lastResponse: {
    provider: 'anthropic', connectionMode: 'direct', model: 'claude-test', demo: false, elapsedMs: 1, usage: null
  } };
  const ui = await loadUI('popup', async () => ({ ok: true, settings, state }));
  try {
    assert.match(ui.element('bridge-mode').textContent!, /Claude.*direct API/);
    assert.doesNotMatch(ui.element('bridge-mode').textContent!, /bridge/);
    assert.match(ui.element('response-source').textContent!, /Claude.*direct/);
    assert.equal(ui.element('connection-label').textContent, 'Automatic / own API key');
    ui.element<HTMLButtonElement>('practice-button').click();
    await flush();
    assert.equal(ui.openedTabs.at(-1), 'chrome-extension://test-extension/practice.html');
    settings = { ...settings, connectionMode: 'bridge' };
    ui.poll(); await flush();
    assert.equal(ui.element('connection-label').textContent, 'Local bridge · 4318');
    ui.element<HTMLButtonElement>('practice-button').click();
    await flush();
    assert.equal(ui.openedTabs.at(-1), 'http://127.0.0.1:4318/practice');
    assert.match(ui.element('bridge-mode').textContent!, /direct API/, 'session attribution must retain the transport that produced the answer');
  } finally { ui.dom.window.close(); }
});

test('NVIDIA keys use session storage by default and model switching never transfers credentials', async () => {
  const harness = credentialHarness('nvidia');
  const ui = await loadUI('options', harness.handler);
  try {
    assert.match(ui.element('api-key-label').textContent!, /NVIDIA/);
    assert.equal(ui.element<HTMLInputElement>('model').value, PROVIDER_MODELS.nvidia);
    assert.equal(ui.element<HTMLInputElement>('remember-api-key').checked, false);
    ui.dom.window.confirm = () => { throw new Error('Session keys must not prompt for storage consent'); };
    ui.element<HTMLInputElement>('api-key').value = 'nvidia-test-key';
    ui.element<HTMLButtonElement>('save-api-key').click();
    await flush();
    const saved = harness.messages.find(message => message.type === 'SAVE_API_KEY')!;
    assert.equal(saved.provider, 'nvidia');
    assert.equal(saved.remember, false);
    assert.equal(saved.consent, false);
    assert.equal(harness.credentials.nvidia.storage, 'session');
    assert.match(ui.element('credential-status').textContent!, /NVIDIA.*browser session only/);
    assert.equal(ui.element<HTMLInputElement>('api-key').value, '');

    const provider = ui.element<HTMLSelectElement>('provider');
    ui.element<HTMLInputElement>('api-key').value = 'unsaved-nvidia-key';
    ui.element<HTMLInputElement>('remember-api-key').checked = true;
    provider.value = 'openai';
    provider.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    assert.equal(ui.element<HTMLInputElement>('api-key').value, '');
    assert.equal(ui.element<HTMLInputElement>('remember-api-key').checked, false);
    assert.equal(ui.element<HTMLInputElement>('model').value, PROVIDER_MODELS.openai);
    assert.match(ui.element('credential-status').textContent!, /No OpenAI key/);
    provider.value = 'nvidia';
    provider.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    assert.equal(ui.element<HTMLInputElement>('model').value, PROVIDER_MODELS.nvidia);
    assert.equal(ui.element<HTMLButtonElement>('forget-api-key').disabled, false);
    ui.element<HTMLButtonElement>('forget-api-key').click();
    await flush();
    assert.equal(harness.messages.at(-1)!.provider, 'nvidia');
    assert.equal(harness.credentials.nvidia.configured, false);
    assert.equal(harness.messages.some(message => JSON.stringify(message).includes('unsaved-nvidia-key')), false);
  } finally { ui.dom.window.close(); }
});

test('shared fallback disclosure and health identify NVIDIA even when another provider has no key', async () => {
  const harness = credentialHarness('anthropic');
  let ready = true;
  const ui = await loadUI('options', async message => message.type === 'CHECK_CONNECTION'
    ? { ok: true, health: { ready, demo: false, provider: 'nvidia', model: PROVIDER_MODELS.nvidia,
      connectionMode: 'hosted', detail: ready ? undefined : 'Shared NVIDIA service has reached its request limit.' } }
    : harness.handler(message), 'https://fallback.example.com');
  try {
    assert.equal(ui.element<HTMLSelectElement>('provider').value, 'anthropic');
    assert.match(ui.element('credential-status').textContent!, /No Claude.*shared NVIDIA DeepSeek service will be used/);
    assert.match(ui.element('hosted-fallback-help').textContent!, /questions and included screenshots.*hosted service to NVIDIA/);
    assert.match(ui.element('hosted-fallback-help').textContent!, /personal keys are never sent/);
    ui.element<HTMLButtonElement>('check-bridge').click();
    await flush();
    assert.match(ui.element('bridge-status').textContent!, /Shared NVIDIA service available.*deepseek-ai\/deepseek-v4\.1-flash/);
    assert.match(ui.element('bridge-status').textContent!, /No personal API key needed/);
    assert.doesNotMatch(ui.element('bridge-status').textContent!, /Claude|API key configured|verified/);
    assert.equal(ui.element('bridge-status').dataset.state, 'success');
    ready = false;
    ui.element<HTMLButtonElement>('check-bridge').click();
    await flush();
    assert.equal(ui.element('bridge-status').textContent, 'Shared NVIDIA service has reached its request limit.');
    assert.equal(ui.element('bridge-status').dataset.state, 'pending');
  } finally { ui.dom.window.close(); }
});

test('popup attributes shared responses to NVIDIA and preserves their transport after changing providers', async () => {
  let settings: Settings = { ...DEFAULT_SETTINGS, provider: 'anthropic', model: PROVIDER_MODELS.anthropic };
  let state: SessionState = { ...INITIAL_SESSION, running: true, bridgeMode: 'nvidia', connectionMode: 'hosted', lastResponse: {
    provider: 'nvidia', connectionMode: 'hosted', model: PROVIDER_MODELS.nvidia, demo: false, elapsedMs: 10, usage: null
  } };
  const ui = await loadUI('popup', async () => ({ ok: true, settings, state }));
  try {
    assert.match(ui.element('bridge-mode').textContent!, /NVIDIA.*via shared service/);
    assert.match(ui.element('response-source').textContent!, /NVIDIA.*response received.*shared service/);
    assert.doesNotMatch(ui.element('response-source').textContent!, /Claude|direct/);
    assert.equal(ui.element('connection-label').textContent, 'Shared NVIDIA service');
    assert.equal(ui.element('response-model').textContent, PROVIDER_MODELS.nvidia);
    settings = { ...settings, provider: 'openai', model: PROVIDER_MODELS.openai };
    state = { ...state, running: false, phase: 'paused' };
    ui.poll();
    await flush();
    assert.equal(ui.element('connection-label').textContent, 'Automatic / own API key');
    assert.match(ui.element('response-source').textContent!, /NVIDIA.*shared service/);
    assert.match(ui.element('bridge-mode').textContent!, /NVIDIA.*shared service/);
  } finally { ui.dom.window.close(); }
});
