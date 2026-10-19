import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionScheduler, SCHEDULE_ALARM_PREFIX } from '../src/scheduler';
import { newSchedule, scheduleUrl, type ScheduledSession } from '../src/shared/schedules';

const NOW = 1_800_000_000_000;
const LINK = 'https://app.wooclap.com/ABCDEF';
const input = (startsAt = NOW + 60_000, durationMinutes = 30) => ({ url: LINK, startsAt, durationMinutes, mode: 'auto' as const });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() {
  // Let the intentionally detached tab launch finish without advancing wall time.
  for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve));
}
function fixture(saved: unknown[] = [], ownership: Record<string, number> = {}) {
  let now = NOW, busy = false, nextTabId = 10, runtimeGeneration = 0;
  let createFailure = false;
  let createGate: Promise<void> | undefined;
  let startGate: Promise<void> | undefined;
  let getGate: Promise<void> | undefined;
  const local: Record<string, any> = { schedules: structuredClone(saved) };
  const session: Record<string, any> = { scheduleTabs: { ...ownership } };
  const storage = (data: Record<string, any>) => ({
    get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
    set: async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }
  });
  const tabs = new Map<number, { id: number; url: string; status: string; pendingUrl?: string }>();
  const created: unknown[] = [], removed: number[] = [], starts: number[] = [], stops: number[] = [], monitoring: number[] = [];
  const createdWindows: unknown[] = [], guardSnapshots: number[] = [];
  const alarms = new Map<string, chrome.alarms.AlarmCreateInfo>();
  const api = {
    storage: { local: storage(local), session: storage(session) },
    alarms: {
      create: async (name: string, options: chrome.alarms.AlarmCreateInfo) => { alarms.set(name, options); },
      clear: async (name: string) => alarms.delete(name)
    },
    tabs: {
      create: async (options: { url: string }) => {
        created.push(options);
        await createGate;
        if (createFailure) throw new Error('No browser window exists.');
        const tab = { id: nextTabId++, url: options.url, status: 'complete' };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      get: async (id: number) => {
        await getGate;
        const tab = tabs.get(id);
        if (!tab) throw new Error('No tab with this ID.');
        return { ...tab };
      },
      update: async (id: number, options: { url: string }) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('No tab with this ID.');
        Object.assign(tab, options);
        return { ...tab };
      },
      remove: async (id: number) => { removed.push(id); tabs.delete(id); }
    },
    windows: {
      create: async (options: { url: string }) => {
        createdWindows.push(options);
        const tab = { id: nextTabId++, url: options.url, status: 'complete' };
        tabs.set(tab.id, tab);
        return { id: 50, tabs: [{ ...tab }] };
      }
    }
  };
  const scheduler = new SessionScheduler({
    busy: () => busy,
    guard: () => {
      const generation = runtimeGeneration;
      guardSnapshots.push(generation);
      return () => {
        if (generation !== runtimeGeneration) throw new Error('Runtime session was paused or replaced.');
      };
    },
    start: async (tabId, _job, guard) => {
      starts.push(tabId);
      await startGate;
      guard();
      monitoring.push(tabId);
    },
    stop: async tabId => { stops.push(tabId); }
  }, api as unknown as typeof chrome, () => now);
  return { scheduler, api, local, session, tabs, created, createdWindows, removed, starts, stops, monitoring, alarms, guardSnapshots,
    setNow: (value: number) => { now = value; },
    setBusy: (value: boolean) => { busy = value; },
    invalidateRuntime: () => { runtimeGeneration++; },
    failTabCreate: () => { createFailure = true; },
    holdCreate: (gate: Promise<void>) => { createGate = gate; },
    holdGet: (gate: Promise<void>) => { getGate = gate; },
    holdStart: (gate: Promise<void>) => { startGate = gate; }
  };
}

test('schedules allow HTTPS Wooclap links and reject unsafe or lookalike destinations', () => {
  assert.equal(scheduleUrl(LINK), LINK);
  assert.equal(scheduleUrl('https://wooclap.com/ABCDEF?foo=bar'), 'https://wooclap.com/ABCDEF?foo=bar');
  for (const url of [undefined, 1, '', 'ABCDEF', 'http://wooclap.com/ABCDEF', 'file:///wooclap.com',
    'javascript:alert(1)', 'https://wooclap.com.evil.example/ABCDEF', 'https://fakewooclap.com/ABCDEF',
    'https://wooclap.com@evil.example', 'https://user:secret@wooclap.com/ABCDEF',
    'https://wooclap.com:444/ABCDEF', 'https://localhost/ABCDEF', LINK + 'a'.repeat(2048)]) {
    assert.throws(() => scheduleUrl(url), /Wooclap|wooclap/);
  }
});

test('schedule validation bounds future times, duration, and answer mode', () => {
  const job = newSchedule(input(), NOW, 'test-id');
  assert.equal(job.endsAt, NOW + 31 * 60_000);
  assert.equal(job.status, 'pending');
  for (const startsAt of [NOW, NOW - 1, NOW + 367 * 86400000, NaN, Infinity, 'tomorrow']) {
    assert.throws(() => newSchedule({ ...input(), startsAt }, NOW, 'test'), /future/);
  }
  for (const durationMinutes of [0, -1, 481, 1.5, NaN, '30']) {
    assert.throws(() => newSchedule({ ...input(), durationMinutes }, NOW, 'test'), /Duration/);
  }
  assert.throws(() => newSchedule({ ...input(), mode: 'unknown' }, NOW, 'test'), /answer mode/);
  assert.equal(newSchedule({ ...input(), mode: 'suggest', durationMinutes: 480 }, NOW, 'test').mode, 'suggest');
});

test('pending schedules persist and arm start, end, and recovery watchdog alarms', async () => {
  const f = fixture();
  await f.scheduler.initialize();
  const [job] = await f.scheduler.add(input());
  assert.equal(f.alarms.get(SCHEDULE_ALARM_PREFIX + 'watchdog')?.periodInMinutes, 1);
  assert.equal(f.alarms.get(SCHEDULE_ALARM_PREFIX + job.id + ':start')?.when, job.startsAt);
  assert.equal(f.alarms.get(SCHEDULE_ALARM_PREFIX + job.id + ':end')?.when, job.endsAt);
  const { hasTab, ...storedJob } = job;
  assert.equal(hasTab, false);
  assert.deepEqual(f.local.schedules, [storedJob]);
  assert.deepEqual(f.session.scheduleTabs, {});
  assert.equal(f.created.length, 0);
  const snapshot = f.scheduler.list();
  snapshot[0].url = 'https://example.com';
  assert.equal(f.scheduler.list()[0].url, LINK);
});

test('duplicate due ticks launch one inactive tab and start monitoring exactly once', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await Promise.all([f.scheduler.tick(), f.scheduler.tick(), f.scheduler.tick()]);
  await flush();
  assert.deepEqual(f.created, [{ url: 'about:blank', active: false }]);
  assert.deepEqual(f.starts, [10]);
  assert.deepEqual(f.monitoring, [10]);
  assert.equal(f.tabs.get(10)?.url, LINK);
  assert.equal(f.scheduler.list()[0].status, 'running');
  assert.deepEqual(f.session.scheduleTabs, { [job.id]: 10 });
  assert.equal(f.scheduler.starting, false);
});

test('a late start keeps the original end time and closes only its owned tab', async () => {
  const f = fixture();
  f.tabs.set(99, { id: 99, url: LINK, status: 'complete' });
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt + 10 * 60_000);
  await f.scheduler.tick();
  await flush();
  assert.equal(f.scheduler.list()[0].endsAt, job.endsAt);
  f.setNow(job.endsAt - 1);
  await f.scheduler.tick();
  assert.deepEqual(f.removed, []);
  f.setNow(job.endsAt);
  await f.scheduler.tick();
  assert.equal(f.scheduler.list()[0].status, 'completed');
  assert.deepEqual(f.stops, [10]);
  assert.deepEqual(f.removed, [10]);
  assert.ok(f.tabs.has(99));
  assert.deepEqual(f.session.scheduleTabs, {});
  assert.equal(f.alarms.has(SCHEDULE_ALARM_PREFIX + job.id + ':end'), false);
});

test('a schedule already past its end is missed without opening a tab', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  f.setNow(job.endsAt);
  await f.scheduler.tick();
  await flush();
  assert.equal(f.scheduler.list()[0].status, 'missed');
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.starts, []);
});

test('an existing manual session is left untouched when a schedule comes due', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  f.setBusy(true);
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  assert.equal(f.scheduler.list()[0].status, 'failed');
  assert.match(f.scheduler.list()[0].detail, /Another session/);
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.stops, []);
  f.setBusy(false);
  await f.scheduler.tick();
  assert.deepEqual(f.created, []);
});

test('overlaps are rejected even for concurrent additions, while adjacent sessions are allowed', async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.scheduler.add(input()), f.scheduler.add(input(NOW + 120_000))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(rejected.reason.message, /overlaps/);
  const [first] = f.scheduler.list();
  await f.scheduler.add(input(first.endsAt));
  assert.equal(f.scheduler.list().length, 2);
  await f.scheduler.cancel(first.id);
  await f.scheduler.add(input());
  assert.equal(f.scheduler.list().length, 3);
});

test('cancelling a pending schedule clears alarms and never opens its tab', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  await f.scheduler.cancel(job.id);
  assert.equal(f.scheduler.list()[0].status, 'cancelled');
  assert.equal(f.alarms.has(SCHEDULE_ALARM_PREFIX + job.id + ':start'), false);
  assert.equal(f.alarms.has(SCHEDULE_ALARM_PREFIX + job.id + ':end'), false);
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  assert.deepEqual(f.created, []);
});

test('cancelling a running schedule stops monitoring and closes the owned tab', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  await f.scheduler.cancel(job.id);
  assert.equal(f.scheduler.list()[0].status, 'cancelled');
  assert.deepEqual(f.stops, [10]);
  assert.deepEqual(f.removed, [10]);
  assert.deepEqual(f.session.scheduleTabs, {});
});

test('cancellation while tab creation is pending cleans up the eventual tab without monitoring', async () => {
  const f = fixture(), gate = deferred();
  f.holdCreate(gate.promise);
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  assert.equal(f.created.length, 1);
  assert.equal(f.scheduler.starting, true);
  await f.scheduler.cancel(job.id);
  gate.resolve();
  await flush();
  assert.equal(f.scheduler.list()[0].status, 'cancelled');
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.removed, [10]);
  assert.deepEqual(f.session.scheduleTabs, {});
  assert.equal(f.scheduler.starting, false);
});

test('cancellation during asynchronous connection checks cannot resume monitoring', async () => {
  const f = fixture(), gate = deferred();
  f.holdStart(gate.promise);
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  assert.deepEqual(f.starts, [10]);
  await f.scheduler.cancel(job.id);
  gate.resolve();
  await flush();
  assert.equal(f.scheduler.list()[0].status, 'cancelled');
  assert.deepEqual(f.monitoring, []);
  assert.deepEqual(f.removed, [10]);
  assert.equal(f.scheduler.starting, false);
});

test('the end deadline during connection checks closes the tab and prevents a late start', async () => {
  const f = fixture(), gate = deferred();
  f.holdStart(gate.promise);
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  f.setNow(job.endsAt);
  await f.scheduler.tick();
  gate.resolve();
  await flush();
  assert.equal(f.scheduler.list()[0].status, 'completed');
  assert.deepEqual(f.monitoring, []);
  assert.deepEqual(f.removed, [10]);
});

test('worker recovery preserves session-owned cleanup without replaying answers', async () => {
  const job = { ...newSchedule(input(), NOW, 'recover-owned'), status: 'running' as const };
  const f = fixture([job], { [job.id]: 42 });
  f.tabs.set(42, { id: 42, url: LINK, status: 'complete' });
  f.setNow(job.startsAt + 1000);
  await f.scheduler.initialize();
  assert.equal(f.scheduler.list()[0].status, 'failed');
  assert.match(f.scheduler.list()[0].detail, /restarted/);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.removed, []);
  assert.equal(f.alarms.get(SCHEDULE_ALARM_PREFIX + job.id + ':end')?.when, job.endsAt);
  f.setNow(job.endsAt);
  await f.scheduler.tick();
  assert.deepEqual(f.removed, [42]);
  assert.deepEqual(f.session.scheduleTabs, {});
});

test('browser recovery without session ownership never closes an unrelated tab with a reused ID', async () => {
  const job = { ...newSchedule(input(), NOW, 'recover-unowned'), status: 'running' as const };
  const f = fixture([job]);
  f.tabs.set(42, { id: 42, url: LINK, status: 'complete' });
  f.setNow(job.endsAt + 1);
  await f.scheduler.initialize();
  await f.scheduler.cancel(job.id);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.stops, []);
  assert.ok(f.tabs.has(42));
});

test('cleanup leaves a scheduled tab open if the user repurposed it for another site', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  f.tabs.get(10)!.url = 'https://example.com/personal-work';
  f.setNow(job.endsAt);
  await f.scheduler.tick();
  assert.deepEqual(f.stops, [10]);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.session.scheduleTabs, {});
  assert.ok(f.tabs.has(10));
});

test('manually closing a scheduled tab cancels the job and does not recreate it', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  f.tabs.delete(10);
  await f.scheduler.removed(10);
  await f.scheduler.tick();
  assert.equal(f.scheduler.list()[0].status, 'cancelled');
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.session.scheduleTabs, {});
});

test('a runtime guard is captured before tab creation and cannot be refreshed after a pause', async () => {
  const f = fixture(), gate = deferred();
  f.holdCreate(gate.promise);
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  assert.deepEqual(f.guardSnapshots, [0]);
  f.invalidateRuntime();
  gate.resolve();
  await flush();
  assert.deepEqual(f.guardSnapshots, [0]);
  assert.equal(f.scheduler.list()[0].status, 'failed');
  assert.match(f.scheduler.list()[0].detail, /paused or replaced/);
  assert.deepEqual(f.starts, []);
  assert.equal(f.tabs.get(10)?.url, 'about:blank');
  f.setNow(job.endsAt);
  await f.scheduler.tick();
  assert.deepEqual(f.removed, [10]);
});

test('a runtime pause while the page is loading prevents a later monitoring start', async () => {
  const f = fixture(), gate = deferred();
  f.holdGet(gate.promise);
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  assert.equal(f.tabs.get(10)?.url, LINK);
  assert.equal(f.scheduler.list()[0].status, 'starting');
  f.invalidateRuntime();
  gate.resolve();
  await flush();
  assert.equal(f.scheduler.list()[0].status, 'failed');
  assert.deepEqual(f.guardSnapshots, [0]);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.monitoring, []);
});

test('missing normal browser windows fall back to a minimized window and retain tab ownership', async () => {
  const f = fixture();
  f.failTabCreate();
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.createdWindows, [{ url: 'about:blank', focused: false, state: 'minimized', type: 'normal' }]);
  assert.equal(f.scheduler.list()[0].status, 'running');
  assert.deepEqual(f.starts, [10]);
  assert.deepEqual(f.session.scheduleTabs, { [job.id]: 10 });
  assert.equal(f.tabs.get(10)?.url, LINK);
  f.setNow(job.endsAt);
  await f.scheduler.tick();
  assert.deepEqual(f.removed, [10]);
});

test('a runtime pause during failed tab creation prevents opening a fallback window', async () => {
  const f = fixture(), gate = deferred();
  f.failTabCreate();
  f.holdCreate(gate.promise);
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  f.invalidateRuntime();
  gate.resolve();
  await flush();
  assert.equal(f.scheduler.list()[0].status, 'failed');
  assert.deepEqual(f.createdWindows, []);
  assert.deepEqual(f.starts, []);
});

test('the start hook deadline guard works even when the end alarm has not fired yet', async () => {
  const f = fixture(), gate = deferred();
  f.holdStart(gate.promise);
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  assert.deepEqual(f.starts, [10]);
  f.setNow(job.endsAt);
  // No scheduler tick: a delayed browser alarm must not permit late answers.
  gate.resolve();
  await flush();
  assert.equal(f.scheduler.list()[0].status, 'failed');
  assert.deepEqual(f.monitoring, []);
  assert.deepEqual(f.removed, [10]);
  assert.deepEqual(f.session.scheduleTabs, {});
});

test('malformed stored schedules are ignored before alarms or navigation are attempted', async () => {
  const valid = newSchedule(input(), NOW, 'valid-job');
  const malformed: unknown[] = [null, undefined, false, 42, {},
    { ...valid, id: '../outside' }, { ...valid, id: '' }, { ...valid, id: 'a'.repeat(81) },
    { ...valid, url: 'https://evil.example/ABCDEF' }, { ...valid, startsAt: 'tomorrow' },
    { ...valid, endsAt: valid.startsAt }, { ...valid, endsAt: Number.MAX_VALUE },
    { ...valid, endsAt: valid.startsAt + 481 * 60_000 }, { ...valid, mode: 'surprise' },
    { ...valid, status: 'anything' }, { ...valid, detail: null }];
  const f = fixture([...malformed, valid]);
  await f.scheduler.initialize();
  assert.deepEqual(f.scheduler.list(), [{ ...valid, hasTab: false }]);
  assert.deepEqual(f.local.schedules, [valid]);
  assert.equal(f.alarms.size, 3);
  assert.deepEqual(f.created, []);
});

test('pending navigation away from Wooclap prevents cleanup closing the user navigation', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  f.tabs.get(10)!.pendingUrl = 'https://example.com/personal-work';
  f.setNow(job.endsAt);
  await f.scheduler.tick();
  assert.deepEqual(f.stops, [10]);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.session.scheduleTabs, {});
  assert.ok(f.tabs.has(10));
});

test('cleanup does not close a tab the user moved to another Wooclap event', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  f.tabs.get(10)!.url = 'https://app.wooclap.com/OTHER1';
  f.setNow(job.endsAt);
  await f.scheduler.tick();
  assert.deepEqual(f.stops, [10]);
  assert.deepEqual(f.removed, []);
  assert.ok(f.tabs.has(10));
  assert.deepEqual(f.session.scheduleTabs, {});
});

test('cleanup can still close a scheduled participant tab on another route of its own event', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  f.tabs.get(10)!.url = LINK + '/questionnaires/form-1';
  f.setNow(job.endsAt);
  await f.scheduler.tick();
  assert.deepEqual(f.removed, [10]);
});

test('schedule links must target a participant event instead of organizer or authentication pages', () => {
  for (const url of ['https://app.wooclap.com/', 'https://app.wooclap.com/login',
    'https://app.wooclap.com/events', 'https://app.wooclap.com/events/event1/edit',
    'https://wooclap.com/pricing', 'https://app.wooclap.com/auth/callback']) {
    assert.throws(() => scheduleUrl(url), /participant|event|Wooclap/i);
  }
  assert.equal(scheduleUrl('https://app.wooclap.com/SCHED1'), 'https://app.wooclap.com/SCHED1');
});

test('removing upcoming and historical entries persists deletion and preserves other schedules', async () => {
  for (const status of ['pending', 'completed', 'cancelled', 'missed', 'failed'] as const) {
    const job = { ...newSchedule(input(), NOW, 'remove-me'), status };
    const other = { ...newSchedule(input(NOW + 3_600_000), NOW, 'keep-me'), status: 'pending' as const };
    const f = fixture([job, other]);
    await f.scheduler.initialize();
    const remaining = await f.scheduler.remove(job.id);
    assert.deepEqual(remaining.map(item => item.id), [other.id]);
    assert.deepEqual(f.local.schedules.map((item: ScheduledSession) => item.id), [other.id]);
    assert.equal(f.alarms.has(SCHEDULE_ALARM_PREFIX + job.id + ':start'), false);
    assert.equal(f.alarms.has(SCHEDULE_ALARM_PREFIX + job.id + ':end'), false);
    assert.equal(f.alarms.has(SCHEDULE_ALARM_PREFIX + other.id + ':start'), true);
    f.setNow(job.startsAt);
    await f.scheduler.tick();
    await flush();
    assert.deepEqual(f.created, []);
  }
});

test('removing a running session stops and closes its own tab before clearing its history', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  f.tabs.set(99, { id: 99, url: LINK, status: 'complete' });
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  assert.deepEqual(await f.scheduler.remove(job.id), []);
  assert.deepEqual(f.stops, [10]);
  assert.deepEqual(f.removed, [10]);
  assert.ok(f.tabs.has(99));
  assert.deepEqual(f.local.schedules, []);
  assert.deepEqual(f.session.scheduleTabs, {});
  assert.equal(f.alarms.size, 0);
});

test('removing during tab creation waits for the late tab and never resurrects the entry', async () => {
  const f = fixture(), gate = deferred();
  f.holdCreate(gate.promise);
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  let removed = false;
  const removing = f.scheduler.remove(job.id).then(result => { removed = true; return result; });
  await flush();
  assert.equal(removed, false, 'The schedule must retain ownership until tab creation settles.');
  assert.equal(f.scheduler.list()[0].status, 'cancelled');
  gate.resolve();
  assert.deepEqual(await removing, []);
  await flush();
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.removed, [10]);
  assert.deepEqual(f.local.schedules, []);
  assert.deepEqual(f.session.scheduleTabs, {});
});

test('removing during connection startup prevents late monitoring and finishes cleanup', async () => {
  const f = fixture(), gate = deferred();
  f.holdStart(gate.promise);
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  const removing = f.scheduler.remove(job.id);
  await flush();
  assert.deepEqual(f.removed, [10]);
  gate.resolve();
  assert.deepEqual(await removing, []);
  assert.deepEqual(f.monitoring, []);
  assert.deepEqual(f.local.schedules, []);
});

test('failed tab cleanup keeps the schedule available for removal retry', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  const removeTab = f.api.tabs.remove;
  f.api.tabs.remove = async () => { throw new Error('Temporary browser error'); };
  await assert.rejects(f.scheduler.remove(job.id), /could not close/);
  assert.equal(f.scheduler.list()[0].status, 'cancelled');
  assert.equal(f.scheduler.list()[0].hasTab, true);
  assert.equal(f.local.schedules.length, 1);
  f.api.tabs.remove = removeTab;
  assert.deepEqual(await f.scheduler.remove(job.id), []);
  assert.deepEqual(f.session.scheduleTabs, {});
});

test('removing a repurposed session leaves the unrelated tab open', async () => {
  const f = fixture();
  const [job] = await f.scheduler.add(input());
  f.setNow(job.startsAt);
  await f.scheduler.tick();
  await flush();
  f.tabs.get(10)!.url = 'https://example.com/';
  assert.deepEqual(await f.scheduler.remove(job.id), []);
  assert.ok(f.tabs.has(10));
  assert.deepEqual(f.removed, []);
});
