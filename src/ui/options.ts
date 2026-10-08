import { type Settings } from '../shared/types';

interface Response {
  ok: boolean;
  error?: string;
  settings?: Settings;
  health?: { ready: boolean; demo: boolean; model: string };
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}
function input(id: string): HTMLInputElement { return element<HTMLInputElement>(id); }
const form = element<HTMLFormElement>('settings-form');
const saveButton = element<HTMLButtonElement>('save-settings');
const checkButton = element<HTMLButtonElement>('check-bridge');
const errorMessage = element('error-message');
let busy = false;

function showError(error: unknown): void {
  errorMessage.textContent = error instanceof Error ? error.message : String(error);
  errorMessage.hidden = false;
}

function populate(settings: Settings): void {
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
}

function readSettings(): Settings {
  return {
    bridgeToken: input('bridge-token').value.trim(), model: input('model').value.trim(),
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
  element('save-status').textContent = 'Settings saved. Start a session from the extension.';
  element('save-status').dataset.state = 'success';
}

async function action(callback: () => Promise<void>): Promise<void> {
  if (busy || !form.reportValidity()) return;
  busy = true;
  saveButton.disabled = true;
  checkButton.disabled = true;
  errorMessage.hidden = true;
  try { await callback(); } catch (error) { showError(error); }
  finally { busy = false; saveButton.disabled = false; checkButton.disabled = false; }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  void action(save);
});
form.addEventListener('input', () => {
  element('save-status').textContent = 'You have unsaved changes.';
  element('save-status').dataset.state = 'unsaved';
  element('bridge-status').textContent = 'Connection not checked with these settings.';
  element('bridge-status').removeAttribute('data-state');
});
checkButton.addEventListener('click', () => void action(async () => {
  await save();
  const status = element('bridge-status');
  status.textContent = 'Connecting to your local bridge…';
  status.removeAttribute('data-state');
  try {
    const response = await send({ type: 'CHECK_BRIDGE' });
    if (!response.health) throw new Error('The bridge returned an incomplete status.');
    const health = response.health;
    status.textContent = health.demo ? 'Connected · Demo answers enabled.'
      : health.ready ? 'Connected · API key configured. OpenAI access is checked when answering.' : 'Connected · Configure an API key on the backend to enable AI answers.';
    status.dataset.state = health.ready || health.demo ? 'success' : 'pending';
  } catch (error) {
    status.textContent = 'Unable to connect. Check that the bridge is running and the token is correct.';
    status.dataset.state = 'error';
    throw error;
  }
}));

saveButton.disabled = true;
checkButton.disabled = true;
void send({ type: 'GET_STATE' }).then(response => {
  if (!response.settings) throw new Error('Could not read extension settings.');
  populate(response.settings);
  saveButton.disabled = false;
  checkButton.disabled = false;
}).catch(showError);
