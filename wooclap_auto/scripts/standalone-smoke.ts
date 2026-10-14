import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { PROVIDER_MODELS, type Provider, type SessionState, type Settings } from '../src/shared/types';

// Entirely offline: Edge's worker fetch is replaced with a synthetic transport.
// Inspect real serialized provider requests without sending credentials or billing.
const keys = { openai: 'test-only-standalone-openai', anthropic: 'test-only-standalone-anthropic', nvidia: 'test-only-standalone-nvidia' };
const hosted = process.argv.includes('--hosted');
const hostedUrl = 'https://shared-fixture.example';
const profile = await mkdtemp(join(tmpdir(), 'wooclap-standalone-test-'));
const results: { name: string; passed: true }[] = [];
const errors: string[] = [];
let context: BrowserContext | undefined;
let controls: Page;
let practice: Page;
let worker: Worker;
let extensionId = '';
interface StateReply { ok: boolean; error?: string; state: SessionState; settings: Settings }
interface CapturedRequest { url: string; method: string; headers: Record<string, string>; body: any; credentials: string; redirect: string }
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeout = 12_000): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(75);
  }
  throw new Error(`Timed out: ${label}`);
}
function passed(name: string): void { results.push({ name, passed: true }); console.log(`PASS: ${name}`); }
async function command(message: object): Promise<StateReply> {
  const response = await controls.evaluate(message => chrome.runtime.sendMessage(message), message);
  assert.equal(response.ok, true, response.error);
  return response;
}
const state = async () => (await command({ type: 'GET_STATE' })).state;
const phase = (value: string) => waitFor(state, state => state.phase === value, value);
const calls = () => worker.evaluate('globalThis.__standalone.requests') as Promise<CapturedRequest[]>;
const behavior = (value: string) => worker.evaluate(value => { (globalThis as any).__standalone.behavior = value; }, value);
async function configure(values: Partial<Settings>): Promise<void> {
  const { settings } = await command({ type: 'GET_STATE' });
  await command({ type: 'SAVE_SETTINGS', settings: { ...settings, ...values } });
}
async function start(): Promise<void> {
  await practice.bringToFront();
  const tabId = await controls.evaluate(async url => (await chrome.tabs.query({ url }))[0].id!, practice.url());
  await command({ type: 'START', tabId });
}
async function repeat(): Promise<void> { await practice.locator('#repeat-question').click(); }
async function assertNoBridge(): Promise<void> {
  const listening = await new Promise<boolean>(done => {
    const socket = connect({ host: '127.0.0.1', port: 4318 });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => { socket.destroy(); done(false); });
    socket.setTimeout(1000, () => { socket.destroy(); done(false); });
  });
  assert.equal(listening, false, 'Stop the optional local bridge before this offline standalone replay.');
}

try {
  await assertNoBridge();
  let extension = resolve('dist/edge');
  if (hosted) {
    extension = join(profile, 'fixture-extension');
    await cp(resolve('dist/edge'), extension, { recursive: true });
    await build({ entryPoints: { background: 'src/background.ts', options: 'src/ui/options.ts' }, bundle: true,
      outdir: extension, format: 'iife', platform: 'browser', target: 'chrome116',
      define: { __HOSTED_FALLBACK_URL__: JSON.stringify(hostedUrl) } });
    const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
    manifest.key = (await readFile('extension/hosted-public-key.txt', 'utf8')).trim();
    manifest.host_permissions.push(hostedUrl + '/*');
    manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace('connect-src ', 'connect-src ' + hostedUrl + ' ');
    await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  }
  context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true, viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.setOffline(true);
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  // Use source text so tsx function-name helpers do not enter this separate realm.
  await worker.evaluate(`(() => {
    globalThis.__standalone = { requests: [], behavior: 'answer', aborted: 0 };
    globalThis.fetch = async (input, init) => {
      const fixture = globalThis.__standalone;
      const request = new Request(input, init);
      const shared = request.url.startsWith('https://shared-fixture.example');
      if (shared && request.method === 'GET') return Response.json({ ready: true, demo: false, provider: 'nvidia', model: 'deepseek-ai/deepseek-v4.1-flash', protocolVersion: 2 });
      const body = JSON.parse(await request.clone().text());
      fixture.requests.push({ url: request.url, method: request.method,
        headers: Object.fromEntries(request.headers), body,
        credentials: request.credentials, redirect: request.redirect });
      if (!['https://api.openai.com/v1/responses', 'https://api.anthropic.com/v1/messages', 'https://integrate.api.nvidia.com/v1/chat/completions', 'https://shared-fixture.example/solve'].includes(request.url)) {
        throw new Error('Unexpected endpoint in the standalone fixture.');
      }
      if (fixture.behavior === 'delay') await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 10000);
        const abort = () => { clearTimeout(timer); fixture.aborted++; reject(new DOMException('Aborted', 'AbortError')); };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
      if (fixture.behavior === 'auth') return new Response('private upstream error', { status: 401 });
      if (fixture.behavior === 'quota') return new Response('private upstream error', { status: 429 });
      const nvidia = request.url.includes('nvidia.com');
      const anthropic = request.url.includes('anthropic.com');
      const content = shared ? null : nvidia ? body.messages[1].content : anthropic ? body.messages[0].content : body.input[0].content;
      const prompt = shared ? body.question : JSON.parse(content.find(part => part.type === (anthropic || nvidia ? 'text' : 'input_text')).text);
      const selected = prompt.choices.some(choice => choice.id === 'math-42') ? ['math-42']
        : prompt.choices.some(choice => choice.id === 'prime-2') ? ['prime-2', 'prime-5']
          : prompt.choices.some(choice => choice.id === 'true') ? ['true'] : ['sides-3'];
      const answer = JSON.stringify({ selectedChoiceIds: fixture.behavior === 'invalid' ? ['not-a-choice'] : selected,
        explanation: 'Synthetic standalone answer.', needsReview: false });
      const refusal = fixture.behavior === 'refusal';
      const response = shared ? { provider: 'nvidia', model: body.model, demo: false, answer: JSON.parse(answer), usage: { inputTokens: 25, outputTokens: 15 } }
        : nvidia ? { choices: [{ finish_reason: refusal ? 'content_filter' : 'stop', message: { role: 'assistant', content: answer } }], usage: { prompt_tokens: 25, completion_tokens: 15 } }
        : anthropic ? {
        id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
        stop_reason: refusal ? 'refusal' : 'end_turn',
        content: [{ type: 'text', text: refusal ? 'Fixture refusal.' : answer }],
        usage: { input_tokens: 25, output_tokens: 15 }
      } : {
        id: 'resp_fixture', object: 'response', status: 'completed', model: body.model,
        output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
          content: [refusal ? { type: 'refusal', refusal: 'Fixture refusal.' }
            : { type: 'output_text', text: answer, annotations: [] }] }],
        usage: { input_tokens: 25, output_tokens: 15, total_tokens: 40 }
      };
      return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  })()`);
  controls = await context.newPage();
  await controls.goto(`chrome-extension://${extensionId}/options.html`);
  const initial = await command({ type: 'GET_STATE' });
  assert.equal(initial.settings.connectionMode, 'direct');
  assert.equal(initial.settings.bridgeToken, '');
  const health = await controls.evaluate(() => chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' }));
  assert.equal(health.ok, true);
  assert.equal(initial.settings.provider, 'nvidia');
  assert.equal(initial.settings.model, PROVIDER_MODELS.nvidia);
  assert.equal(health.health.connectionMode, 'hosted');
  assert.equal(health.health.ready, hosted);
  assert.equal((await calls()).length, 0, 'Configuration check must not send a paid request.');
  practice = await context.newPage();
  await practice.goto(`chrome-extension://${extensionId}/practice.html`);
  await practice.locator('[data-wooclap-question]').waitFor();
  const tabId = await controls.evaluate(async url => (await chrome.tabs.query({ url }))[0].id!, practice.url());
  const missingKey = await controls.evaluate(tabId => chrome.runtime.sendMessage({ type: 'START', tabId }), tabId);
  if (hosted) {
    assert.equal(missingKey.ok, true, missingKey.error);
    const answer = await phase('suggestion');
    assert.equal(answer.bridgeMode, 'nvidia'); assert.equal(answer.connectionMode, 'hosted');
    assert.equal(answer.lastResponse?.model, PROVIDER_MODELS.nvidia);
    await command({ type: 'PAUSE' });
    passed('Fresh installs use shared NVIDIA with no user API key or bridge');
  } else {
    assert.equal(missingKey.ok, false); assert.match(missingKey.error, /API key/i);
    assert.equal((await calls()).length, 0);
    passed('Fresh installs default to NVIDIA and report an unconfigured hosted service honestly');
  }
  const initialCalls = (await calls()).length;

  const boundary = await practice.evaluate(async () => {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    const save = await chrome.runtime.sendMessage({ type: 'SAVE_API_KEY', provider: 'openai', apiKey: 'test-forbidden', remember: false });
    return { state, save };
  });
  assert.equal(Object.hasOwn(boundary.state ?? {}, 'credentials'), false);
  assert.equal(Object.hasOwn(boundary.state ?? {}, 'settings'), false);
  assert.notEqual(boundary.save?.ok, true, 'Packaged practice cannot invoke administrative credential commands.');
  passed('Packaged practice cannot read settings or invoke credential commands');

  await configure({ connectionMode: 'demo', mode: 'suggest', captureImages: false });
  await start();
  const suggestion = await phase('suggestion');
  assert.deepEqual(suggestion.pending?.answer.selectedChoiceIds, ['math-42']);
  assert.equal(suggestion.pending?.demo, true);
  await command({ type: 'APPROVE' });
  await phase('submitted');
  assert.equal(await practice.locator('#submission-count').textContent(), '1');
  await command({ type: 'PAUSE' });
  await configure({ mode: 'auto' });
  await practice.locator('#next-question').click();
  await start();
  await phase('submitted');
  assert.equal(await practice.locator('#submission-count').textContent(), '2');
  assert.equal((await calls()).length, initialCalls);
  passed('Bundled practice supports offline demo suggestions and automatic submission with no server');

  await command({ type: 'PAUSE' });
  await practice.locator('#question-picker').selectOption('0');
  await practice.locator('#show-question').click();
  for (const provider of ['openai', 'anthropic', 'nvidia'] as const) {
    await command({ type: 'SAVE_API_KEY', provider, apiKey: keys[provider], remember: false });
    await configure({ connectionMode: 'direct', provider, model: PROVIDER_MODELS[provider], mode: 'suggest' });
    await start();
    const ready = await phase('suggestion');
    assert.equal(ready.bridgeMode, provider);
    assert.equal(ready.pending?.demo, false);
    assert.deepEqual(ready.pending?.answer.selectedChoiceIds, ['math-42']);
    const request = (await calls()).at(-1)!;
    assert.equal(request.url, provider === 'openai' ? 'https://api.openai.com/v1/responses' : provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(request.method, 'POST');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.redirect, 'error');
    assert.equal(request.body.model, PROVIDER_MODELS[provider]);
    assert.equal(Object.values(keys).some(key => JSON.stringify(request.body).includes(key)), false, 'API keys must stay out of question payloads.');
    if (provider === 'openai') {
      assert.equal(request.headers.authorization === `Bearer ${keys.openai}`, true);
      assert.equal(request.body.store, false);
      assert.equal(request.body.text.format.type, 'json_schema');
    } else if (provider === 'nvidia') {
      assert.equal(request.headers.authorization === `Bearer ${keys.nvidia}`, true);
      assert.equal(request.body.response_format, undefined);
      assert.match(request.body.messages[0].content, /JSON Schema/);
    } else {
      assert.equal(request.headers['x-api-key'] === keys.anthropic, true);
      assert.equal(request.headers['anthropic-dangerous-direct-browser-access'], 'true');
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
      assert.equal(request.body.output_config.format.type, 'json_schema');
    }
    const count = (await calls()).length;
    await command({ type: 'PAUSE' });
    await start();
    await phase('suggestion');
    assert.equal((await calls()).length, count, 'Pause/resume preserves a ready answer without another API request.');
    await command({ type: 'PAUSE' });
  }
  assert.equal((await calls()).length, initialCalls + 3, 'Switching provider must not reuse the other provider answer.');
  assert.equal(await practice.locator('#submission-count').textContent(), '2');
  const metadata = JSON.stringify(await command({ type: 'GET_STATE' }));
  assert.equal(Object.values(keys).some(key => metadata.includes(key)), false);
  passed('NVIDIA, OpenAI, and Claude use direct requests, isolated keys, validated answers, and separate caches');

  for (const provider of ['openai', 'anthropic', 'nvidia'] as const) {
    await configure({ provider, model: PROVIDER_MODELS[provider], mode: 'auto' });
    await behavior('refusal');
    await repeat();
    await start();
    const refused = await phase('error');
    assert.match(refused.detail, /declined/i);
    assert.equal(refused.pending, null);
    assert.equal(await practice.locator('#submission-count').textContent(), '2');
    await command({ type: 'PAUSE' });
  }
  await behavior('invalid');
  await repeat();
  await start();
  await phase('error');
  assert.equal(await practice.locator('#submission-count').textContent(), '2');
  await command({ type: 'PAUSE' });
  passed('Provider refusals and invalid choice IDs cannot trigger automatic submission');

  await behavior('delay');
  await repeat();
  await start();
  await phase('solving');
  const delayedCalls = (await calls()).length;
  await command({ type: 'PAUSE' });
  await waitFor(() => worker.evaluate('globalThis.__standalone.aborted') as Promise<number>, count => count > 0, 'direct request aborted');
  await sleep(400);
  assert.equal((await state()).phase, 'paused');
  assert.equal(await practice.locator('#submission-count').textContent(), '2');
  assert.equal((await calls()).length, delayedCalls);
  passed('Pause cancels the direct provider request and prevents submission');

  await behavior('answer');
  await configure({ backgroundMode: true });
  await repeat();
  await start();
  await phase('submitted');
  const decoy = await context.newPage();
  await decoy.goto('about:blank');
  await decoy.bringToFront();
  await practice.locator('#repeat-question').evaluate((button: HTMLButtonElement) => button.click());
  await waitFor(() => practice.locator('#submission-count').textContent(), count => count === '4', 'inactive bundled practice submission');
  assert.equal((await state()).running, true);
  await command({ type: 'PAUSE' });
  passed('Standalone provider answering continues on an inactive tab when background mode is enabled');

  const windowId = await controls.evaluate(async tabId => (await chrome.tabs.get(tabId)).windowId, tabId);
  for (const provider of ['openai', 'anthropic', 'nvidia'] as const) {
    await configure({ provider, model: PROVIDER_MODELS[provider], captureImages: true, mode: 'auto', backgroundMode: true });
    await practice.locator('#question-picker').selectOption('3');
    await practice.locator('#show-question').click();
    await start();
    await controls.evaluate(windowId => chrome.windows.update(windowId, { state: 'minimized' }), windowId);
    await phase('submitted');
    assert.equal(await controls.evaluate(async windowId => (await chrome.windows.get(windowId)).state, windowId), 'minimized');
    const imageRequest = (await calls()).at(-1)!;
    if (provider === 'openai') {
      assert.match(imageRequest.body.input[0].content.find((part: any) => part.type === 'input_image').image_url, /^data:image\/png;base64,/);
    } else if (provider === 'nvidia') {
      assert.match(imageRequest.body.messages[1].content.find((part: any) => part.type === 'image_url').image_url.url, /^data:image\/png;base64,/);
    } else {
      const source = imageRequest.body.messages[0].content.find((part: any) => part.type === 'image').source;
      assert.equal(source.media_type, 'image/png');
      assert.equal(source.type, 'base64');
      assert.ok(source.data.length > 100);
    }
    await command({ type: 'PAUSE' });
    await controls.evaluate(windowId => chrome.windows.update(windowId, { state: 'normal' }), windowId);
  }
  assert.equal(await practice.locator('#submission-count').textContent(), '7');
  passed('Direct NVIDIA, OpenAI, and Claude visual answers capture the monitored tab while Edge is minimized');

  if (hosted) {
    await configure({ provider: 'openai', model: PROVIDER_MODELS.openai, mode: 'auto' });
    await behavior('auth'); await repeat(); await start(); await phase('error');
    assert.equal((await calls()).at(-1)!.url, 'https://api.openai.com/v1/responses');
    await command({ type: 'PAUSE' });
    passed('An existing personal key takes priority and its auth failure never triggers fallback');
    await command({ type: 'CLEAR_API_KEY', provider: 'openai' });
    await behavior('answer'); await repeat(); await start();
    await controls.evaluate(windowId => chrome.windows.update(windowId, { state: 'minimized' }), windowId);
    const shared = await phase('submitted');
    assert.equal(shared.connectionMode, 'hosted'); assert.equal(shared.bridgeMode, 'nvidia');
    const request = (await calls()).at(-1)!;
    assert.equal(request.url, hostedUrl + '/solve'); assert.equal(request.body.model, PROVIDER_MODELS.nvidia);
    assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
    assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error');
    assert.equal(request.body.question.eventKey, 'shared-fallback'); assert.equal(request.body.question.questionId, null);
    assert.match(request.body.screenshot, /^data:image\/png;base64,/);
    assert.equal(Object.values(keys).some(key => JSON.stringify(request).includes(key)), false);
    assert.equal(await controls.evaluate(async windowId => (await chrome.windows.get(windowId)).state, windowId), 'minimized');
    await command({ type: 'PAUSE' });
    await controls.evaluate(windowId => chrome.windows.update(windowId, { state: 'normal' }), windowId);
    passed('Missing selected-provider key uses fixed NVIDIA hosted vision with no personal keys, even minimized');
    const submissions = await practice.locator('#submission-count').textContent();
    for (const value of ['invalid', 'quota']) {
      await behavior(value); await repeat(); await start(); await phase('error');
      assert.equal(await practice.locator('#submission-count').textContent(), submissions);
      await command({ type: 'PAUSE' });
    }
    await behavior('delay'); await repeat(); await start(); await phase('solving');
    const abortedBefore = await worker.evaluate('globalThis.__standalone.aborted') as number;
    await command({ type: 'PAUSE' });
    await waitFor(() => worker.evaluate('globalThis.__standalone.aborted') as Promise<number>, count => count > abortedBefore, 'hosted abort');
    assert.equal(await practice.locator('#submission-count').textContent(), submissions);
    passed('Hosted invalid answers, quotas, and cancellation never submit');
  }
  assert.deepEqual(errors, [], 'No browser page errors.');
  await assertNoBridge();
  await mkdir('test-results', { recursive: true });
  await writeFile(hosted ? 'test-results/hosted-replay.json' : 'test-results/standalone-replay.json', JSON.stringify({ checkedAt: new Date().toISOString(),
    browser: 'Microsoft Edge', browserVersion: context.browser()!.version(), offline: true, localhostBridge: false,
    realOpenAI: false, realClaude: false, realNvidia: false, hostedFixture: hosted, mockedProviderRequests: (await calls()).length, results }, null, 2) + '\n');
  console.log(`Standalone replay passed: ${results.length} checks, no bridge, zero real API calls.`);
} finally {
  await context?.close();
  const absolute = resolve(profile);
  if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('wooclap-standalone-test-')) {
    await rm(absolute, { recursive: true, force: true }).catch(() => undefined);
  }
}
