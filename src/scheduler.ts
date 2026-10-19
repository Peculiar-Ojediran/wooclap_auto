import { newSchedule, scheduleUrl, sameScheduledEvent, type ScheduledSession } from './shared/schedules';

export const SCHEDULE_ALARM_PREFIX = 'wooclap-schedule:';
const active = (job: ScheduledSession) => job.status === 'starting' || job.status === 'running';
interface Hooks {
  busy(): boolean;
  guard?(): () => void;
  start(tabId: number, job: ScheduledSession, guard: () => void): Promise<void>;
  stop(tabId: number, detail: string): Promise<void>;
}

/** Persist plans locally, but keep tab ownership scoped to this browser session.
 * No credentials, mutable settings, or reusable browser tab IDs enter the plans. */
export class SessionScheduler {
  private jobs: ScheduledSession[] = [];
  private owned: Record<string, number> = {};
  private writes: Promise<void> = Promise.resolve();
  private operations: Promise<unknown> = Promise.resolve();
  private launches = new Map<string, Promise<void>>();

  constructor(private hooks: Hooks, private api = chrome, private now = () => Date.now()) {}
  list(): ScheduledSession[] { return structuredClone(this.jobs.map(job => ({ ...job, hasTab: this.owned[job.id] !== undefined }))); }
  get starting(): boolean { return this.launches.size > 0 || this.jobs.some(job => job.status === 'starting'); }

  private queue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operations.catch(() => undefined).then(task);
    this.operations = next;
    return next;
  }
  private save(): Promise<void> {
    const local = structuredClone(this.jobs), owned = { ...this.owned };
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await this.api.storage.session.set({ scheduleTabs: owned });
      await this.api.storage.local.set({ schedules: local });
    });
    return this.writes;
  }
  async initialize(): Promise<void> {
    const saved = (await this.api.storage.local.get('schedules')).schedules;
    const owned = (await this.api.storage.session.get('scheduleTabs')).scheduleTabs as Record<string, unknown> | undefined;
    if (Array.isArray(saved)) this.jobs = saved.filter(job => {
      try {
        return typeof job.id === 'string' && /^[\w-]{1,80}$/.test(job.id) && scheduleUrl(job.url)
          && Number.isSafeInteger(job.startsAt) && Number.isSafeInteger(job.endsAt) && job.endsAt > job.startsAt
          && job.endsAt - job.startsAt <= 480 * 60000 && ['auto', 'suggest'].includes(job.mode)
          && ['pending','starting','running','completed','cancelled','missed','failed'].includes(job.status)
          && typeof job.detail === 'string';
      } catch { return false; }
    }).slice(-50);
    for (const job of this.jobs) {
      if (owned && Number.isInteger(owned[job.id])) this.owned[job.id] = owned[job.id] as number;
      if (active(job)) {
        job.status = 'failed';
        job.detail = 'Monitoring stopped after the extension or browser restarted. No answers were retried.';
      }
    }
    await this.save();
    for (const job of this.jobs) await this.arm(job);
    await this.tick();
  }
  private async arm(job: ScheduledSession): Promise<void> {
    if (job.status === 'pending') await this.api.alarms.create(SCHEDULE_ALARM_PREFIX + job.id + ':start', { when: job.startsAt });
    if (job.status === 'pending' || active(job) || this.owned[job.id] !== undefined) {
      await this.api.alarms.create(SCHEDULE_ALARM_PREFIX + job.id + ':end', { when: job.endsAt });
      await this.api.alarms.create(SCHEDULE_ALARM_PREFIX + 'watchdog', { periodInMinutes: 1 });
    }
  }
  add(input: unknown): Promise<ScheduledSession[]> {
    return this.queue(async () => {
      const job = newSchedule(input, this.now(), crypto.randomUUID());
      if (this.jobs.some(other => (other.status === 'pending' || active(other)) && job.startsAt < other.endsAt && job.endsAt > other.startsAt)) {
        throw new Error('This time overlaps another scheduled session. Choose another time or cancel that session.');
      }
      if (this.jobs.filter(other => other.status === 'pending' || active(other) || this.owned[other.id] !== undefined).length >= 20) {
        throw new Error('You can keep up to 20 upcoming or active schedules.');
      }
      this.jobs = this.jobs.filter(other => other.status === 'pending' || active(other) || this.owned[other.id] !== undefined
        || this.jobs.indexOf(other) >= this.jobs.length - 29);
      this.jobs.push(job);
      await this.save();
      try { await this.arm(job); }
      catch { job.status = 'failed'; job.detail = 'Could not register browser alarms. Reload the extension and schedule again.'; await this.save(); throw new Error(job.detail); }
      return this.list();
    });
  }
  cancel(id: string): Promise<ScheduledSession[]> {
    return this.queue(async () => {
      const job = this.jobs.find(job => job.id === id);
      if (!job) throw new Error('This schedule no longer exists.');
      job.status = 'cancelled'; job.detail = 'Cancelled by you.';
      await this.save();
      await this.close(job);
      return this.list();
    });
  }
  remove(id: string): Promise<ScheduledSession[]> {
    return this.queue(async () => {
      const job = this.jobs.find(job => job.id === id);
      if (!job) throw new Error('This schedule no longer exists.');
      // Invalidate the launch before awaiting anything. Keep the record until
      // late tab creation and any in-flight startup have finished their cleanup.
      job.status = 'cancelled';
      job.detail = 'Stopped for removal.';
      await this.save();
      await this.close(job);
      await this.launches.get(job.id);
      if (this.owned[job.id] !== undefined) await this.close(job);
      if (this.owned[job.id] !== undefined) {
        throw new Error('Monitoring stopped, but Edge could not close the scheduled tab. Try Remove again.');
      }
      this.jobs = this.jobs.filter(other => other.id !== id);
      await this.save();
      if (!this.jobs.some(other => other.status === 'pending' || active(other) || this.owned[other.id] !== undefined)) {
        await this.api.alarms.clear(SCHEDULE_ALARM_PREFIX + 'watchdog');
      }
      return this.list();
    });
  }
  tick(): Promise<void> {
    return this.queue(async () => {
      for (const job of this.jobs) {
        if (this.now() >= job.endsAt && (job.status === 'pending' || active(job) || this.owned[job.id] !== undefined)) {
          if (job.status === 'pending') { job.status = 'missed'; job.detail = 'The scheduled time ended before the session could start.'; }
          else if (active(job)) { job.status = 'completed'; job.detail = 'Scheduled duration ended.'; }
          await this.close(job);
        } else if (job.status === 'pending' && this.now() >= job.startsAt) {
          if (this.hooks.busy() || this.starting) {
            job.status = 'failed'; job.detail = 'Another session was in use at the start time. It was left unchanged.';
          } else {
            job.status = 'starting'; job.detail = 'Opening the scheduled question tab…';
            const runtimeGuard = this.hooks.guard?.();
            await this.save();
            this.launches.set(job.id, this.launch(job, runtimeGuard).catch(() => undefined).finally(() => { this.launches.delete(job.id); }));
          }
        }
      }
      await this.save();
      if (!this.jobs.some(job => job.status === 'pending' || active(job) || this.owned[job.id] !== undefined)) {
        await this.api.alarms.clear(SCHEDULE_ALARM_PREFIX + 'watchdog');
      }
    });
  }
  private async launch(job: ScheduledSession, runtimeGuard?: () => void): Promise<void> {
    const guard = () => {
      runtimeGuard?.();
      if (!active(job) || this.now() >= job.endsAt) throw new Error('The schedule ended or was cancelled.');
    };
    try {
      guard();
      // Record ownership before navigation or any monitoring can begin.
      let tab: chrome.tabs.Tab;
      try { tab = await this.api.tabs.create({ url: 'about:blank', active: false }); }
      catch {
        guard();
        // Edge can keep extensions running after the last normal window closes.
        const window = await this.api.windows.create({ url: 'about:blank', focused: false, state: 'minimized', type: 'normal' });
        if (!window?.tabs?.[0]) throw new Error('Edge could not open a scheduled window.');
        tab = window.tabs[0];
      }
      if (tab.id === undefined) throw new Error('Edge did not create a tab.');
      this.owned[job.id] = tab.id;
      await this.save();
      guard();
      await this.api.tabs.update(tab.id, { url: job.url });
      const loadDeadline = Math.min(job.endsAt, this.now() + 60000);
      while (true) {
        guard();
        const current = await this.api.tabs.get(tab.id);
        if (current.status === 'complete' && !current.pendingUrl && current.url !== 'about:blank') {
          if (!sameScheduledEvent(job.url, current.url)) throw new Error('The scheduled link redirected away from the participant event. Join the event manually.');
          break;
        }
        if (this.now() >= loadDeadline) throw new Error('The scheduled page did not finish loading within one minute.');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      guard();
      await this.hooks.start(tab.id, job, guard);
      guard();
      job.status = 'running'; job.detail = 'Scheduled session started. The tab will close at the scheduled end time.';
      await this.save();
    } catch (error) {
      if (active(job)) { job.status = 'failed'; job.detail = error instanceof Error ? error.message : 'The scheduled session could not start.'; }
      await this.save();
      if (job.status === 'cancelled' || this.now() >= job.endsAt) await this.close(job);
    }
  }
  private async close(job: ScheduledSession): Promise<void> {
    const tabId = this.owned[job.id];
    if (tabId !== undefined) {
      await this.hooks.stop(tabId, job.detail);
      const tab = await this.api.tabs.get(tabId).catch(() => null);
      // A tab repurposed for another site is no longer ours to close.
      if (tab && (!tab.pendingUrl || sameScheduledEvent(job.url, tab.pendingUrl))
        && (tab.url === 'about:blank' || sameScheduledEvent(job.url, tab.url))) {
        try { await this.api.tabs.remove(tabId); }
        catch { job.detail = 'Monitoring stopped. Edge could not close the scheduled tab; cleanup will retry.'; await this.save(); return; }
      }
      delete this.owned[job.id];
    }
    await this.api.alarms.clear(SCHEDULE_ALARM_PREFIX + job.id + ':start');
    await this.api.alarms.clear(SCHEDULE_ALARM_PREFIX + job.id + ':end');
    await this.save();
  }
  stopped(tabId: number | null, detail: string): Promise<void> {
    for (const job of this.jobs) if (this.owned[job.id] === tabId && active(job)) {
      job.status = this.now() >= job.endsAt ? 'completed' : 'failed';
      job.detail = this.now() >= job.endsAt ? 'Scheduled duration ended.' : detail + ' The scheduled tab will still close at its end time.';
    }
    return this.save();
  }
  removed(tabId: number): Promise<void> {
    return this.queue(async () => {
      for (const job of this.jobs) if (this.owned[job.id] === tabId) {
        delete this.owned[job.id];
        if (active(job)) { job.status = 'cancelled'; job.detail = 'The scheduled tab was closed.'; }
      }
      await this.save();
    });
  }
}
