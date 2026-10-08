import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS } from '../src/shared/types';

const bundle = build({ entryPoints: ['src/background.ts'], bundle: true, format: 'iife', write: false })
  .then(result => result.outputFiles[0].text);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function event() {
  const listeners: ((...args: any[]) => any)[] = [];
  return { addListener: (listener: (...args: any[]) => any) => listeners.push(listener),
    emit: (...args: any[]) => listeners.forEach(listener => listener(...args)) };
}

async function harness() {
  const onMessage = event(), onUpdated = event(), onDetach = event();
  const sent: string[] = [];
  const stored: Record<string, any> = {};
  const initial = { ...DEFAULT_SETTINGS, backgroundMode: true, bridgeToken: 'synthetic-test-token' };
  const tab = { id: 7, windowId: 1, url: 'http://127.0.0.1:4318/practice', active: true, autoDiscardable: true };
  let attached = false, healthCalls = 0, releaseHealth: (() => void) | undefined;
  let holdHealth = false;
  const storage = (data: Record<string, any>) => ({
    setAccessLevel: async () => {},
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])),
    set: async (values: object) => { Object.assign(data, structuredClone(values)); },
    remove: async (key: string) => { delete data[key]; }
  });
  const mock = {
    runtime: { id: 'fixture', getURL: (path: string) => `chrome-extension://fixture/${path}`, onMessage },
    storage: { local: storage({ settings: initial }), session: storage(stored) },
    permissions: { contains: async () => true },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { get: async () => ({ ...tab }), update: async (_: number, changes: object) => Object.assign(tab, changes),
      sendMessage: async (_: number, message: { type: string }) => { sent.push(message.type); return { ok: true }; },
      onUpdated, onRemoved: event(), onActivated: event() },
    windows: { get: async () => ({ state: 'normal' }) },
    scripting: { executeScript: async () => {} },
    debugger: { onDetach, attach: async () => { attached = true; }, detach: async () => { attached = false; }, sendCommand: async () => ({}) }
  };
  const context = createContext({ chrome: mock, URL, structuredClone, crypto: { randomUUID }, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async () => {
      healthCalls++;
      if (holdHealth) await new Promise<void>(resolve => { releaseHealth = resolve; });
      return { ok: true, json: async () => ({ ready: true, demo: true, protocolVersion: 2 }) };
    } });
  runInContext(await bundle, context);
  const message = (message: object): Promise<any> => new Promise(resolve => onMessage.emit(message,
    { id: 'fixture', url: 'chrome-extension://fixture/options.html' }, resolve));
  assert.equal((await message({ type: 'GET_STATE' })).ok, true);
  return { message, tab, sent, onUpdated, onDetach, initial, attached: () => attached,
    hold: () => { holdHealth = true; }, release: () => releaseHealth!(),
    waitHealth: async () => { for (let i = 0; i < 20 && !healthCalls; i++) await flush(); assert.equal(healthCalls, 1); } };
}

for (const action of ['pause', 'settings', 'navigation']) {
  test(`${action} during bridge startup prevents background attachment and monitoring`, async () => {
    const h = await harness(); h.hold();
    const starting = h.message({ type: 'START', tabId: 7 });
    await h.waitHealth();
    if (action === 'pause') await h.message({ type: 'PAUSE' });
    else if (action === 'settings') await h.message({ type: 'SAVE_SETTINGS', settings: { ...h.initial, backgroundMode: false } });
    else { h.tab.url = 'https://example.com/'; h.onUpdated.emit(7, { status: 'loading' }); await flush(); }
    h.release();
    assert.equal((await starting).ok, false);
    assert.equal(h.attached(), false);
    assert.equal(h.tab.autoDiscardable, true);
    assert.equal(h.sent.includes('MONITOR_START'), false);
    assert.equal((await h.message({ type: 'GET_STATE' })).state.running, false);
  });
}

test('a duplicate Start leaves the existing background session running', async () => {
  const h = await harness();
  assert.equal((await h.message({ type: 'START', tabId: 7 })).ok, true);
  assert.equal((await h.message({ type: 'START', tabId: 7 })).ok, false);
  assert.equal((await h.message({ type: 'GET_STATE' })).state.running, true);
  assert.equal(h.attached(), true);
  assert.equal(h.sent.filter(type => type === 'MONITOR_START').length, 1);
  await h.message({ type: 'PAUSE' });
});

test('browser debugger cancellation immediately pauses the monitored session and restores its tab', async () => {
  const h = await harness();
  await h.message({ type: 'START', tabId: 7 });
  h.onDetach.emit({ tabId: 7 }, 'canceled_by_user');
  const state = (await h.message({ type: 'GET_STATE' })).state;
  assert.equal(state.running, false);
  assert.equal(state.phase, 'paused');
  await h.message({ type: 'PAUSE' });
  assert.equal(h.tab.autoDiscardable, true);
  assert.ok(h.sent.includes('MONITOR_STOP'));
});
