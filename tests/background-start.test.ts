import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types';

const bundle = build({ entryPoints: ['src/background.ts'], bundle: true, format: 'iife', write: false })
  .then(result => result.outputFiles[0].text);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function event() {
  const listeners: ((...args: any[]) => any)[] = [];
  return { addListener: (listener: (...args: any[]) => any) => listeners.push(listener),
    emit: (...args: any[]) => listeners.forEach(listener => listener(...args)) };
}

async function harness(options: { settings?: Partial<Settings>; health?: object; onStop?: () => Promise<void> } = {}) {
  const onMessage = event(), onUpdated = event(), onDetach = event(), onAlarm = event(), onRemoved = event();
  const sent: string[] = [];
  const messages: { tabId: number; message: any }[] = [];
  const created: number[] = [], removed: number[] = [];
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const stored: Record<string, any> = {};
  const initial = { ...DEFAULT_SETTINGS, provider: 'openai', model: 'gpt-4.1-mini', connectionMode: 'bridge', backgroundMode: true, bridgeToken: 'synthetic-test-token', ...options.settings };
  const local: Record<string, any> = { settings: initial };
  const tab = { id: 7, windowId: 1, url: 'http://127.0.0.1:4318/practice', active: true, autoDiscardable: true, status: 'complete' };
  const tabs = new Map<number, typeof tab>([[tab.id, tab]]);
  let nextTabId = 8, createGate: Promise<void> | undefined;
  let attached = false, healthCalls = 0, releaseHealth: (() => void) | undefined;
  let holdHealth = false;
  const storage = (data: Record<string, any>) => ({
    setAccessLevel: async () => {},
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])),
    set: async (values: object) => { Object.assign(data, structuredClone(values)); },
    remove: async (key: string) => { delete data[key]; }
  });
  const mock = {
    runtime: { id: 'fixture', getURL: (path: string) => `chrome-extension://fixture/${path}`, onMessage, onStartup: event() },
    alarms: { onAlarm, create: async () => {}, clear: async () => true },
    storage: { local: storage(local), session: storage(stored) },
    permissions: { contains: async () => true },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { get: async (id: number) => {
        const current = tabs.get(id);
        if (!current) throw new Error('No tab with this ID.');
        return { ...current };
      }, update: async (id: number, changes: object) => {
        const current = tabs.get(id);
        if (!current) throw new Error('No tab with this ID.');
        return Object.assign(current, changes);
      }, create: async (properties: { url: string; active: boolean }) => {
        const id = nextTabId++;
        created.push(id);
        await createGate;
        const current = { ...tab, id, ...properties };
        tabs.set(id, current);
        return { ...current };
      }, remove: async (id: number) => { removed.push(id); tabs.delete(id); onRemoved.emit(id); },
      sendMessage: async (tabId: number, message: { type: string }) => {
        sent.push(message.type);
        messages.push({ tabId, message: structuredClone(message) });
        if (message.type === 'MONITOR_STOP') await options.onStop?.();
        return { ok: true };
      },
      onUpdated, onRemoved, onActivated: event() },
    windows: { get: async () => ({ state: 'normal' }) },
    scripting: { executeScript: async () => {} },
    debugger: { onDetach, attach: async () => { attached = true; }, detach: async () => { attached = false; }, sendCommand: async () => ({}) }
  };
  const context = createContext({ chrome: mock, URL, Date: Clock, structuredClone, crypto: { randomUUID }, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async () => {
      healthCalls++;
      if (holdHealth) await new Promise<void>(resolve => { releaseHealth = resolve; });
      return { ok: true, json: async () => options.health ?? ({ ready: true, demo: true, protocolVersion: 2 }) };
    } });
  runInContext(await bundle, context);
  const message = (message: object): Promise<any> => new Promise(resolve => onMessage.emit(message,
    { id: 'fixture', url: 'chrome-extension://fixture/options.html' }, resolve));
  assert.equal((await message({ type: 'GET_STATE' })).ok, true);
  const content = (message: object): Promise<any> => new Promise(resolve => onMessage.emit(message,
    { id: 'fixture', url: tab.url, tab, frameId: 0 }, resolve));
  return { message, content, local, stored, tab, tabs, sent, messages, created, removed, onUpdated, onDetach, initial, attached: () => attached,
    now: () => now,
    alarm: (time: number) => { now = time; onAlarm.emit({ name: 'wooclap-schedule:watchdog' }); },
    holdCreate: (gate: Promise<void>) => { createGate = gate; },
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

const providerHealth = { ready: false, demo: false, protocolVersion: 2, acceptsClientKeys: true,
  providers: { openai: { ready: false }, anthropic: { ready: false } } };

test('Claude starts with a session key even when the bridge has no environment keys', async () => {
  const h = await harness({ settings: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, health: providerHealth });
  assert.equal((await h.message({ type: 'CHECK_BRIDGE' })).health.ready, false);
  const saved = await h.message({ type: 'SAVE_API_KEY', provider: 'anthropic', apiKey: 'test-claude-key', remember: false });
  assert.equal(saved.ok, true);
  assert.equal(saved.credentials.anthropic.storage, 'session');
  assert.equal(h.local['apiKey.anthropic'], undefined);
  assert.equal((await h.message({ type: 'CHECK_BRIDGE' })).health.ready, true);
  assert.equal((await h.message({ type: 'START', tabId: 7 })).ok, true);
  const response = await h.message({ type: 'GET_STATE' });
  assert.equal(response.state.bridgeMode, 'anthropic');
  assert.ok(!JSON.stringify(response).includes('test-claude-key'));
  await h.message({ type: 'CLEAR_API_KEY', provider: 'anthropic' });
  assert.equal((await h.message({ type: 'GET_STATE' })).state.running, false);
  assert.equal((await h.message({ type: 'CHECK_BRIDGE' })).health.ready, false);
});

test('content scripts cannot read or mutate keys and remembered storage requires permission', async () => {
  const h = await harness();
  const saved = await h.message({ type: 'SAVE_API_KEY', provider: 'openai', apiKey: 'test-private-key', remember: true, consent: false });
  assert.equal(saved.ok, false);
  assert.equal(h.local['apiKey.openai'], undefined);
  assert.equal(h.stored['apiKey.openai'], undefined);
  await h.message({ type: 'SAVE_API_KEY', provider: 'openai', apiKey: 'test-private-key', remember: true, consent: true });
  for (const request of [{ type: 'GET_STATE' }, { type: 'CLEAR_API_KEY', provider: 'openai' },
    { type: 'SAVE_API_KEY', provider: 'openai', apiKey: 'test-overwrite', remember: true, consent: true }]) {
    const response = await h.content(request);
    assert.ok(!JSON.stringify(response).includes('test-private-key'));
    assert.equal(response.credentials, undefined);
    assert.equal(response.settings, undefined);
    assert.equal(h.local['apiKey.openai'], 'test-private-key');
  }
});

test('forgetting a key cancels in-progress startup and legacy bridges refuse extension keys', async () => {
  const h = await harness({ settings: { provider: 'anthropic' }, health: providerHealth });
  await h.message({ type: 'SAVE_API_KEY', provider: 'anthropic', apiKey: 'test-key' });
  h.hold();
  const starting = h.message({ type: 'START', tabId: 7 });
  await h.waitHealth();
  await h.message({ type: 'CLEAR_API_KEY', provider: 'anthropic' });
  h.release();
  assert.equal((await starting).ok, false);
  assert.equal(h.sent.includes('MONITOR_START'), false);
  const old = await harness({ health: { ready: true, demo: false, protocolVersion: 2 } });
  assert.equal((await old.message({ type: 'CHECK_BRIDGE' })).health.ready, true);
  await old.message({ type: 'SAVE_API_KEY', provider: 'openai', apiKey: 'test-key' });
  assert.match((await old.message({ type: 'START', tabId: 7 })).error, /updated local bridge/);
});

test('Forget stays after Save even when the first key change waits for tab cleanup', async () => {
  let release!: () => void, stops = 0;
  const delayedStop = new Promise<void>(resolve => { release = resolve; });
  const h = await harness({ onStop: async () => { if (++stops === 1) await delayedStop; } });
  await h.message({ type: 'START', tabId: 7 });
  const saved = h.message({ type: 'SAVE_API_KEY', provider: 'openai', apiKey: 'test-delayed-key', remember: true, consent: true });
  const forgotten = h.message({ type: 'CLEAR_API_KEY', provider: 'openai' });
  for (let i = 0; i < 20 && !stops; i++) await flush();
  assert.equal(stops, 1);
  assert.match((await h.message({ type: 'START', tabId: 7 })).error, /key change/);
  release();
  assert.equal((await saved).ok, true);
  assert.equal((await forgotten).ok, true);
  assert.equal(h.local['apiKey.openai'], undefined);
  assert.equal(h.stored['apiKey.openai'], undefined);
  assert.equal((await h.message({ type: 'GET_STATE' })).credentials.openai.configured, false);
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

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await flush();
  }
  assert.fail('The expected background transition did not finish.');
}

async function schedule(h: Awaited<ReturnType<typeof harness>>) {
  const response = await h.message({ type: 'ADD_SCHEDULE', url: 'https://app.wooclap.com/ABCDEF',
    startsAt: h.now() + 60_000, durationMinutes: 30, mode: 'auto' });
  assert.equal(response.ok, true, response.error);
  return response.schedules[0];
}

test('scheduled sessions override mode and background behavior without mutating saved settings, then close only their tab', async () => {
  const h = await harness({ settings: { backgroundMode: false, mode: 'suggest' },
    health: { ready: true, demo: false, protocolVersion: 2 } });
  const job = await schedule(h);
  h.alarm(job.startsAt);
  await waitFor(async () => (await h.message({ type: 'GET_SCHEDULES' })).schedules[0].status !== 'starting'
    && h.created.length === 1);
  const scheduled = (await h.message({ type: 'GET_SCHEDULES' })).schedules[0];
  assert.equal(scheduled.status, 'running', scheduled.detail);
  const current = await h.message({ type: 'GET_STATE' });
  assert.equal(current.state.running, true);
  assert.equal(current.state.mode, 'auto');
  assert.equal(current.state.backgroundMode, true);
  assert.equal(current.state.scheduleId, job.id);
  assert.equal(current.state.endsAt, job.endsAt);
  assert.equal(current.settings.mode, 'suggest');
  assert.equal(current.settings.backgroundMode, false);
  assert.equal(h.local.settings.mode, 'suggest');
  assert.equal(h.local.settings.backgroundMode, false);
  const monitor = h.messages.find(entry => entry.message.type === 'MONITOR_START');
  assert.equal(monitor?.tabId, 8);
  assert.equal(monitor?.message.backgroundMode, true);
  assert.equal(monitor?.message.endsAt, job.endsAt);
  assert.equal(h.tabs.get(8)?.active, false);
  assert.equal(h.attached(), true);

  h.alarm(job.endsAt);
  await waitFor(() => h.removed.includes(8));
  assert.equal((await h.message({ type: 'GET_STATE' })).state.running, false);
  assert.equal((await h.message({ type: 'GET_SCHEDULES' })).schedules[0].status, 'completed');
  assert.equal(h.attached(), false);
  assert.ok(h.tabs.has(7));
  assert.deepEqual(h.removed, [8]);
});

for (const action of ['pause', 'settings', 'credentials']) {
  test(`${action} during scheduled tab creation prevents a later automatic start`, async () => {
    const h = await harness({ health: { ready: true, demo: false, protocolVersion: 2 } });
    let release!: () => void;
    h.holdCreate(new Promise<void>(resolve => { release = resolve; }));
    const job = await schedule(h);
    h.alarm(job.startsAt);
    await waitFor(() => h.created.length === 1);
    if (action === 'pause') await h.message({ type: 'PAUSE' });
    else if (action === 'settings') await h.message({ type: 'SAVE_SETTINGS', settings: { ...h.initial, mode: 'auto' } });
    else await h.message({ type: 'CLEAR_API_KEY', provider: 'openai' });
    release();
    await waitFor(async () => (await h.message({ type: 'GET_SCHEDULES' })).schedules[0].status === 'failed');
    assert.equal(h.sent.includes('MONITOR_START'), false);
    assert.equal(h.attached(), false);
    assert.equal((await h.message({ type: 'GET_STATE' })).state.running, false);
    assert.equal((await h.message({ type: 'CANCEL_SCHEDULE', id: job.id })).ok, true);
    assert.deepEqual(h.removed, [8]);
    assert.ok(h.tabs.has(7));
  });
}

test('pausing an active schedule updates its status and alarms never resume it', async () => {
  const h = await harness({ health: { ready: true, demo: false, protocolVersion: 2 } });
  const job = await schedule(h);
  h.alarm(job.startsAt);
  await waitFor(async () => (await h.message({ type: 'GET_SCHEDULES' })).schedules[0].status === 'running');
  await h.message({ type: 'PAUSE' });
  assert.equal((await h.message({ type: 'GET_SCHEDULES' })).schedules[0].status, 'failed');
  h.alarm(job.startsAt + 60_000);
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(h.sent.filter(type => type === 'MONITOR_START').length, 1);
  assert.equal((await h.message({ type: 'GET_STATE' })).state.running, false);
  assert.ok(h.tabs.has(8));
  h.alarm(job.endsAt);
  await waitFor(() => h.removed.includes(8));
});

test('participant content cannot inspect, create, or cancel schedules', async () => {
  const h = await harness();
  const job = await schedule(h);
  for (const request of [{ type: 'GET_SCHEDULES' }, { type: 'CANCEL_SCHEDULE', id: job.id }, { type: 'REMOVE_SCHEDULE', id: job.id },
    { type: 'ADD_SCHEDULE', url: 'https://app.wooclap.com/ABCDEF', startsAt: job.endsAt + 60_000,
      durationMinutes: 10, mode: 'auto' }]) {
    const reply = await h.content(request);
    assert.equal(reply.ok, false);
    assert.equal(reply.schedules, undefined);
  }
  const remaining = (await h.message({ type: 'GET_SCHEDULES' })).schedules;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].status, 'pending');
  assert.equal(h.created.length, 0);
});
