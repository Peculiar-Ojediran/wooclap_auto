import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { createBridgeServer } from '../server/http';
import type { ScheduledSession } from '../src/shared/schedules';

// Isolated Edge profile + intercepted Wooclap fixture + synthetic local solver.
// This exercises real browser alarms; no event or paid AI service is contacted.
const token = randomBytes(32).toString('hex');
let requests = 0;
const bridge = createBridgeServer({ token, solver: async request => {
  requests++;
  return { answer: { selectedChoiceIds: request.question.choices.filter(choice => choice.text === '42').map(choice => choice.id),
    explanation: 'Synthetic schedule test.', needsReview: false }, model: 'fixture', demo: false, usage: null };
} });
const profile = await mkdtemp(join(tmpdir(), 'wooclap-schedule-test-'));
let context: BrowserContext | undefined;
const url = 'https://app.wooclap.com/SCHEDULE-TEST';
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, label: string, timeout = 20_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (check(value)) return value;
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  await new Promise<void>((done, reject) => { bridge.once('error', reject); bridge.listen(4318, '127.0.0.1', done); });
  const extension = resolve('dist/edge');
  context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const html = await readFile('tests/fixtures/wooclap-participant.html', 'utf8');
  await context.route('https://**.wooclap.com/**', route => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const controls = await context.newPage();
  await controls.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
  const command = async (message: object) => {
    const result = await controls.evaluate(message => chrome.runtime.sendMessage(message), message);
    assert.equal(result.ok, true, result.error);
    return result;
  };
  const initial = await command({ type: 'GET_STATE' });
  await command({ type: 'SAVE_SETTINGS', settings: { ...initial.settings, provider: 'openai', model: 'fixture',
    connectionMode: 'bridge', bridgeToken: token, backgroundMode: false, mode: 'suggest', captureImages: false } });
  const originalSettings = (await command({ type: 'GET_STATE' })).settings;
  const reply = await command({ type: 'ADD_SCHEDULE', url, startsAt: Date.now() + 1500, durationMinutes: 1, mode: 'auto' });
  const job: ScheduledSession = reply.schedules[0];
  const getJob = async () => (await command({ type: 'GET_SCHEDULES' })).schedules.find((item: ScheduledSession) => item.id === job.id) as ScheduledSession;
  await until(getJob, value => value.status === 'running', 'scheduled launch');
  const state = await until(async () => (await command({ type: 'GET_STATE' })).state, value => value.phase === 'submitted', 'scheduled automatic answer');
  assert.equal(state.mode, 'auto');
  assert.equal(state.backgroundMode, true);
  assert.equal(state.endsAt, job.endsAt);
  assert.deepEqual((await command({ type: 'GET_STATE' })).settings, originalSettings, 'Schedule overrides must not alter saved settings.');
  assert.equal(requests, 1);
  const participant = context.pages().find(page => page.url() === url)!;
  assert.ok(participant);
  assert.equal(await participant.evaluate(() => (window as any).fixture.submissionCount), 1);
  assert.equal(await controls.evaluate(async id => (await chrome.tabs.get(id)).active, state.tabId), false, 'Scheduled tab must not steal focus.');
  console.log('PASS: Real alarm opened an inactive tab, enabled background auto-answering, submitted once, and kept saved settings.');
  await until(getJob, value => value.status === 'completed', 'original end deadline', 75_000);
  await until(async () => participant.isClosed(), value => value, 'owned tab closed');
  assert.equal(controls.isClosed(), false);
  assert.equal((await command({ type: 'GET_STATE' })).state.running, false);
  assert.equal(requests, 1);
  console.log('PASS: End alarm stopped monitoring and closed only the scheduled tab.');
  await controls.locator('#refresh-schedules').click();
  await controls.locator('.schedule-remove').click();
  await until(async () => (await command({ type: 'GET_SCHEDULES' })).schedules.length, count => count === 0, 'completed entry removed through settings');
  assert.deepEqual(await controls.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules), []);
  console.log('PASS: Remove in settings permanently deleted completed history.');
  const next = await command({ type: 'ADD_SCHEDULE', url, startsAt: Date.now() + 60_000, durationMinutes: 1, mode: 'suggest' });
  const pending = next.schedules.find((item: ScheduledSession) => item.status === 'pending');
  await command({ type: 'CANCEL_SCHEDULE', id: pending.id });
  const startAlarm = await controls.evaluate(async name => chrome.alarms.get(name), `wooclap-schedule:${pending.id}:start`);
  assert.equal(startAlarm, undefined);
  await command({ type: 'REMOVE_SCHEDULE', id: pending.id });
  assert.equal((await command({ type: 'GET_SCHEDULES' })).schedules.length, 0);
  console.log('PASS: Cancelling a future session removes its start alarm. Zero real API calls.');
} finally {
  await context?.close();
  await new Promise<void>(done => bridge.close(() => done()));
  const target = resolve(profile);
  if (target.startsWith(resolve(tmpdir()) + sep) && target.includes('wooclap-schedule-test-')) await rm(target, { recursive: true, force: true, maxRetries: 3 });
}
