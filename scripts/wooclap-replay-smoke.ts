import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { createBridgeServer } from '../server/http';
import { createOpenAISolver, type Solver } from '../server/solver';
import type { SessionState, SolveRequest, SolveResponse } from '../src/shared/types';

const real = process.argv.includes('--real');
const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini';
if (real && !apiKey) throw new Error('Set OPENAI_API_KEY in .env before the explicit paid browser test.');
const results: object[] = [];
const requestLog: SolveRequest[] = [];
const responseLog: SolveResponse[] = [];
const fixtureSolver: Solver = async request => {
  const correct = request.question.multiple ? ['2', '5'] : request.question.imageKeys.length ? ['3'] : ['42'];
  const selected = request.question.kind === 'sorting' ? [...request.question.choices].sort((a, b) => Number(a.text) - Number(b.text)).map(c => c.id) : request.question.choices.filter(choice => correct.includes(choice.text.trim())).map(choice => choice.id);
  return { answer: { selectedChoiceIds: selected, explanation: 'Synthetic replay test answer.', needsReview: false }, model: 'fixture-solver', demo: false, usage: null };
};
const solver = real ? createOpenAISolver(apiKey!) : fixtureSolver;
const token = randomBytes(32).toString('hex');
const bridge = createBridgeServer({ token, model, solver: async (request, signal) => {
  requestLog.push(request);
  const response = await solver(request, signal);
  responseLog.push(response);
  return response;
} });
const profile = await mkdtemp(join(tmpdir(), 'wooclap-replay-test-'));
let context;
const pageUrl = 'https://app.wooclap.com/CODEX-LIVE-TEST';
async function eventually<T>(read: () => Promise<T>, condition: (value: T) => boolean, label: string, timeout = 35_000): Promise<T> {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (condition(value)) return value;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

try {
  await new Promise<void>((done, reject) => { bridge.once('error', reject); bridge.listen(4318, '127.0.0.1', done); });
  const extensionPath = resolve('dist/edge');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true, viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--enable-unsafe-extension-debugging']
  });
  // The URL exercises extension host matching. No request reaches Wooclap.
  const html = await readFile('tests/fixtures/wooclap-participant.html', 'utf8');
  await context.route('https://**.wooclap.com/**', route => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const controls = await context.newPage();
  await controls.goto(`chrome-extension://${extensionId}/popup.html`);
  const command = async (message: object) => {
    const response = await controls.evaluate(message => chrome.runtime.sendMessage(message), message);
    assert.equal(response.ok, true, response.error);
    return response;
  };
  const original = await command({ type: 'GET_STATE' });
  await command({ type: 'SAVE_SETTINGS', settings: { ...original.settings, provider: 'openai', connectionMode: 'bridge', bridgeToken: token, mode: 'auto', model, requestLimit: real ? 2 : 10 } });
  const participant = await context.newPage();
  await participant.goto(pageUrl);
  const cdp = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const tabTarget = targetInfos.find(target => target.url === participant.url());
  assert.ok(tabTarget);
  await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
  await participant.bringToFront();
  const tabId = await controls.evaluate(async url => (await chrome.tabs.query({ url }))[0].id!, pageUrl);
  const state = async (): Promise<SessionState> => (await command({ type: 'GET_STATE' })).state;
  const phase = (expected: string) => eventually(state, value => value.phase === expected, expected);
  await command({ type: 'START', tabId });
  await phase('submitted');
  assert.equal(await participant.evaluate(() => (window as any).fixture.submissionCount), 1);
  assert.equal(requestLog[0].question.source, 'wooclap');
  assert.ok(responseLog[0].answer.selectedChoiceIds.length === 1);
  assert.equal(requestLog[0].question.choices.find(choice => choice.id === responseLog[0].answer.selectedChoiceIds[0])?.text.trim(), '42');
  results.push({ name: 'single-choice-live-layout', passed: true, response: (await state()).lastResponse });
  console.log('PASS: source-grounded Wooclap single-choice layout through Edge and the local bridge');

  if (!real) {
    await participant.evaluate(() => (window as any).fixture.show('multiple'));
    await eventually(() => Promise.resolve(responseLog.length), value => value === 2, 'multiple-answer request');
    await phase('submitted');
    assert.equal(responseLog[1].answer.selectedChoiceIds.length, 2);
    assert.deepEqual(await participant.evaluate(() => (window as any).fixture.submittedIds), ['choice-1', 'choice-3']);
    results.push({ name: 'multiple-answer-live-layout', passed: true });
    console.log('PASS: Wooclap multiple-answer custom buttons and separate submit');
  }
  await participant.evaluate(() => (window as any).fixture.show('image'));
  const expectedCount = real ? 2 : 3;
  await eventually(() => Promise.resolve(responseLog.length), value => value === expectedCount, 'image request');
  await phase('submitted');
  assert.ok(requestLog.at(-1)?.screenshot, 'Meaningful Wooclap images must trigger screenshot capture.');
  assert.equal(requestLog.at(-1)!.question.choices.find(choice => choice.id === responseLog.at(-1)!.answer.selectedChoiceIds[0])?.text.trim(), '3');
  results.push({ name: 'image-live-layout', passed: true, response: (await state()).lastResponse });
  console.log('PASS: Wooclap visual question capture and answer submission');
  assert.equal(requestLog.length, expectedCount, 'Exactly one request per question');
  if (real) assert.ok(responseLog.every(result => !result.demo && result.usage && result.usage.inputTokens > 0));
  if (!real) {
    // Live MCQs expose no stable question ID. A confirmed submission is a
    // reliable boundary when the presenter immediately repeats identical text.
    await participant.evaluate(() => (window as any).fixture.show('single'));
    await eventually(() => participant.evaluate(() => (window as any).fixture.submissionCount), value => value === 4, 'first repeated question');
    await participant.evaluate(() => (window as any).fixture.show('single'));
    await eventually(() => participant.evaluate(() => (window as any).fixture.submissionCount), value => value === 5, 'identical repeated question');
    console.log('PASS: identical live questions after submission form separate occurrences');
    await command({ type: 'PAUSE' });
    const currentSettings = (await command({ type: 'GET_STATE' })).settings;
    await command({ type: 'SAVE_SETTINGS', settings: { ...currentSettings, mode: 'suggest' } });
    await participant.evaluate(() => (window as any).fixture.show('single'));
    await command({ type: 'START', tabId });
    await phase('suggestion');
    const previousCount = requestLog.length;
    await command({ type: 'SAVE_SETTINGS', settings: { ...currentSettings, mode: 'suggest', model: 'another-test-model' } });
    await command({ type: 'START', tabId });
    await phase('suggestion');
    assert.equal(requestLog.length, previousCount + 1, 'Changing models must not reuse a previous model answer.');
    console.log('PASS: changing the selected model invalidates the cached answer');
  }
  if (!real) {
    await command({ type: 'PAUSE' });
    const settings = (await command({ type: 'GET_STATE' })).settings;
    await command({ type: 'SAVE_SETTINGS', settings: { ...settings, mode: 'auto' } });
    await participant.evaluate(() => (window as any).fixture.show('sorting'));
    await command({ type: 'START', tabId });
    await phase('submitted');
    assert.deepEqual(await participant.evaluate(() => (window as any).fixture.submittedIds), ['sort-10', 'sort-20', 'sort-30']);
    assert.equal(requestLog.at(-1)!.question.kind, 'sorting');
    results.push({ name: 'sorting-live-layout', passed: true });
    console.log('PASS: sorting movement, final order verification and submission through Edge');
  }
  await command({ type: 'PAUSE' });
  await mkdir('test-results', { recursive: true });
  await participant.screenshot({ path: 'test-results/wooclap-replay.png' });
  console.log(`Replay passed in Microsoft Edge with ${real ? 'real OpenAI' : 'synthetic'} responses. No live Wooclap answers were submitted.`);
} catch (error) {
  results.push({ passed: false, message: error instanceof Error ? error.message : 'Replay failed.' });
  throw error;
} finally {
  await mkdir('test-results', { recursive: true });
  await writeFile(`test-results/${real ? 'openai-browser' : 'wooclap-replay'}.json`, JSON.stringify({ timestamp: new Date().toISOString(), realOpenAI: real, liveWooclapSubmission: false, requests: requestLog.length, results }, null, 2) + '\n');
  await context?.close();
  await new Promise<void>(done => bridge.close(() => done()));
  const absolute = resolve(profile);
  if (absolute.startsWith(resolve(tmpdir()) + '\\') && absolute.includes('wooclap-replay-test-')) await rm(absolute, { recursive: true, force: true }).catch(() => undefined);
}
