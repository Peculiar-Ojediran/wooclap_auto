import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { chromium } from 'playwright';
import { createBridgeServer } from '../server/http';
import type { Answer, Question, SessionState } from '../src/shared/types';

// Deterministic protocol/interaction checks. This script never contacts OpenAI.
function fixtureAnswer(q: Question): Answer {
  const base: Answer = { selectedChoiceIds: [], explanation: 'Local interaction test answer.', needsReview: false };
  if (q.kind === 'numeric') return { ...base, value: '42' };
  if (q.kind === 'text') return { ...base, value: 'A local test response' };
  if (q.kind === 'fields' || q.kind === 'matching') return { ...base, values: q.fields!.map((f, i) => ({ id: f.id,
    value: f.kind === 'select' ? f.options![q.kind === 'matching' ? i % f.options!.length : 0].id : 'Paris' })) };
  if (q.kind === 'rating') return { ...base, values: q.fields!.map(f => ({ id: f.id, value: String(f.min! + 1) })) };
  if (q.kind === 'allocation') return { ...base, values: q.fields!.map((f, i) => ({ id: f.id, value: String(i === 0 ? q.constraints!.total : 0) })) };
  if (q.kind === 'categorized') return { ...base, values: [{ id: q.choices[0].id, value: 'One local test contribution' }] };
  if (q.kind === 'point' || q.kind === 'placements') return { ...base, points: q.choices.map(c => ({ id: c.id, x: 0.5, y: 0.5 })) };
  if (q.kind === 'scenario') return { ...base, selectedChoiceIds: [q.choices[Math.floor(q.choices.length / 2)].id] };
  throw new Error(`Unexpected test kind: ${q.kind}`);
}

const token = randomBytes(32).toString('hex');
const requests: Question[] = [];
const bridge = createBridgeServer({ token, solver: async request => {
  requests.push(request.question);
  return { answer: fixtureAnswer(request.question), model: 'local-fixture', usage: null, demo: false };
} });
const profile = await mkdtemp(join(tmpdir(), 'wooclap-types-test-'));
const results: object[] = [];
let context;
async function eventually<T>(read: () => Promise<T>, pass: (value: T) => boolean, label: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (pass(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

try {
  await new Promise<void>((done, reject) => { bridge.once('error', reject); bridge.listen(4318, '127.0.0.1', done); });
  const extension = resolve('dist/edge');
  context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true,
    viewport: { width: 1280, height: 1200 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging'] });
  await context.route('https://**.wooclap.com/**', async route => {
    if (!route.request().isNavigationRequest()) return route.abort();
    const fixture = new URL(route.request().url()).searchParams.get('fixture') === 'advanced' ? 'advanced' : 'structured';
    await route.fulfill({ contentType: 'text/html', body: await readFile(`tests/fixtures/${fixture}-participant.html`, 'utf8') });
  });
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
  await command({ type: 'SAVE_SETTINGS', settings: { ...original.settings, bridgeToken: token, mode: 'auto', requestLimit: 30 } });
  const participant = await context.newPage();
  const cdp = await context.browser()!.newBrowserCDPSession();
  const state = async (): Promise<SessionState> => (await command({ type: 'GET_STATE' })).state;

  // The fixture API and cases are populated by the corresponding source-based adapters.
  const cases: { fixture: string; type: string; kind: string; preview?: boolean }[] = [
    { fixture: 'structured', type: 'numeric', kind: 'numeric' },
    { fixture: 'structured', type: 'text', kind: 'text' },
    { fixture: 'structured', type: 'wordcloud', kind: 'text' },
    { fixture: 'structured', type: 'blanks', kind: 'fields' },
    { fixture: 'structured', type: 'closed-blanks', kind: 'fields' },
    { fixture: 'structured', type: 'matching', kind: 'matching' },
    { fixture: 'advanced', type: 'Rating', kind: 'rating' },
    { fixture: 'advanced', type: 'Prioritization', kind: 'allocation' },
    { fixture: 'advanced', type: 'Brainstorm', kind: 'categorized', preview: true },
    { fixture: 'advanced', type: 'Framework', kind: 'categorized', preview: true },
    { fixture: 'advanced', type: 'LabelAnImage', kind: 'fields', preview: true },
    { fixture: 'advanced', type: 'ShowOnImage', kind: 'point', preview: true },
    { fixture: 'advanced', type: 'DragAndDrop', kind: 'placements', preview: true },
    { fixture: 'advanced', type: 'Concordance', kind: 'scenario', preview: true },
    { fixture: 'advanced', type: 'SCTJudgment', kind: 'scenario', preview: true },
  ];
  for (const scenario of cases) {
    await command({ type: 'PAUSE' });
    const url = `https://app.wooclap.com/CODEX-TYPES?fixture=${scenario.fixture}`;
    await participant.goto(url);
    await participant.evaluate(({ type, fixture }) => ((window as any)[fixture === 'advanced' ? 'advancedFixture' : 'fixture']).show(type), scenario);
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    const tab = targetInfos.find(target => target.url === participant.url()); assert.ok(tab);
    await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
    await participant.bringToFront();
    const tabId = await controls.evaluate(async url => (await chrome.tabs.query({ url }))[0].id!, url);
    const before = requests.length;
    await command({ type: 'START', tabId });
    await eventually(state, s => s.phase === (scenario.preview ? 'suggestion' : 'submitted'), scenario.type);
    assert.equal(requests.length, before + 1, `${scenario.type}: one AI request`);
    assert.equal(requests.at(-1)!.kind, scenario.kind);
    if (scenario.preview) {
      assert.equal((await state()).pending?.question.application, 'preview');
      const rejected = await controls.evaluate(() => chrome.runtime.sendMessage({ type: 'APPROVE' }));
      assert.equal(rejected.ok, false, 'Preview-only application must be blocked by the service worker.');
    }
    if (scenario.kind === 'text') {
      // Model the same open form returning after a receipt; it must not become
      // another paid request or contribution when the shared board changes.
      await participant.evaluate(type => (window as any).fixture.show(type), scenario.type);
      await new Promise(resolve => setTimeout(resolve, 1800));
      assert.equal(requests.length, before + 1, 'A cleared contribution form must not trigger another answer.');
      console.log('PASS: open contribution form does not repeat the answer');
    }
    results.push({ type: scenario.type, kind: scenario.kind, preview: Boolean(scenario.preview), passed: true });
    console.log(`PASS: ${scenario.type} ${scenario.preview ? 'answer preview' : 'verified submission'}`);
  }
  assert.ok(cases.length > 0, 'The type test cases must be populated.');
  await command({ type: 'PAUSE' });
  const settings = (await command({ type: 'GET_STATE' })).settings;
  await command({ type: 'SAVE_SETTINGS', settings: { ...settings, mode: 'suggest' } });
  const url = 'https://app.wooclap.com/CODEX-TYPES?fixture=structured';
  await participant.goto(url);
  await participant.evaluate(() => (window as any).fixture.show('numeric'));
  const tabId = await controls.evaluate(async url => (await chrome.tabs.query({ url }))[0].id!, url);
  await participant.bringToFront();
  await command({ type: 'START', tabId });
  await eventually(state, s => s.phase === 'suggestion', 'numeric edit guard');
  // Keep the DOM at its previous value long enough to exercise the trusted
  // edit revision check, not just the rendered-value snapshot check.
  await participant.evaluate(() => { (window as any).fixture.inputDelay = 200; });
  await participant.locator('input[aria-live="polite"]').fill('17');
  await command({ type: 'APPROVE' });
  assert.equal((await state()).phase, 'paused');
  await eventually(() => participant.locator('input[aria-live="polite"]').inputValue(), value => value === '17', 'participant edit commits unchanged');
  assert.equal(await participant.evaluate(() => (window as any).fixture.submissionCount), 0);
  results.push({ name: 'participant-edits-preserved', passed: true });
  console.log('PASS: participant edits prevent applying a stale proposal');
  const count = requests.length;
  await participant.evaluate(() => { document.body.innerHTML = '<div class="Slide"><h1 data-test-id="Question.participant.title">Instruction slide</h1></div>'; });
  await command({ type: 'START', tabId });
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(requests.length, count);
  assert.equal((await state()).phase, 'waiting');
  results.push({ name: 'presentation-does-not-request-answer', passed: true });
  console.log('PASS: presentation content consumes no AI requests');
  await command({ type: 'PAUSE' });
} catch (error) {
  results.push({ passed: false, error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/types-replay.json', JSON.stringify({ timestamp: new Date().toISOString(), realOpenAI: false, liveWooclapSubmission: false, requests: requests.length, results }, null, 2));
  await context?.close();
  await new Promise<void>(done => bridge.close(() => done()));
  const absolute = resolve(profile);
  if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('wooclap-types-test-')) await rm(absolute, { recursive: true, force: true }).catch(() => {});
}
