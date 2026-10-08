/** Owns the debugger connection for one explicitly started background session.
 * Never changes tab activation or window state, and never reads private app state. */
type Protection = { tabId: number; autoDiscardable: boolean };
const STORAGE_KEY = 'backgroundTab';

function bounded<T>(promise: Promise<T>, timeout: number, detail: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(detail)), timeout);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export class BackgroundTab {
  private protection: Protection | null = null;
  private connected = false;
  private transition: Promise<void> = Promise.resolve();

  private queue(task: () => Promise<void>): Promise<void> {
    const next = this.transition.catch(() => undefined).then(task);
    this.transition = next;
    return next;
  }

  owns(tabId: number): boolean { return this.connected && this.protection?.tabId === tabId; }

  handleDetach(tabId: number): boolean {
    if (!this.owns(tabId)) return false;
    this.connected = false;
    return true;
  }

  async recover(): Promise<void> {
    return this.queue(async () => {
      const saved = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY] as Protection | undefined;
      if (saved && Number.isInteger(saved.tabId) && typeof saved.autoDiscardable === 'boolean') {
        this.protection = saved;
        // detach only addresses this extension's session, never another debugger.
        this.connected = true;
        await this.cleanup();
      } else await chrome.storage.session.remove(STORAGE_KEY);
    });
  }

  acquire(tabId: number, assertActive: () => void): Promise<void> {
    return this.queue(async () => {
      assertActive();
      await this.cleanup();
      assertActive();
      if (!chrome.debugger || !await chrome.permissions.contains({ permissions: ['debugger'] })) {
        throw new Error('Background mode needs the updated extension debugger permission. Reload the extension in Edge.');
      }
      assertActive();
      const tab = await chrome.tabs.get(tabId);
      assertActive();
      this.protection = { tabId, autoDiscardable: tab.autoDiscardable };
      try {
        await chrome.storage.session.set({ [STORAGE_KEY]: this.protection });
        assertActive();
        await chrome.tabs.update(tabId, { autoDiscardable: false });
        assertActive();
        // Browser attachment itself is not timed out: wait for its result so a
        // cancellation can always detach a late successful connection.
        try { await chrome.debugger.attach({ tabId }, '1.3'); }
        catch { throw new Error('Could not connect background mode. Close DevTools or another debugger on this tab, then press Start.'); }
        this.connected = true;
        assertActive();
        await bounded(chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }),
          5000, 'The background tab did not become ready. Monitoring stopped.');
        assertActive();
      } catch (error) {
        await this.cleanup();
        throw error;
      }
    });
  }

  release(): Promise<void> { return this.queue(() => this.cleanup()); }

  private async cleanup(): Promise<void> {
    const saved = this.protection;
    if (!saved) return;
    // Invalidate ownership before deliberate detach so onDetach cannot recurse.
    const wasConnected = this.connected;
    this.connected = false;
    this.protection = null;
    if (wasConnected) await chrome.debugger.detach({ tabId: saved.tabId }).catch(() => undefined);
    // Detach resets focus emulation as well. Preserve an existing false flag.
    try {
      await chrome.tabs.update(saved.tabId, { autoDiscardable: saved.autoDiscardable });
    } catch {
      const exists = await chrome.tabs.get(saved.tabId).catch(() => null);
      if (exists) {
        this.protection = saved;
        throw new Error('Could not restore the monitored tab settings. Pause again before starting.');
      }
    }
    await chrome.storage.session.remove(STORAGE_KEY);
  }

  async capture(tabId: number): Promise<string> {
    if (!this.owns(tabId)) throw new Error('The background connection ended. Press Start to reconnect.');
    const original = this.protection;
    const result = await bounded(chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false
    }), 10_000, 'Background image capture timed out. Monitoring stopped.') as { data?: unknown } | undefined;
    if (!this.owns(tabId) || original !== this.protection) throw new Error('The background connection ended during image capture.');
    if (typeof result?.data !== 'string' || !result.data || result.data.length > 40_000_000) throw new Error('The background screenshot was empty or too large.');
    return `data:image/png;base64,${result.data}`;
  }
}
