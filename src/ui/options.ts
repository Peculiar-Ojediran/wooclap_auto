import { BRIDGE_URL, DEFAULT_SETTINGS, PROVIDER_LABELS, PROVIDER_MODELS, type ConnectionMode, type Provider, type ResponseTransport, type Settings } from '../shared/types';
import { HOSTED_FALLBACK_URL } from '../shared/hosted-config';

type Credentials = Record<Provider, { configured: boolean; storage: 'session' | 'local' | 'none' }>;
interface Response {
  ok: boolean;
  error?: string;
  settings?: Settings;
  credentials?: Credentials;
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
