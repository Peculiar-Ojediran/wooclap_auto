import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { createBridgeServer } from '../server/http';
import { demoSolver } from '../server/solver';
import type { SessionState, SolveRequest } from '../src/shared/types';

const token = randomBytes(32).toString('hex');
const requests: SolveRequest[] = [];
let delayMs = 0;
let browser: BrowserContext | undefined;
let browserName = '';
const profiles: string[] = [];
const bridge = createBridgeServer({ token, demo: true, rateLimit: 100, solver: async (request, signal) => {
  requests.push(request);
  if (delayMs) await new Promise<void>((done, reject) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled')); }, { once: true });
  });
  return demoSolver(request, signal);
} });

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, name: string, timeout = 10_000): Promise<T> {
  const until = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < until) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${name}; last=${JSON.stringify(last)}`);
}

try {
  await new Promise<void>((done, reject) => { bridge.once('error', reject); bridge.listen(4318, '127.0.0.1', done); });
  const extensionPath = resolve('dist/edge');
  let extensionId = '';
  for (const channel of ['msedge', 'chromium']) {
    const profile = await mkdtemp(join(tmpdir(), 'wooclap-edge-test-'));
    profiles.push(profile);
    try {
      browser = await chromium.launchPersistentContext(profile, {
        channel, headless: true, viewport: { width: 1280, height: 1000 },
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
      });
      const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 7000 });
      extensionId = new URL(worker.url()).hostname;
      browserName = channel === 'msedge' ? 'Microsoft Edge' : 'Chromium (Edge-compatible extension runtime)';
      break;
    } catch (error) {
      await browser?.close(); browser = undefined;
      if (channel === 'chromium') throw error;
      console.log('Edge did not expose a command-line-loaded extension; trying bundled Chromium.');
    }
  }
  assert.ok(browser, 'A browser must be available.');
  const errors: string[] = [];
  browser.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#connection-mode').selectOption('bridge');
  await options.locator('#bridge-token').fill(token);
  await options.locator('#check-bridge').click();
  await waitFor(() => options.locator('#bridge-status').textContent(), text => Boolean(text && /demo/i.test(text)), 'bridge connection');
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const practice = await browser.newPage();
  await practice.goto('http://127.0.0.1:4318/practice');
  await practice.bringToFront();
  const command = async (message: Record<string, unknown>) => {
    const result = await popup.evaluate(message => chrome.runtime.sendMessage(message), message);
    assert.equal(result.ok, true, result.error);
    return result;
  };
  const state = async (): Promise<SessionState> => (await command({ type: 'GET_STATE' })).state;
  const getTab = () => popup.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:4318/practice' }))[0].id!);
  const start = async () => { await practice.bringToFront(); await command({ type: 'START', tabId: await getTab() }); };
  const phase = (expected: string) => waitFor(state, value => value.phase === expected, expected);
  await start();
  await phase('suggestion');
  assert.deepEqual((await state()).pending?.answer.selectedChoiceIds, ['math-42']);
  assert.equal(await practice.locator('#submission-count').textContent(), '0');
  await command({ type: 'PAUSE' });
  await start();
  await phase('suggestion');
  assert.equal(requests.length, 1, 'pause/resume must restore a ready answer without billing again');
  // A temporary incomplete layout should invalidate then restore the same answer.
  await practice.locator('[data-wooclap-question-text]').evaluate(element => {
    const text = element.textContent;
    element.textContent = '';
    setTimeout(() => { element.textContent = text; }, 200);
  });
  await new Promise(done => setTimeout(done, 1100));
  await phase('suggestion');
  assert.equal(requests.length, 1, 'transient DOM changes must not bill for the same question');
  await new Promise(done => setTimeout(done, 5500));
  assert.equal(requests.length, 1, 'timer and polling must not cause a second request');
  await command({ type: 'APPROVE' });
  await phase('submitted');
  assert.equal(await practice.locator('#submission-count').textContent(), '1');
  console.log('PASS: suggestion review, pause/resume cache, transient DOM recovery, timer deduplication, submit confirmation');

  await command({ type: 'PAUSE' });
  const settings = (await command({ type: 'GET_STATE' })).settings;
  await command({ type: 'SAVE_SETTINGS', settings: { ...settings, mode: 'auto' } });
  await practice.locator('#next-question').click();
  await start();
  await phase('submitted');
  assert.equal(await practice.locator('#submission-count').textContent(), '2');
  assert.match((await practice.locator('#submitted-detail').textContent())!, /2, 5/);
  console.log('PASS: automatic multiple-answer selection');

  await practice.locator('#next-question').click();
  await waitFor(() => practice.locator('#submission-count').textContent(), count => count === '3', 'true/false submit');
  await practice.locator('#repeat-question').click();
  await waitFor(() => practice.locator('#submission-count').textContent(), count => count === '4', 'repeated occurrence submit');
  console.log('PASS: true/false and repeated-question occurrence');

  delayMs = 2500;
  await practice.locator('#question-picker').selectOption('0');
  await practice.locator('#show-question').click();
  await phase('solving');
  await practice.locator('#show-waiting').click();
  await phase('waiting');
  await new Promise(done => setTimeout(done, 2800));
  assert.equal(await practice.locator('#submission-count').textContent(), '4');
  console.log('PASS: closed question cancels a delayed answer');

  await practice.locator('#show-question').click();
  await phase('solving');
  await command({ type: 'PAUSE' });
  await new Promise(done => setTimeout(done, 2800));
  assert.equal(await practice.locator('#submission-count').textContent(), '4');
  assert.equal((await state()).phase, 'paused');
  console.log('PASS: pause cancels pending work');

  delayMs = 0;
  await practice.locator('#repeat-question').click();
  await start();
  await waitFor(() => practice.locator('#submission-count').textContent(), count => count === '5', 'resume');
  await popup.bringToFront();
  await phase('paused');
  console.log('PASS: changing tabs pauses the session');

  // Exhaustion must not consume a question before it is sent to the local solver.
  const currentSettings = (await command({ type: 'GET_STATE' })).settings;
  const requestCount = (await state()).requestCount;
  await command({ type: 'SAVE_SETTINGS', settings: { ...currentSettings, requestLimit: requestCount } });
  await practice.bringToFront();
  await practice.locator('#repeat-question').click();
  await start();
  await waitFor(state, value => value.phase === 'paused' && value.detail.includes('limit'), 'request limit');
  const beforeLimitRecovery = requests.length;
  await command({ type: 'SAVE_SETTINGS', settings: { ...currentSettings, requestLimit: 25 } });
  await start();
  await waitFor(() => practice.locator('#submission-count').textContent(), count => count === '6', 'request limit recovery');
  assert.equal(requests.length, beforeLimitRecovery + 1);
  console.log('PASS: request limit can be raised without losing the unrequested question');

  // A changed choice order invalidates an answer even when the question ID stays the same.
  await command({ type: 'PAUSE' });
  await command({ type: 'SAVE_SETTINGS', settings: { ...currentSettings, mode: 'suggest' } });
  await practice.locator('#repeat-question').click();
  await start();
  await phase('suggestion');
  const originalFingerprint = (await state()).pending!.fingerprint;
  await practice.locator('.choices').evaluate(element => element.append(element.firstElementChild!));
  await waitFor(state, value => value.phase === 'suggestion' && Boolean(value.pending) && value.pending?.fingerprint !== originalFingerprint, 'reordered choices');
  assert.equal(await practice.locator('#submission-count').textContent(), '6');
  console.log('PASS: reordered choices invalidate an existing suggestion');

  // Suppress the confirmation signal after a submit: never repeat an uncertain click.
  await practice.evaluate(() => {
    document.querySelector('[data-wooclap-question]')!.addEventListener('submit', () => {
      document.querySelector('[data-wooclap-confirmation]')!.remove();
    });
  });
  await command({ type: 'APPROVE' });
  await waitFor(state, value => value.phase === 'paused' && value.detail.includes('no confirmation'), 'uncertain submission');
  const beforeResume = requests.length;
  await start();
  await new Promise(done => setTimeout(done, 1000));
  assert.equal(await practice.locator('#submission-count').textContent(), '7');
  assert.equal(requests.length, beforeResume);
  console.log('PASS: missing confirmation pauses without retrying the submit');

  await command({ type: 'PAUSE' });
  await practice.reload();
  await start();
  await phase('suggestion');
  assert.equal((await state()).requestCount, 1, 'a new page session must get a new request budget');
  await command({ type: 'PAUSE' });
  console.log('PASS: a new page session resets its request budget');

  // Loading popup/options as pages verifies their CSP scripts and rendering too.
  await mkdir('test-results', { recursive: true });
  await popup.bringToFront();
  await waitFor(() => popup.locator('#phase').getAttribute('data-phase'), value => value === 'paused', 'popup status render');
  await popup.screenshot({ path: 'test-results/popup.png', clip: { x: 0, y: 0, width: 404, height: 600 } });
  await options.screenshot({ path: 'test-results/options.png', fullPage: true });
  await practice.screenshot({ path: 'test-results/practice.png', fullPage: true });
  assert.deepEqual(errors, [], 'No browser page errors');
  console.log(`Browser smoke passed in ${browserName}. ${requests.length} local solver calls, zero real API calls.`);
} finally {
  await browser?.close();
  await new Promise<void>(done => bridge.close(() => done()));
  for (const profile of profiles) {
    // Only delete known per-test temp directories, never a user's browser profile.
    const absolute = resolve(profile);
    if (absolute.startsWith(resolve(tmpdir()) + '\\') && absolute.includes('wooclap-edge-test-')) await rm(absolute, { recursive: true, force: true }).catch(() => undefined);
  }
}
