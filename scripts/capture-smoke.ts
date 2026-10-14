import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { createBridgeServer } from '../server/http';
import { demoSolver } from '../server/solver';
import type { SolveRequest } from '../src/shared/types';

const token = randomBytes(32).toString('hex');
let captured: SolveRequest | undefined;
const bridge = createBridgeServer({ token, demo: true, solver: async (request, signal) => {
  captured = request;
  return demoSolver(request, signal);
} });
const profile = await mkdtemp(join(tmpdir(), 'wooclap-capture-test-'));
let context;
try {
  await new Promise<void>((done, reject) => { bridge.once('error', reject); bridge.listen(4318, '127.0.0.1', done); });
  const extensionPath = resolve('dist/edge');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true, viewport: { width: 1280, height: 1100 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--enable-unsafe-extension-debugging']
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const controls = await context.newPage();
  await controls.goto(`chrome-extension://${id}/options.html`);
  const command = (message: object) => controls.evaluate(message => chrome.runtime.sendMessage(message), message);
  const original = await command({ type: 'GET_STATE' });
  assert.ok((await command({ type: 'SAVE_SETTINGS', settings: { ...original.settings, connectionMode: 'bridge', bridgeToken: token } })).ok);
  const practice = await context.newPage();
  await practice.goto('http://127.0.0.1:4318/practice');
  await practice.locator('#question-picker').selectOption('3');
  await practice.locator('#show-question').click();
  // Trigger the actual extension toolbar action, which grants activeTab for
  // screenshots. The debugging flag belongs only to this isolated test profile.
  const browserCdp = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const tabTarget = targetInfos.find(target => target.url === practice.url());
  assert.ok(tabTarget, 'The practice tab target must be present.');
  await browserCdp.send('Extensions.triggerAction', { id, targetId: tabTarget.targetId });
  const tabId = await controls.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:4318/practice' }))[0].id!);
  await practice.bringToFront();
  assert.ok((await command({ type: 'START', tabId })).ok);
  let session;
  for (let i = 0; i < 100; i++) {
    session = (await command({ type: 'GET_STATE' })).state;
    if (session.phase === 'suggestion' || session.phase === 'error') break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert.equal(session.phase, 'suggestion', session.detail);
  const screenshot = captured?.screenshot;
  assert.ok(screenshot?.startsWith('data:image/png;base64,'), 'solver must receive cropped pixels');
  assert.ok(screenshot);
  const png = Buffer.from(screenshot.split(',')[1], 'base64');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.ok(width > 300 && width < 1280, `crop width ${width}`);
  assert.ok(height > 200 && height < 1100, `crop height ${height}`);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/question-crop.png', png);
  assert.ok((await command({ type: 'APPROVE' })).ok);
  assert.equal(await practice.locator('#submission-count').textContent(), '1');
  console.log(`PASS: Microsoft Edge activeTab capture, ${width}x${height} crop, image answer and confirmed submission. Zero real API calls.`);
} finally {
  await context?.close();
  await new Promise<void>(done => bridge.close(() => done()));
  const absolute = resolve(profile);
  if (absolute.startsWith(resolve(tmpdir()) + '\\') && absolute.includes('wooclap-capture-test-')) await rm(absolute, { recursive: true, force: true }).catch(() => undefined);
}
