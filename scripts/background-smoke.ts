import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { createBridgeServer } from '../server/http';
import { demoSolver } from '../server/solver';
import type { SessionState, SolveRequest } from '../src/shared/types';

// An isolated Edge profile and deterministic bridge exercise the shipped
// extension. No activeTab grant, user profile, API key, or paid API call is used.
const token = randomBytes(32).toString('hex');
const requests: SolveRequest[] = [];
const results: { name: string; passed: true; detail?: object }[] = [];
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let delayMs = 0;
let cancelled = 0;
let context: BrowserContext | undefined;
const profile = await mkdtemp(join(tmpdir(), 'wooclap-background-test-'));
const bridge = createBridgeServer({ token, demo: true, rateLimit: 100, solver: async (request, signal) => {
  requests.push(request);
  if (delayMs) await new Promise<void>((done, reject) => {
    const abort = () => { cancelled++; clearTimeout(timer); reject(new Error('Local test cancelled.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); done(); }, delayMs);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  return demoSolver(request, signal);
} });

async function eventually<T>(read: () => Promise<T>, pass: (value: T) => boolean, label: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (pass(value)) return value;
    await sleep(100);
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
function passed(name: string, detail?: object): void {
  results.push({ name, passed: true, ...(detail ? { detail } : {}) });
  console.log(`PASS: ${name}`);
}

try {
  await new Promise<void>((done, reject) => { bridge.once('error', reject); bridge.listen(4318, '127.0.0.1', done); });
  const extension = resolve('dist/edge');
  context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true,
    viewport: { width: 1280, height: 1100 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const controls = await context.newPage();
  // Options has no GET_STATE polling timer, unlike the popup. This matters for
  // the service-worker idle check below.
  await controls.goto(`chrome-extension://${extensionId}/options.html`);
  const command = async (message: object) => {
    const result = await controls.evaluate(message => chrome.runtime.sendMessage(message), message);
    assert.equal(result.ok, true, result.error);
    return result;
  };
  const state = async (): Promise<SessionState> => (await command({ type: 'GET_STATE' })).state;
  const initial = await command({ type: 'GET_STATE' });
  assert.equal(initial.settings.backgroundMode, false, 'Background operation must remain opt-in.');
  await command({ type: 'SAVE_SETTINGS', settings: { ...initial.settings, connectionMode: 'bridge', bridgeToken: token, backgroundMode: true, mode: 'auto', requestLimit: 40 } });
  const practice = await context.newPage();
  await practice.goto('http://127.0.0.1:4318/practice');
  const decoy = await context.newPage();
  const decoyUrl = 'http://127.0.0.1:4318/background-test-decoy';
  await context.route(decoyUrl, route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html><head><title>Unrelated tab</title></head><body style="margin:0;background:#ff00ff;color:#000;min-height:100vh">UNRELATED MAGENTA TAB</body></html>' }));
  await decoy.goto(decoyUrl);
  const ids = await controls.evaluate(async ({ practiceUrl, decoyUrl }) => {
    const tabs = await chrome.tabs.query({});
    const practice = tabs.find(tab => tab.url === practiceUrl)!;
    const decoy = tabs.find(tab => tab.url === decoyUrl)!;
    return { monitored: practice.id!, decoy: decoy.id!, window: practice.windowId, autoDiscardable: practice.autoDiscardable };
  }, { practiceUrl: practice.url(), decoyUrl });
  const activeId = () => controls.evaluate(async windowId => (await chrome.tabs.query({ windowId, active: true }))[0]?.id, ids.window);
  const tabState = () => controls.evaluate(tabId => chrome.tabs.get(tabId), ids.monitored);
  const windowState = () => controls.evaluate(windowId => chrome.windows.get(windowId), ids.window);
  const submissions = () => practice.locator('#submission-count').textContent();
  const show = (index: number) => practice.evaluate(index => {
    (document.querySelector('#question-picker') as HTMLSelectElement).value = String(index);
    (document.querySelector('#show-question') as HTMLButtonElement).click();
  }, index);
  const repeat = () => practice.evaluate(() => (document.querySelector('#repeat-question') as HTMLButtonElement).click());
  const start = () => command({ type: 'START', tabId: ids.monitored });
  const assertDecoyActive = async () => assert.equal(await activeId(), ids.decoy, 'The extension must not switch to the monitored tab.');
  const waitSubmissions = (count: number) => eventually(submissions, value => value === String(count), `${count} confirmed submissions`);
  const assertDetached = async () => {
    // getTargets().attached also includes Playwright's separate CDP client.
    // Only an extension-owned connection can issue this harmless read command.
    const attached = await controls.evaluate(async tabId => {
      try { await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics'); return true; }
      catch { return false; }
    }, ids.monitored);
    assert.equal(attached, false, 'The extension debugger must be detached.');
  };

  delayMs = 1400;
  await practice.bringToFront();
  await start();
  await eventually(state, s => s.phase === 'solving', 'initial delayed solve');
  await eventually(async () => requests.length, count => count === 1, 'initial local request');
  const duplicateStart = await controls.evaluate(tabId => chrome.runtime.sendMessage({ type: 'START', tabId }), ids.monitored);
  assert.equal(duplicateStart.ok, false, 'A duplicate Start request must be rejected.');
  assert.equal((await state()).running, true, 'Rejecting duplicate Start must preserve the existing session.');
  assert.equal((await tabState()).autoDiscardable, false);
  await decoy.bringToFront();
  await waitSubmissions(1);
  await assertDecoyActive();
  assert.equal((await state()).running, true);
  assert.equal(requests.length, 1);
  passed('Switching tabs during a delayed response does not cancel or duplicate the answer');

  delayMs = 0;
  await show(1);
  await waitSubmissions(2);
  await assertDecoyActive();
  assert.equal(requests.length, 2);
  assert.match((await practice.locator('#submitted-detail').textContent())!, /2, 5/);
  passed('A new multiple-answer question is detected and submitted while another tab is active');

  await show(3);
  await waitSubmissions(3);
  await assertDecoyActive();
  assert.equal(requests.length, 3);
  const screenshot = requests.at(-1)?.screenshot;
  assert.ok(screenshot?.startsWith('data:image/png;base64,'), 'The hidden image question needs its own screenshot.');
  assert.ok(screenshot);
  const imagePixels = (source: string) => controls.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let blue = 0, red = 0, magenta = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] >= 55 && data[i] <= 100 && data[i + 1] >= 105 && data[i + 1] <= 150 && data[i + 2] >= 195 && data[i + 2] <= 235) blue++;
      if (data[i] >= 205 && data[i] <= 235 && data[i + 1] >= 60 && data[i + 1] <= 90 && data[i + 2] >= 45 && data[i + 2] <= 80) red++;
      if (data[i] > 240 && data[i + 1] < 15 && data[i + 2] > 240) magenta++;
    }
    return { width: image.width, height: image.height, blue, red, magenta };
  }, source);
  const pixels = await imagePixels(screenshot);
  assert.ok(pixels.blue > 3_000, `The blue practice triangle must be captured: ${JSON.stringify(pixels)}`);
  assert.equal(pixels.magenta, 0, 'The unrelated foreground tab must never appear in the solver image.');
  assert.ok(pixels.width > 300 && pixels.width < 1280 && pixels.height > 200 && pixels.height < 1100);
  passed('Hidden-tab screenshot contains the question image and excludes the active magenta tab', pixels);

  await controls.evaluate(windowId => chrome.windows.update(windowId, { state: 'minimized' }), ids.window);
  assert.equal((await windowState()).state, 'minimized');
  await practice.evaluate(() => {
    (document.querySelector('#question-picker') as HTMLSelectElement).value = '3';
    (document.querySelector('#show-question') as HTMLButtonElement).click();
    const image = document.querySelector('img.visual') as HTMLImageElement;
    const svg = decodeURIComponent(image.src.slice(image.src.indexOf(',') + 1));
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replaceAll('#4b80de', '#e04c40').replaceAll('#2451a1', '#9d2921'));
  });
  await waitSubmissions(4);
  const minimizedScreenshot = requests.at(-1)?.screenshot;
  assert.ok(minimizedScreenshot, 'A minimized image question must receive its own screenshot.');
  const minimizedPixels = await imagePixels(minimizedScreenshot);
  assert.ok(minimizedPixels.red > 3_000, 'Minimized screenshot must show the newly rendered red triangle.');
  assert.ok(minimizedPixels.blue < 50, 'Minimized screenshot must not reuse the previous blue triangle frame.');
  assert.equal(minimizedPixels.magenta, 0);
  assert.equal((await windowState()).state, 'minimized', 'The extension must leave the window minimized.');
  await assertDecoyActive();
  passed('An image question is captured and answered with the Edge window minimized', minimizedPixels);

  // Do not poll the extension or evaluate its worker during this idle interval.
  // It exceeds MV3's normal 30-second idle threshold.
  console.log('Checking 37 seconds of idle background monitoring without extension-page polling...');
  const beforeIdle = requests.length;
  await sleep(37_000);
  await show(0);
  await waitSubmissions(5);
  assert.equal(requests.length, beforeIdle + 1);
  assert.equal((await state()).running, true);
  assert.equal((await windowState()).state, 'minimized');
  await assertDecoyActive();
  passed('Monitoring survives more than 35 seconds idle and answers the next minimized question', { idleSeconds: 37 });

  delayMs = 2500;
  await repeat();
  await eventually(state, s => s.phase === 'solving', 'pending response before pause');
  const pendingCount = requests.length;
  await eventually(async () => requests.length, count => count > beforeIdle + 1, 'pending delayed request');
  await command({ type: 'PAUSE' });
  await eventually(async () => cancelled, count => count > 0, 'bridge request cancellation');
  await sleep(2700);
  assert.equal(await submissions(), '5');
  assert.equal((await state()).phase, 'paused');
  assert.equal((await tabState()).autoDiscardable, ids.autoDiscardable, 'Pause must restore the tab discard policy.');
  await assertDetached();
  const beforeResume = requests.length;
  await start();
  await sleep(1200);
  assert.equal(await submissions(), '5');
  assert.equal(requests.length, beforeResume, 'Resuming a cancelled question must not repeat its request.');
  assert.ok(pendingCount <= beforeResume);
  await assertDecoyActive();
  passed('Pause cancels pending work, detaches the debugger, restores discard policy, and prevents duplicate requests');

  delayMs = 0;
  const beforeDetachedQuestion = requests.length;
  // Programmatic detach from this extension does not fire Chrome's onDetach
  // event (browser cancellation does; covered by the coordinator unit test).
  // Exercise the independent capture-failure guard with the actual API here.
  await controls.evaluate(tabId => chrome.debugger.detach({ tabId }), ids.monitored);
  await show(3);
  await eventually(state, s => s.phase === 'paused' && !s.running, 'lost background capture connection pauses');
  assert.equal((await tabState()).autoDiscardable, ids.autoDiscardable);
  await repeat();
  await sleep(1000);
  assert.equal(await submissions(), '5');
  assert.equal(requests.length, beforeDetachedQuestion);
  passed('A lost background capture connection pauses without an AI request or foreground screenshot fallback');

  // Restore an original false value too, not just the normal true default.
  await controls.evaluate(tabId => chrome.tabs.update(tabId, { autoDiscardable: false }), ids.monitored);
  await start();
  await waitSubmissions(6);
  await command({ type: 'PAUSE' });
  assert.equal((await tabState()).autoDiscardable, false);
  await assertDetached();
  await controls.evaluate(({ tabId, value }) => chrome.tabs.update(tabId, { autoDiscardable: value }), { tabId: ids.monitored, value: ids.autoDiscardable });
  passed('Cleanup preserves a tab that already had automatic discarding disabled');

  await start();
  await practice.goto('http://127.0.0.1:4318/practice?background-navigation=1');
  await eventually(state, s => s.phase === 'paused' && !s.running, 'navigation pauses background session');
  await assertDetached();
  assert.equal((await tabState()).autoDiscardable, ids.autoDiscardable);
  await assertDecoyActive();
  assert.equal(await submissions(), '0');
  passed('Navigation stops monitoring and restores the monitored tab without changing the active tab');

  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/background-replay.json', JSON.stringify({ checkedAt: new Date().toISOString(), browser: 'Microsoft Edge',
    browserVersion: context.browser()!.version(), headless: true, minimizedStateVerified: true, liveWooclap: false,
    realOpenAI: false, localRequests: requests.length, cancellations: cancelled, results }, null, 2) + '\n');
  console.log(`Background replay passed in Microsoft Edge: ${results.length} checks, ${requests.length} local requests, zero real API calls.`);
} finally {
  await context?.close();
  await new Promise<void>(done => bridge.close(() => done()));
  const absolute = resolve(profile);
  if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('wooclap-background-test-')) await rm(absolute, { recursive: true, force: true }).catch(() => undefined);
}
