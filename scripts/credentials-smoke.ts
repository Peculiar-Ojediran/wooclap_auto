import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { createBridgeServer } from '../server/http';
import { demoSolver } from '../server/solver';
import { PROVIDER_MODELS, type CredentialStatuses, type Provider, type SessionState, type Settings } from '../src/shared/types';

// Synthetic credentials only: the injected factory never contacts an AI service.
// Run after `npm run build`, with port 4318 free. Uses a disposable Edge profile.
const token = randomBytes(32).toString('hex');
const fake = (label: string) => `test-only-${label}-${randomBytes(12).toString('hex')}`;
const openaiKey = fake('openai-session');
const anthropicKey = fake('anthropic-session');
const rememberedKey = fake('anthropic-remembered');
const replacementKey = fake('anthropic-session-replacement');
const unauthorizedKey = fake('unauthorized');
const allKeys = [openaiKey, anthropicKey, rememberedKey, replacementKey, unauthorizedKey];
const requests: { provider: Provider; apiKey: string; model: string }[] = [];
const results: { name: string; passed: true }[] = [];
const profile = await mkdtemp(join(tmpdir(), 'wooclap-credentials-test-'));
let context: BrowserContext | undefined;
let options: Page;
let extensionId = '';
const errors: string[] = [];
const bridge = createBridgeServer({ token, rateLimit: 100, solverFactory: (provider, apiKey) => async (request, signal) => {
  requests.push({ provider, apiKey, model: request.model });
  assert.equal(Object.hasOwn(request, 'apiKey'), false, 'The solver question must not contain the bridge credential.');
  const response = await demoSolver(request, signal);
  return { ...response, provider, model: request.model, demo: false };
} });

interface StateReply {
  ok: boolean;
  error?: string;
  settings: Settings;
  state: SessionState;
  credentials: CredentialStatuses;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function eventually<T>(read: () => Promise<T>, pass: (value: T) => boolean, label: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (pass(value)) return value;
    await sleep(100);
  }
  // Do not stringify arbitrary state or storage on failure, even in a test.
  throw new Error(`Timed out: ${label}`);
}
function passed(name: string): void {
  results.push({ name, passed: true });
  console.log(`PASS: ${name}`);
}
async function command(message: object): Promise<StateReply> {
  const reply = await options.evaluate(message => chrome.runtime.sendMessage(message), message);
  assert.equal(reply.ok, true, reply.error);
  return reply;
}
const getState = () => command({ type: 'GET_STATE' });
async function storageContains(area: 'local' | 'session', key: string): Promise<boolean> {
  return options.evaluate(async ({ area, key }) => JSON.stringify(await chrome.storage[area].get(null)).includes(key), { area, key });
}
async function assertLocation(provider: Provider, key: string, location: 'session' | 'local' | 'none'): Promise<void> {
  const reply = await getState();
  assert.deepEqual(reply.credentials[provider], { configured: location !== 'none', storage: location });
  assert.equal(await storageContains('local', key), location === 'local', 'Persistent storage must match consent.');
  assert.equal(await storageContains('session', key), location === 'session', 'Session storage must match the selected lifetime.');
  const serialized = JSON.stringify(reply);
  assert.equal(allKeys.some(secret => serialized.includes(secret)), false, 'GET_STATE must expose only credential metadata.');
}
async function chooseProvider(provider: Provider): Promise<void> {
  await options.locator('#provider').selectOption(provider);
  await options.locator('#save-settings').click();
  await eventually(getState, reply => reply.settings.provider === provider, 'selected provider saved');
}
async function saveKey(apiKey: string, remember = false, accept = false): Promise<void> {
  await options.locator('#api-key').fill(apiKey);
  await options.locator('#remember-api-key').setChecked(remember);
  if (remember) options.once('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
  await options.locator('#save-api-key').click();
  if (!remember || accept) {
    await eventually(() => options.locator('#api-key').inputValue(), value => value === '', 'key input cleared after save');
    assert.equal(await options.locator('#remember-api-key').isChecked(), false, 'Consent must not silently carry to another save.');
  }
}
async function launch(): Promise<void> {
  const extension = resolve('dist/edge');
  context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true,
    viewport: { width: 1280, height: 1100 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await eventually(() => options.locator('#save-settings').isEnabled(), enabled => enabled, 'settings initialized');
}

try {
  await new Promise<void>((done, reject) => { bridge.once('error', reject); bridge.listen(4318, '127.0.0.1', done); });
  await launch();
  assert.deepEqual((await getState()).credentials, {
    openai: { configured: false, storage: 'none' }, anthropic: { configured: false, storage: 'none' }, nvidia: { configured: false, storage: 'none' }
  });
  assert.equal(await options!.locator('#remember-api-key').isChecked(), false);
  assert.equal(await options!.locator('#api-key').inputValue(), '');
  await chooseProvider('openai');
  await options!.locator('#connection-mode').selectOption('bridge');
  await options!.locator('#bridge-token').fill(token);
  await options!.locator('#check-bridge').click();
  await eventually(() => options!.locator('#bridge-status').textContent(), value => Boolean(value && /API key|Bridge connected/.test(value)), 'authenticated bridge check');

  const denied = await options!.evaluate(apiKey => chrome.runtime.sendMessage({
    type: 'SAVE_API_KEY', provider: 'openai', apiKey, remember: true, consent: false
  }), unauthorizedKey);
  assert.equal(denied.ok, false, 'The background must enforce consent independently of the checkbox.');
  await assertLocation('openai', unauthorizedKey, 'none');
  passed('Remembering a key requires explicit consent in the background handler');

  await saveKey(openaiKey);
  await assertLocation('openai', openaiKey, 'session');
  await options!.reload();
  await eventually(() => options!.locator('#save-settings').isEnabled(), value => value, 'settings reload');
  assert.equal(await options!.locator('#api-key').inputValue(), '', 'Stored keys must never repopulate the password input.');
  await assertLocation('openai', openaiKey, 'session');
  passed('API keys default to session storage and remain hidden on settings reload');

  await chooseProvider('anthropic');
  await saveKey(anthropicKey);
  await assertLocation('anthropic', anthropicKey, 'session');
  await assertLocation('openai', openaiKey, 'session');
  passed('OpenAI and Claude keep separate credentials and expose only metadata');

  const practice = await context!.newPage();
  await practice.goto('http://127.0.0.1:4318/practice');
  const tabId = await options!.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:4318/practice' }))[0].id!);
  for (const provider of ['openai', 'anthropic'] as const) {
    const { settings } = await getState();
    await command({ type: 'SAVE_SETTINGS', settings: { ...settings, provider, model: PROVIDER_MODELS[provider], mode: 'suggest' } });
    await practice.bringToFront();
    await command({ type: 'START', tabId });
    await eventually(getState, reply => reply.state.phase === 'suggestion', `${provider} answer`);
    assert.equal((await getState()).state.bridgeMode, provider);
    assert.equal(requests.at(-1)?.provider, provider);
    assert.equal(requests.at(-1)?.apiKey === (provider === 'openai' ? openaiKey : anthropicKey), true, 'Provider routing must select the matching key.');
    assert.equal(requests.at(-1)?.model, PROVIDER_MODELS[provider]);
    await command({ type: 'PAUSE' });
  }
  assert.equal(requests.length, 2, 'Changing providers must not restore an answer from the other provider.');
  assert.equal(await practice.locator('#submission-count').textContent(), '0');
  passed('Both providers route their own session key through the authenticated bridge');

  // Keep this nested browser function as JavaScript source so tsx's function-name
  // helpers do not leak into the separately serialized executeScript function.
  const isolation = await options!.evaluate(`(async () => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: async (apiKey) => {
      const save = await chrome.runtime.sendMessage({ type: 'SAVE_API_KEY', provider: 'anthropic', apiKey, remember: true, consent: true });
      const clear = await chrome.runtime.sendMessage({ type: 'CLEAR_API_KEY', provider: 'openai' });
      const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      const readable = [];
      for (const area of ['local', 'session']) {
        try { await chrome.storage[area].get(null); readable.push(area); } catch { /* Restricted to trusted extension contexts. */ }
      }
      return { save, clear, state, readable };
    }, args: ${JSON.stringify([unauthorizedKey])} });
    return result.result;
  })()`) as { readable: string[]; state?: Record<string, unknown> } | undefined;
  assert.ok(isolation);
  assert.deepEqual(isolation.readable, [], 'Content scripts must not read either credential storage area.');
  assert.equal(Object.hasOwn(isolation.state ?? {}, 'credentials'), false);
  assert.equal(Object.hasOwn(isolation.state ?? {}, 'settings'), false);
  await assertLocation('anthropic', anthropicKey, 'session');
  await assertLocation('openai', openaiKey, 'session');
  assert.equal(await storageContains('local', unauthorizedKey), false);
  assert.equal(await storageContains('session', unauthorizedKey), false);
  passed('Page content scripts cannot read, replace, or forget provider credentials');

  await options!.bringToFront();
  await chooseProvider('anthropic');
  await saveKey(rememberedKey, true, false);
  await assertLocation('anthropic', anthropicKey, 'session');
  assert.equal(await storageContains('local', rememberedKey), false);
  assert.equal(await storageContains('session', rememberedKey), false);
  passed('Declining the remember dialog leaves the existing session key unchanged');

  await saveKey(rememberedKey, true, true);
  await assertLocation('anthropic', rememberedKey, 'local');
  assert.equal(await storageContains('session', anthropicKey), false, 'Persistent replacement must remove the old session value.');
  await context!.close(); context = undefined;
  await launch();
  await assertLocation('anthropic', rememberedKey, 'local');
  await assertLocation('openai', openaiKey, 'none');
  assert.equal(await options!.locator('#api-key').inputValue(), '');
  passed('A browser restart clears session keys while explicitly remembered keys survive');

  await chooseProvider('anthropic');
  await saveKey(replacementKey);
  await assertLocation('anthropic', replacementKey, 'session');
  assert.equal(await storageContains('local', rememberedKey), false, 'Session-only replacement must revoke previous persistence.');
  passed('Saving a replacement as session-only removes the remembered key');

  await saveKey(rememberedKey, true, true);
  await options!.locator('#forget-api-key').click();
  await eventually(getState, reply => !reply.credentials.anthropic.configured, 'forgotten credential');
  await assertLocation('anthropic', rememberedKey, 'none');
  assert.equal(await storageContains('session', replacementKey), false);
  assert.deepEqual(errors, [], 'No browser page errors.');
  passed('Forget removes credentials from both storage areas');

  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/credentials-replay.json', JSON.stringify({ checkedAt: new Date().toISOString(), browser: 'Microsoft Edge',
    browserVersion: context!.browser()!.version(), headless: true, realOpenAI: false, realClaude: false,
    localRequests: requests.length, results }, null, 2) + '\n');
  console.log(`Credentials replay passed in Microsoft Edge: ${results.length} checks, ${requests.length} local requests, zero real API calls.`);
} finally {
  await context?.close();
  await new Promise<void>(done => bridge.close(() => done()));
  // Guard the resolved target before deleting only this test's generated profile.
  const absolute = resolve(profile);
  if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('wooclap-credentials-test-')) {
    await rm(absolute, { recursive: true, force: true }).catch(() => undefined);
  }
}
