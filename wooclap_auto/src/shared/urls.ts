/** Accept only this extension's exact packaged practice page. */
export function isPackagedPracticeUrl(value: string): boolean {
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return false;
  try {
    const url = new URL(value), own = new URL(chrome.runtime.getURL('practice.html'));
    return url.protocol === own.protocol && url.hostname === own.hostname && url.pathname === own.pathname;
  } catch { return false; }
}

/** Practice pages may report observations, but only settings/popup can control credentials. */
export function isSettingsUi(value: string | undefined): boolean {
  if (!value) return false;
  const page = value.split(/[?#]/)[0];
  return page === chrome.runtime.getURL('options.html') || page === chrome.runtime.getURL('popup.html');
}
