import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundTab } from '../src/background-tab';

type Call = { api: string; tabId?: number; method?: string; params?: Record<string, unknown> };
type RecordValue = { tabId: number; autoDiscardable: boolean };
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');

afterEach(() => {
  if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
  else Reflect.deleteProperty(globalThis, 'chrome');
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function mockChrome(options: { autoDiscardable?: boolean; saved?: RecordValue; attached?: number } = {}) {
  const calls: Call[] = [];
  const storage: Record<string, unknown> = options.saved ? { backgroundTab: structuredClone(options.saved) } : {};
  const discardable = new Map<number, boolean>([[7, options.autoDiscardable ?? true], [8, true]]);
  const attached = new Set<number>(options.attached === undefined ? [] : [options.attached]);
  const hooks: {
    attach?: (tabId: number) => Promise<void>;
    detach?: (tabId: number) => Promise<void>;
    command?: (method: string, params: Record<string, unknown>) => Promise<void>;
  } = {};
  const chromeMock = {
    permissions: { async contains() { return true; } },
    storage: { session: {
      async get(key: string | string[]) {
        calls.push({ api: 'storage.get' });
        const result: Record<string, unknown> = {};
        for (const name of typeof key === 'string' ? [key] : key) {
          if (name in storage) result[name] = structuredClone(storage[name]);
        }
        return result;
      },
      async set(values: Record<string, unknown>) {
        calls.push({ api: 'storage.set', params: structuredClone(values) });
        Object.assign(storage, structuredClone(values));
      },
      async remove(key: string | string[]) {
        calls.push({ api: 'storage.remove' });
        for (const name of typeof key === 'string' ? [key] : key) delete storage[name];
      }
    } },
    tabs: {
      async get(tabId: number) {
        calls.push({ api: 'tabs.get', tabId });
        return { id: tabId, autoDiscardable: discardable.get(tabId), url: 'https://app.wooclap.com/events/TEST', active: false };
      },
      async update(tabId: number, params: Record<string, unknown>) {
        calls.push({ api: 'tabs.update', tabId, params: structuredClone(params) });
        assert.equal(params.active, undefined, 'Background monitoring must never activate the tab.');
        if (typeof params.autoDiscardable === 'boolean') discardable.set(tabId, params.autoDiscardable);
        return { id: tabId, autoDiscardable: discardable.get(tabId) };
      }
    },
    debugger: {
      async attach(target: { tabId: number }, version: string) {
        calls.push({ api: 'debugger.attach', tabId: target.tabId, params: { version } });
        await hooks.attach?.(target.tabId);
        if (attached.has(target.tabId)) throw new Error('Another debugger is already attached.');
        attached.add(target.tabId);
      },
      async detach(target: { tabId: number }) {
        calls.push({ api: 'debugger.detach', tabId: target.tabId });
        await hooks.detach?.(target.tabId);
        attached.delete(target.tabId);
      },
      async sendCommand(target: { tabId: number }, method: string, params: Record<string, unknown> = {}) {
        calls.push({ api: 'debugger.sendCommand', tabId: target.tabId, method, params: structuredClone(params) });
        if (!attached.has(target.tabId)) throw new Error('Debugger is not attached.');
        await hooks.command?.(method, params);
        return method === 'Page.captureScreenshot' ? { data: 'c3ludGhldGljLXBuZw==' } : {};
      }
    }
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: chromeMock });
  return { calls, storage, discardable, attached, hooks };
}

for (const original of [true, false]) {
  test(`background session restores original autoDiscardable=${original} and detaches on release`, async () => {
    const mock = mockChrome({ autoDiscardable: original });
    const session = new BackgroundTab();
    await session.acquire(7, () => {});
    assert.equal(session.owns(7), true);
    assert.equal(session.owns(8), false);
    assert.equal(mock.discardable.get(7), false);
    assert.deepEqual(mock.storage.backgroundTab, { tabId: 7, autoDiscardable: original });
    assert.ok(mock.calls.some(call => call.method === 'Emulation.setFocusEmulationEnabled' && call.params?.enabled === true));
    await session.release();
    assert.equal(session.owns(7), false);
    assert.equal(mock.attached.size, 0);
    assert.equal(mock.discardable.get(7), original);
    assert.equal(mock.storage.backgroundTab, undefined);
    const count = mock.calls.length;
    await session.release();
    assert.equal(mock.calls.length, count, 'Releasing an idle session must not modify another tab.');
  });
}

test('failed debugger attach leaves the tab state unchanged and removes cleanup metadata', async () => {
  const mock = mockChrome();
  mock.hooks.attach = async () => { throw new Error('Debugger access blocked.'); };
  const session = new BackgroundTab();
  await assert.rejects(session.acquire(7, () => {}));
  assert.equal(session.owns(7), false);
  assert.equal(mock.attached.size, 0);
  assert.equal(mock.discardable.get(7), true);
  assert.equal(mock.storage.backgroundTab, undefined);
  assert.equal(mock.calls.some(call => call.method === 'Emulation.setFocusEmulationEnabled' && call.params?.enabled === true), false);
});

test('focus setup failure rolls back debugger attachment and discard protection', async () => {
  const mock = mockChrome();
  mock.hooks.command = async (method, params) => {
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === true) throw new Error('Focus emulation unavailable.');
  };
  const session = new BackgroundTab();
  await assert.rejects(session.acquire(7, () => {}));
  assert.equal(session.owns(7), false);
  assert.equal(mock.attached.size, 0);
  assert.equal(mock.discardable.get(7), true);
  assert.equal(mock.storage.backgroundTab, undefined);
});

test('pause during an in-flight attach cancels setup before focus emulation and detaches', async () => {
  const mock = mockChrome();
  const entered = deferred();
  const finish = deferred();
  mock.hooks.attach = async () => { entered.resolve(); await finish.promise; };
  let canceled = false;
  const session = new BackgroundTab();
  const pending = session.acquire(7, () => { if (canceled) throw new Error('Session paused.'); });
  const rejected = assert.rejects(pending);
  await entered.promise;
  canceled = true;
  finish.resolve();
  await rejected;
  assert.equal(session.owns(7), false);
  assert.equal(mock.attached.size, 0);
  assert.equal(mock.discardable.get(7), true);
  assert.equal(mock.storage.backgroundTab, undefined);
  assert.equal(mock.calls.some(call => call.method === 'Emulation.setFocusEmulationEnabled' && call.params?.enabled === true), false);
});

test('a new acquire waits for earlier release cleanup before attaching a different tab', async () => {
  const mock = mockChrome();
  const session = new BackgroundTab();
  await session.acquire(7, () => {});
  const entered = deferred();
  const finish = deferred();
  mock.hooks.detach = async tabId => { if (tabId === 7) { entered.resolve(); await finish.promise; } };
  const releasing = session.release();
  await entered.promise;
  const acquiring = session.acquire(8, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mock.calls.some(call => call.api === 'debugger.attach' && call.tabId === 8), false);
  finish.resolve();
  await releasing;
  await acquiring;
  assert.equal(mock.discardable.get(7), true);
  assert.equal(session.owns(7), false);
  assert.equal(session.owns(8), true);
  assert.deepEqual(mock.storage.backgroundTab, { tabId: 8, autoDiscardable: true });
  await session.release();
});

test('startup recovery detaches a stale session and restores its tab without resuming', async () => {
  const mock = mockChrome({ autoDiscardable: false, attached: 7, saved: { tabId: 7, autoDiscardable: true } });
  const session = new BackgroundTab();
  await session.recover();
  assert.equal(session.owns(7), false);
  assert.equal(mock.attached.size, 0);
  assert.equal(mock.discardable.get(7), true);
  assert.equal(mock.storage.backgroundTab, undefined);
  assert.equal(mock.calls.some(call => call.api === 'debugger.attach'), false);
  assert.equal(mock.calls.some(call => call.method === 'Emulation.setFocusEmulationEnabled' && call.params?.enabled === true), false);
});

test('capture targets only the owned tab and never activates it or captures beyond its viewport', async () => {
  const mock = mockChrome();
  const session = new BackgroundTab();
  await assert.rejects(session.capture(7));
  await session.acquire(7, () => {});
  await assert.rejects(session.capture(8));
  assert.equal(await session.capture(7), 'data:image/png;base64,c3ludGhldGljLXBuZw==');
  const captures = mock.calls.filter(call => call.method === 'Page.captureScreenshot');
  assert.equal(captures.length, 1);
  assert.equal(captures[0].tabId, 7);
  assert.deepEqual(captures[0].params, { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await session.release();
});

test('external debugger detach prevents capture and preserves cleanup until release', async () => {
  const mock = mockChrome();
  const session = new BackgroundTab();
  await session.acquire(7, () => {});
  assert.equal(session.handleDetach(8), false);
  assert.equal(session.owns(7), true);
  mock.attached.delete(7);
  assert.equal(session.handleDetach(7), true);
  assert.equal(session.owns(7), false);
  assert.deepEqual(mock.storage.backgroundTab, { tabId: 7, autoDiscardable: true });
  await assert.rejects(session.capture(7));
  await session.release();
  assert.equal(mock.discardable.get(7), true);
  assert.equal(mock.storage.backgroundTab, undefined);
});

test('a screenshot completing after external detach cannot be used as current pixels', async () => {
  const mock = mockChrome();
  const session = new BackgroundTab();
  await session.acquire(7, () => {});
  const entered = deferred();
  const finish = deferred();
  mock.hooks.command = async method => {
    if (method === 'Page.captureScreenshot') { entered.resolve(); await finish.promise; }
  };
  const capture = session.capture(7);
  const rejected = assert.rejects(capture);
  await entered.promise;
  mock.attached.delete(7);
  assert.equal(session.handleDetach(7), true);
  finish.resolve();
  await rejected;
  await session.release();
  assert.equal(mock.discardable.get(7), true);
});

test('reconnecting the same tab cannot make an earlier session screenshot current', async () => {
  const mock = mockChrome();
  const session = new BackgroundTab();
  await session.acquire(7, () => {});
  const entered = deferred();
  const finish = deferred();
  mock.hooks.command = async method => {
    if (method === 'Page.captureScreenshot') { entered.resolve(); await finish.promise; }
  };
  const capture = session.capture(7);
  const rejected = assert.rejects(capture);
  await entered.promise;
  await session.release();
  await session.acquire(7, () => {});
  assert.equal(session.owns(7), true);
  finish.resolve();
  await rejected;
  assert.equal(session.owns(7), true, 'Rejecting old pixels must leave the new session attached.');
  await session.release();
});
