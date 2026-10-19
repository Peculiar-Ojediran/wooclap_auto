import { BRIDGE_URL, DEFAULT_SETTINGS, PROVIDER_LABELS, PROVIDER_MODELS, type ConnectionMode, type Provider, type ResponseTransport, type Settings } from '../shared/types';
import { HOSTED_FALLBACK_URL } from '../shared/hosted-config';
import { scheduleUrl as validateScheduleUrl, type ScheduledSession } from '../shared/schedules';

type Credentials = Record<Provider, { configured: boolean; storage: 'session' | 'local' | 'none' }>;
interface Response {
  ok: boolean;
  error?: string;
  settings?: Settings;
  credentials?: Credentials;
  schedules?: ScheduledSession[];
  health?: { ready: boolean; demo: boolean; model: string; provider?: Provider; connectionMode?: ResponseTransport; acceptsClientKeys?: boolean; detail?: string };
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}
function input(id: string): HTMLInputElement { return element<HTMLInputElement>(id); }
const form = element<HTMLFormElement>('settings-form');
const providerSelect = element<HTMLSelectElement>('provider');
const connectionSelect = element<HTMLSelectElement>('connection-mode');
const errorMessage = element('error-message');
const controls = ['save-settings', 'check-bridge', 'save-api-key', 'forget-api-key', 'provider', 'api-key', 'remember-api-key', 'connection-mode'];
const models = { ...PROVIDER_MODELS };
let credentials: Credentials = {
  openai: { configured: false, storage: 'none' }, anthropic: { configured: false, storage: 'none' },
  nvidia: { configured: false, storage: 'none' }
};
let currentProvider: Provider = DEFAULT_SETTINGS.provider;
let busy = false;
let initialized = false;

function provider(): Provider {
  return providerSelect.value === 'openai' || providerSelect.value === 'anthropic' ? providerSelect.value : 'nvidia';
}
function connectionMode(): ConnectionMode {
  return connectionSelect.value === 'bridge' ? 'bridge' : connectionSelect.value === 'demo' ? 'demo' : 'direct';
}
function renderConnection(): void {
  const connection = connectionMode();
  element('bridge-settings').hidden = connection !== 'bridge';
  input('bridge-token').disabled = connection !== 'bridge';
  input('model').required = connection !== 'demo';
  element('connection-help').textContent = connection === 'bridge'
    ? 'Run the optional local service and enter its pairing token below.'
    : connection === 'demo' ? 'Try the bundled practice questions without an API key. Demo answers work only on practice pages.'
      : 'With your own API key, the extension sends requests directly to your selected provider. Without one, it uses the shared NVIDIA DeepSeek service when available.';
  element('connection-check-help').textContent = connection === 'bridge'
    ? 'This checks your local bridge and key configuration. Provider access is checked when answering.'
    : connection === 'demo' ? 'Demo mode uses built-in answers for the practice page. No AI requests are sent.'
      : 'This checks your saved key or the shared NVIDIA service. Provider access is checked when answering.';
  element('api-key-help').textContent = connection === 'bridge'
    ? 'The extension sends your key through the paired local bridge to your selected AI provider. Wooclap pages cannot read it. No cookies are used.'
    : connection === 'demo' ? 'No API key is needed for demo mode. You can manage keys here for your next AI session. No cookies are used.'
      : 'The extension sends your key directly to your selected AI provider. Wooclap pages cannot read it. No cookies are used.';
  element('hosted-fallback-help').hidden = connection !== 'direct';
  element('hosted-fallback-help').textContent = HOSTED_FALLBACK_URL
    ? 'Shared fallback: when your selected provider has no saved key, questions and included screenshots pass through the hosted service to NVIDIA. The service uses DeepSeek V4.1 Flash and its own API key; your personal keys are never sent to it.'
    : 'Shared fallback is unavailable in this build because no hosted service has been configured. Save your own API key to answer questions, or use the local practice demo.';
  element<HTMLAnchorElement>('practice-link').href = connection === 'bridge' ? `${BRIDGE_URL}/practice` : chrome.runtime.getURL('practice.html');
  renderCredentials();
}
function showError(error: unknown): void {
  errorMessage.textContent = error instanceof Error ? error.message : String(error);
  errorMessage.hidden = false;
}
function updateControls(): void {
  for (const id of controls) {
    element<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(id).disabled = busy || !initialized;
  }
  element<HTMLButtonElement>('forget-api-key').disabled = busy || !initialized || !credentials[provider()].configured;
}
function renderCredentials(): void {
  const name = PROVIDER_LABELS[provider()];
  const credential = credentials[provider()];
  element('api-key-label').textContent = `${name} API key`;
  input('api-key').placeholder = credential.configured ? 'Paste a replacement key' : `Paste your ${name} API key`;
  element('credential-status').textContent = credential.configured
    ? credential.storage === 'local' ? `${name} key remembered on this device.` : `${name} key available for this browser session only.`
    : `No ${name} key saved in the extension.${connectionMode() === 'bridge'
      ? ' The bridge can also use a key from its environment settings.'
      : connectionMode() === 'direct' ? HOSTED_FALLBACK_URL
        ? ' The shared NVIDIA DeepSeek service will be used.' : ' Shared fallback is unavailable in this build.' : ''}`;
  element('credential-status').dataset.state = credential.configured ? 'success' : 'pending';
  updateControls();
}
function acceptCredentials(response: Response): void {
  if (response.credentials) credentials = response.credentials;
  renderCredentials();
}

function populate(settings: Settings): void {
  currentProvider = settings.provider === 'anthropic' || settings.provider === 'openai' ? settings.provider : 'nvidia';
  connectionSelect.value = settings.connectionMode === 'bridge' || settings.connectionMode === 'demo' ? settings.connectionMode : 'direct';
  providerSelect.value = currentProvider;
  models[currentProvider] = settings.model;
  input('bridge-token').value = settings.bridgeToken;
  input('model').value = settings.model;
  input('mode-auto').checked = settings.mode === 'auto';
  input('mode-suggest').checked = settings.mode === 'suggest';
  input('request-limit').value = String(settings.requestLimit);
  input('capture-images').checked = settings.captureImages;
  input('background-mode').checked = settings.backgroundMode === true;
  input('selector-question').value = settings.selectors.question;
  input('selector-choices').value = settings.selectors.choices;
  input('selector-submit').value = settings.selectors.submit;
  input('selector-confirmation').value = settings.selectors.confirmation;
  input('selector-multiple').checked = settings.selectors.multiple;
  input('selector-choice-submits').checked = settings.selectors.choiceClickSubmits;
  renderConnection();
}

function readSettings(): Settings {
  return {
    connectionMode: connectionMode(), bridgeToken: input('bridge-token').value.trim(), provider: provider(),
    model: input('model').value.trim() || (connectionMode() === 'demo' ? PROVIDER_MODELS[provider()] : ''),
    mode: input('mode-auto').checked ? 'auto' : 'suggest',
    requestLimit: Number(input('request-limit').value), captureImages: input('capture-images').checked,
    backgroundMode: input('background-mode').checked,
    selectors: {
      question: input('selector-question').value.trim(), choices: input('selector-choices').value.trim(),
      submit: input('selector-submit').value.trim(), confirmation: input('selector-confirmation').value.trim(),
      multiple: input('selector-multiple').checked, choiceClickSubmits: input('selector-choice-submits').checked
    }
  };
}

async function send(message: Record<string, unknown>): Promise<Response> {
  const response = await chrome.runtime.sendMessage(message) as Response;
  if (!response?.ok) throw new Error(response?.error || 'The extension did not respond. Reload it from Edge’s extensions page.');
  return response;
}

async function save(): Promise<void> {
  const response = await send({ type: 'SAVE_SETTINGS', settings: readSettings() });
  if (response.settings) populate(response.settings);
  acceptCredentials(response);
  element('save-status').textContent = 'Settings saved. Start a session from the extension.';
  element('save-status').dataset.state = 'success';
}

async function action(callback: () => Promise<void>, validateForm = true): Promise<void> {
  if (busy || !initialized || (validateForm && !form.reportValidity())) return;
  busy = true;
  updateControls();
  errorMessage.hidden = true;
  try { await callback(); } catch (error) { showError(error); }
  finally { busy = false; updateControls(); }
}
function connectionChanged(): void {
  element('bridge-status').textContent = 'Connection not checked with these settings.';
  element('bridge-status').removeAttribute('data-state');
}
function settingsChanged(): void {
  element('save-status').textContent = 'You have unsaved changes.';
  element('save-status').dataset.state = 'unsaved';
  connectionChanged();
}

form.addEventListener('submit', event => {
  event.preventDefault();
  void action(save);
});
form.addEventListener('input', event => {
  if ((event.target as HTMLElement).closest('#credentials-controls')) return;
  settingsChanged();
});
providerSelect.addEventListener('change', () => {
  models[currentProvider] = input('model').value;
  currentProvider = provider();
  input('model').value = models[currentProvider];
  input('api-key').value = '';
  input('remember-api-key').checked = false;
  element('credential-action-status').textContent = '';
  renderCredentials();
  settingsChanged();
});
connectionSelect.addEventListener('change', () => {
  renderConnection();
  settingsChanged();
});

async function saveApiKey(): Promise<void> {
  const selectedProvider = provider();
  const apiKey = input('api-key').value.trim();
  if (!apiKey) throw new Error('Paste an API key before saving it.');
  const remember = input('remember-api-key').checked;
  if (remember && !window.confirm(`Remember your ${PROVIDER_LABELS[selectedProvider]} API key on this device?\n\nThe extension will store it locally without encryption, until you forget or replace it. It will remain after Edge exits. Cancel to leave it unsaved.`)) {
    element('credential-action-status').textContent = 'Permission declined. The new key was not saved.';
    return;
  }
  const response = await send({ type: 'SAVE_API_KEY', provider: selectedProvider, apiKey, remember, consent: remember });
  input('api-key').value = '';
  input('remember-api-key').checked = false;
  acceptCredentials(response);
  element('credential-action-status').textContent = remember
    ? 'API key remembered with your permission. Use Forget key to remove it.'
    : 'API key saved for this browser session only. Any previously remembered copy was removed.';
  connectionChanged();
}
element('save-api-key').addEventListener('click', () => void action(saveApiKey, false));
input('api-key').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); void action(saveApiKey, false); }
});
element('forget-api-key').addEventListener('click', () => void action(async () => {
  const response = await send({ type: 'CLEAR_API_KEY', provider: provider() });
  input('api-key').value = '';
  input('remember-api-key').checked = false;
  acceptCredentials(response);
  element('credential-action-status').textContent = `API key removed from the extension.${connectionMode() === 'bridge' ? ' A key configured in the bridge environment remains separate.' : ''}`;
  connectionChanged();
}, false));

element('check-bridge').addEventListener('click', () => void action(async () => {
  await save();
  const status = element('bridge-status');
  status.textContent = connectionMode() === 'bridge' ? 'Connecting to your local bridge…' : 'Checking your settings…';
  status.removeAttribute('data-state');
  try {
    const response = await send({ type: 'CHECK_CONNECTION' });
    if (!response.health) throw new Error('The extension returned an incomplete connection status.');
    const health = response.health;
    const name = PROVIDER_LABELS[health.provider ?? provider()];
    const connection = health.connectionMode ?? connectionMode();
    status.textContent = health.demo ? 'Ready · Local practice demo enabled. No API key needed.'
      : connection === 'hosted' ? health.ready
        ? `Shared NVIDIA service available · ${health.model}. No personal API key needed. Provider access is checked when answering.`
        : health.detail || 'Shared NVIDIA service unavailable. Save your own API key to enable AI answers.'
        : health.ready ? `${connection === 'bridge' ? 'Bridge connected' : 'Direct API'} · API key configured. ${name} access is checked when answering.`
          : health.detail || `Add an API key for ${name} here${connection === 'bridge' ? ' or configure it on the bridge' : ''} to enable AI answers.`;
    status.dataset.state = health.ready || health.demo ? 'success' : 'pending';
  } catch (error) {
    status.textContent = connectionMode() === 'bridge'
      ? 'Unable to connect. Check that the bridge is running and the token is correct.'
      : 'Unable to check your settings. See the error below.';
    status.dataset.state = 'error';
    throw error;
  }
}));

updateControls();
void send({ type: 'GET_STATE' }).then(response => {
  if (!response.settings) throw new Error('Could not read extension settings.');
  populate(response.settings);
  initialized = true;
  acceptCredentials(response);
}).catch(showError);

// Scheduling has its own form and status: refreshing sessions must never reset
// a partially completed event or save unrelated provider/key settings.
const scheduleForm = element<HTMLFormElement>('schedule-form');
const scheduleActionStatus = element('schedule-action-status');
const scheduleLoadStatus = element('schedule-load-status');
const scheduleList = element<HTMLUListElement>('schedule-list');
const scheduleStatuses: Record<ScheduledSession['status'], string> = {
  pending: 'Scheduled', starting: 'Starting', running: 'Running', completed: 'Completed',
  cancelled: 'Cancelled', missed: 'Missed', failed: 'Needs attention'
};
const sessionDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let scheduleBusy = false;
let scheduleInitialized = false;
let schedulePolling = false;
let scheduleSequence = 0;
let scheduleListKey = '';

function localDateInput(date: Date): string {
  const part = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

function scheduleUrl(value: string): URL {
  return new URL(validateScheduleUrl(value.trim()));
}

function updateScheduleControls(): void {
  element<HTMLButtonElement>('add-schedule').disabled = scheduleBusy || !scheduleInitialized;
  element<HTMLButtonElement>('refresh-schedules').disabled = scheduleBusy || schedulePolling;
  for (const button of scheduleList.querySelectorAll<HTMLButtonElement>('button')) button.disabled = scheduleBusy;
}

function updateSchedulePreview(): void {
  const startsAt = new Date(input('schedule-start').value).getTime();
  const duration = Number(input('schedule-duration').value);
  const preview = element('schedule-window-preview');
  preview.textContent = Number.isFinite(startsAt) && Number.isInteger(duration) && duration >= 1 && duration <= 480
    ? `The event tab closes at ${sessionDate.format(new Date(startsAt + duration * 60_000))}.` : '';
}

function renderSchedules(schedules: ScheduledSession[]): void {
  scheduleInitialized = true;
  scheduleLoadStatus.textContent = '';
  const key = JSON.stringify(schedules);
  // Retain keyboard focus on a schedule control when a poll changes nothing.
  if (key !== scheduleListKey) {
    scheduleListKey = key;
    const items = schedules.map(schedule => {
      const item = document.createElement('li');
      item.className = 'schedule-item';
      const heading = document.createElement('div');
      heading.className = 'schedule-item-heading';
      const status = document.createElement('span');
      status.className = 'schedule-status';
      status.dataset.status = schedule.status;
      status.textContent = scheduleStatuses[schedule.status] ?? 'Unknown';
      const mode = document.createElement('span');
      mode.className = 'schedule-item-mode';
      mode.textContent = schedule.mode === 'auto' ? 'Automatic submission' : 'Review suggestions';
      heading.append(status, mode);
      const link = document.createElement('a');
      link.className = 'schedule-event-link';
      link.textContent = schedule.url;
      try {
        link.href = scheduleUrl(schedule.url).href;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
      } catch { /* Invalid persisted links stay inert. */ }
      const times = document.createElement('p');
      times.className = 'schedule-item-times';
      times.textContent = `${sessionDate.format(new Date(schedule.startsAt))} – ${sessionDate.format(new Date(schedule.endsAt))}`;
      const detail = document.createElement('p');
      detail.className = 'field-help';
      detail.textContent = schedule.detail;
      item.append(heading, link, times, detail);
      if (schedule.hasTab || schedule.status === 'pending' || schedule.status === 'starting' || schedule.status === 'running') {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'button button-quiet schedule-cancel';
        cancel.textContent = schedule.status === 'pending' && !schedule.hasTab ? 'Cancel schedule' : 'Stop & close tab';
        cancel.setAttribute('aria-label', `${cancel.textContent}: ${schedule.url}`);
        cancel.addEventListener('click', () => void scheduleAction(async () => {
          await changeSchedules({ type: 'CANCEL_SCHEDULE', id: schedule.id });
          scheduleActionStatus.textContent = 'Schedule cancelled. Its status below shows whether the event tab was closed.';
        }));
        item.append(cancel);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button button-quiet schedule-remove';
      const active = schedule.hasTab || schedule.status === 'starting' || schedule.status === 'running';
      remove.textContent = active ? 'Stop & remove' : 'Remove';
      remove.title = active
        ? 'Stop this scheduled session, close only its created event tab, and remove it from the list. A tab navigated away from its event is left open.'
        : 'Permanently remove this session from the schedule and history.';
      remove.setAttribute('aria-label', `${remove.textContent}: ${schedule.url}`);
      remove.addEventListener('click', () => void scheduleAction(async () => {
        await changeSchedules({ type: 'REMOVE_SCHEDULE', id: schedule.id });
        scheduleActionStatus.textContent = 'Session removed from the schedule and history.';
      }));
      item.append(remove);
      return item;
    });
    scheduleList.replaceChildren(...items);
  }
  element('schedule-empty').hidden = schedules.length !== 0;
  updateScheduleControls();
}

async function changeSchedules(message: Record<string, unknown>): Promise<void> {
  const response = await send(message);
  if (!Array.isArray(response.schedules)) throw new Error('Could not read schedules. Reload the extension and try again.');
  renderSchedules(response.schedules);
}

async function refreshSchedules(): Promise<void> {
  if (schedulePolling || scheduleBusy) return;
  schedulePolling = true;
  const sequence = ++scheduleSequence;
  updateScheduleControls();
  try {
    const response = await send({ type: 'GET_SCHEDULES' });
    if (sequence !== scheduleSequence) return;
    if (!Array.isArray(response.schedules)) throw new Error('Schedules are unavailable. Reload the extension and refresh this page.');
    renderSchedules(response.schedules);
  } catch (error) {
    if (sequence === scheduleSequence) {
      scheduleLoadStatus.textContent = error instanceof Error ? error.message : 'Could not refresh schedules.';
    }
  } finally {
    schedulePolling = false;
    updateScheduleControls();
  }
}

async function scheduleAction(callback: () => Promise<void>): Promise<void> {
  if (scheduleBusy || !scheduleInitialized) return;
  scheduleBusy = true;
  ++scheduleSequence;
  updateScheduleControls();
  scheduleActionStatus.textContent = '';
  scheduleActionStatus.removeAttribute('data-state');
  try {
    await callback();
    scheduleActionStatus.dataset.state = 'success';
  } catch (error) {
    scheduleActionStatus.textContent = error instanceof Error ? error.message : 'Could not update the schedule.';
    scheduleActionStatus.dataset.state = 'error';
  } finally {
    scheduleBusy = false;
    updateScheduleControls();
  }
}

scheduleForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!scheduleForm.reportValidity()) return;
  void scheduleAction(async () => {
    const url = scheduleUrl(input('schedule-url').value).href;
    const startValue = input('schedule-start').value;
    const start = new Date(startValue);
    const startsAt = start.getTime();
    if (!Number.isFinite(startsAt) || startsAt <= Date.now() || localDateInput(start) !== startValue) {
      throw new Error('Choose a future date and a valid local time. Times skipped by daylight saving cannot be scheduled.');
    }
    const durationMinutes = Number(input('schedule-duration').value);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 480) {
      throw new Error('Choose a whole number of minutes between 1 and 480.');
    }
    const mode = element<HTMLSelectElement>('schedule-mode').value === 'auto' ? 'auto' : 'suggest';
    await changeSchedules({ type: 'ADD_SCHEDULE', url, startsAt, durationMinutes, mode });
    scheduleActionStatus.textContent = 'Session scheduled. Keep Edge running and your computer awake.';
  });
});
scheduleForm.addEventListener('input', updateSchedulePreview);
element('refresh-schedules').addEventListener('click', () => void refreshSchedules());
input('schedule-start').value = localDateInput(new Date(Date.now() + 30 * 60_000));
element('schedule-timezone').textContent = `All schedule times use this browser's local time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`;
updateSchedulePreview();
updateScheduleControls();
void refreshSchedules();
const scheduleTimer = window.setInterval(() => void refreshSchedules(), 5_000);
window.addEventListener('pagehide', () => window.clearInterval(scheduleTimer));
