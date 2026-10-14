import type { Answer, Choice, Observation, Question } from '../shared/types.js';
import { fingerprint, validateAnswer } from '../shared/core.js';
import type { AdvancedQuestion } from './advanced.js';

// Public participant builds 14.111.0 and 14.111.2: Brainstorm / Framework, Dropdown,
// InputCard / Framework InteractionInput and AnswerText. See the evidence doc.
const compact = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
const waiting = (detail: string): Observation => ({ question: null, state: 'waiting', detail });
const unsupported = (detail: string): Observation => ({ question: null, state: 'unsupported', detail });
const categoryCache = new WeakMap<Element, { context: string; choices: Choice[]; capturedAt: number }>();
const preparations = new WeakMap<Document, Promise<void>>();
type Extraction = AdvancedQuestion | Observation;
type Receipt = { scope: Element; title: Element | null; question: Question; previous: Set<string>; value: string; category: Choice; confirmed: boolean };
const receipts = new WeakMap<Document, Receipt>();

function visible(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const css = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (node.hasAttribute('hidden') || css?.display === 'none' || css?.visibility === 'hidden' || css?.opacity === '0') return false;
  }
  return true;
}
function query(scope: ParentNode, selector: string): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter(visible);
}
function disabled(el: HTMLElement): boolean {
  return el.matches(':disabled,[readonly],[aria-disabled="true"],[aria-readonly="true"]') || !!el.closest('[inert]');
}
function text(el: Element | null): string {
  if (!el) return '';
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('script,style,svg,i[class*="fa-"],input,textarea,[hidden]').forEach(node => node.remove());
  return compact(clone.textContent);
}
const context = (scope: Element) => `${scope.ownerDocument.URL}|${text(scope.querySelector('[data-test-id="Question.participant.title"]'))}`;
const closed = (scope: Element) => query(scope, '[data-test-id="participant-feedback-banner"]').length > 0;
function brainstormInput(scope: Element): HTMLTextAreaElement | null {
  // The answer board may contain edit fields; never confuse them with InputCard.
  const inputs = query(scope, 'textarea').filter(el => !el.closest('[id^="answer-"]'));
  return inputs.length === 1 ? inputs[0] as HTMLTextAreaElement : null;
}
function brainstormMenu(scope: Element): HTMLElement | null {
  const input = brainstormInput(scope);
  if (!input) return null;
  const menus = query(scope, 'button[role="combobox"][aria-haspopup="listbox"]')
    .filter(menu => Boolean(menu.compareDocumentPosition(input) & 4));
  return menus.length === 1 ? menus[0] : null;
}
function displayCategory(menu: HTMLElement): string {
  // Dropdown's button is empty in the inspected component; DisplayName is a sibling.
  const clone = menu.parentElement?.cloneNode(true) as Element | undefined;
  if (!clone) return '';
  clone.querySelectorAll('label,[role="listbox"],svg,i[class*="fa-"]').forEach(el => el.remove());
  return text(clone);
}
function options(menu: HTMLElement): { choices: Choice[]; elements: HTMLElement[] } | null {
  if (menu.getAttribute('aria-expanded') !== 'true' || !menu.parentElement) return null;
  const lists = query(menu.parentElement, '[role="listbox"]').filter(el => el.id === menu.getAttribute('aria-controls'));
  if (lists.length !== 1) return null;
  const elements = query(lists[0], '[role="option"]');
  if (!elements.length || elements.length > 30 || elements.some(disabled)) return null;
  const choices = elements.map((el, index) => ({ id: `category-${index}`, text: text(el) }));
  return choices.some(choice => !choice.text) || new Set(choices.map(choice => choice.text)).size !== choices.length ? null : { choices, elements };
}
async function waitFor<T>(read: () => T | null | false | undefined, guard: () => void, failure: string): Promise<T> {
  const deadline = Date.now() + 1400;
  while (Date.now() < deadline) {
    guard();
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(failure);
}

/** Open only the contribution category menu, read rendered options, and restore it. */
export async function prepareContributions(doc: Document, assertActive: () => void = () => {}): Promise<void> {
  const running = preparations.get(doc);
  if (running) return running;
  const pending = (async () => {
    const scopes = query(doc, '.Brainstorm').filter(scope => scope.querySelector('[data-test-id="Question.participant.title"]'));
    if (scopes.length !== 1 || closed(scopes[0])) return;
    const scope = scopes[0], menu = brainstormMenu(scope), cached = categoryCache.get(scope), key = context(scope);
    if (!menu || disabled(menu) || disabled(brainstormInput(scope)!)) return;
    if (cached?.context === key && Date.now() - cached.capturedAt < 30_000) return;
    const wasOpen = menu.getAttribute('aria-expanded') === 'true';
    const guard = () => { assertActive(); if (!scope.isConnected || context(scope) !== key || closed(scope)) throw new Error('The contribution question changed.'); };
    try {
      guard();
      if (!wasOpen) menu.click();
      const rendered = await waitFor(() => options(menu), guard, 'Brainstorm categories could not be read.');
      categoryCache.set(scope, { context: key, choices: rendered.choices, capturedAt: Date.now() });
    } finally {
      if (!wasOpen && menu.isConnected && menu.getAttribute('aria-expanded') === 'true') {
        guard();
        menu.click();
      }
    }
  })();
  preparations.set(doc, pending);
  try { await pending; } finally { preparations.delete(doc); }
}

function submitControl(scope: Element, input: HTMLInputElement | HTMLTextAreaElement): HTMLElement | null {
  // Stop at the nearest input container with its own send button. Do not pick
  // answer-board editing/liking buttons or a different question's submit button.
  for (let parent = input.parentElement; parent && parent !== scope; parent = parent.parentElement) {
    const sends = query(parent, 'button[aria-label]').filter(button => button.querySelector('.fa-paper-plane,[data-icon="paper-plane"]')
      || (disabled(button) && button.querySelector('.fa-sync,.fa-spinner,[data-icon="sync"],[data-icon="spinner"]')));
    if (sends.length === 1) return sends[0];
    if (sends.length > 1) return null;
  }
  return null;
}
function frameworkInput(scope: Element): HTMLInputElement | null {
  const inputs = query(scope, 'input#framework-answer-input');
  return inputs.length === 1 ? inputs[0] as HTMLInputElement : null;
}
function frameworkSelected(scope: Element, choices: Choice[]): string | null {
  const input = frameworkInput(scope);
  if (!input) return null;
  const label = query(scope, 'label[for="framework-answer-input"]');
  const name = label.length === 1 ? text(label[0]) : compact(input.getAttribute('aria-label'));
  const match = choices.filter(choice => choice.text === name);
  return match.length === 1 ? match[0].id : null;
}
function characterLimit(input: HTMLTextAreaElement): number | null {
  if (input.maxLength > 0) return input.maxLength;
  const footer = input.parentElement?.nextElementSibling;
  const counter = footer?.firstElementChild;
  const counts = counter && !counter.matches('button') ? text(counter).match(/\d+/g) : null;
  const used = input.value.length + (input.value.match(/\r\n|\r|\n/g)?.length ?? 0);
  const limit = counts?.length === 1 ? Number(counts[0]) + used : null;
  return limit !== null && limit > 0 && limit <= 20_000 ? limit : null;
}
function assetKey(value: string): string {
  if (value.length < 1900) return value;
  let hash = 0x811c9dc5;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return `asset:${value.length}:${(hash >>> 0).toString(16)}`;
}

export function extractContributions(scope: Element, title: Element, eventKey: string, doc: Document): Extraction | null {
  const type = scope.matches('.Brainstorm') ? 'Brainstorm' : scope.matches('.Framework') ? 'Framework' : null;
  if (!type) return null;
  if (closed(scope)) return waiting('The contribution question is closed.');
  if (!text(title)) return unsupported('The contribution title is missing.');
  if (query(scope, 'audio,video,canvas,[contenteditable="true"]').length) return unsupported('This contribution contains unsupported media or editable controls.');
  if (query(scope, 'svg').some(svg => !svg.matches('[data-icon],.svg-inline--fa') && !svg.closest('[id^="answer-"]'))) return unsupported('This contribution contains an unsupported SVG diagram.');
  const controls = new Map<string, HTMLElement>();
  let choices: Choice[], maxLength: number;
  if (type === 'Brainstorm') {
    const input = brainstormInput(scope), menu = brainstormMenu(scope), cached = categoryCache.get(scope);
    if (!input || !menu) return unsupported('The contribution form or category chooser is missing or ambiguous.');
    if (disabled(input) || disabled(menu)) return waiting('Brainstorming is not accepting contributions.');
    if (query(scope, 'input:not([type="hidden"]),textarea,select').length !== 1) return unsupported('Close other answer editing fields before contributing.');
    if (!cached || cached.context !== context(scope)) return waiting('Reading the available brainstorming categories.');
    choices = cached.choices;
    const limit = characterLimit(input);
    if (!limit) return unsupported('The contribution character limit is not visible.');
    maxLength = limit;
    if (!submitControl(scope, input)) return unsupported('The contribution send button is missing or ambiguous.');
    controls.set('input', input); controls.set('category', menu);
  } else {
    const labels = query(scope, 'h3[id^="category-"]');
    choices = labels.map(label => ({ id: label.id, text: text(label) }));
    if (!choices.length || choices.length > 30 || choices.some((choice, i) => choice.id !== `category-${i}` || !choice.text)
      || new Set(choices.map(choice => choice.text)).size !== choices.length) return unsupported('Framework category labels are missing, duplicated, or out of order.');
    for (const label of labels) {
      const pins = label.parentElement ? query(label.parentElement, 'button[aria-label]')
        .filter(button => compact(button.getAttribute('aria-label')).endsWith(` ${text(label)}`)) : [];
      if (pins.length !== 1 || disabled(pins[0])) return unsupported('A framework category pin is missing or unavailable.');
      controls.set(label.id, pins[0]);
    }
    const input = frameworkInput(scope);
    if (query(scope, 'input:not([type="hidden"]),textarea,select').length !== (input ? 1 : 0)) return unsupported('Close other answer editing fields before contributing.');
    if (input && disabled(input)) return waiting('Framework is not accepting contributions.');
    if (input && (input.maxLength !== 180 || !submitControl(scope, input) || !frameworkSelected(scope, choices))) return unsupported('The framework input category or send button is ambiguous.');
    if (input) controls.set('input', input);
    maxLength = 180; // Native limit in Framework InteractionInput, checked again after opening.
  }
  const images = query(scope, 'img').filter(img => !img.closest('[id^="answer-"]')) as unknown as HTMLImageElement[];
  if (type === 'Framework' && images.length !== 1) return unsupported('Framework requires one identifiable diagram.');
  if (images.length > 16) return unsupported('Too many contribution images.');
  if (images.some(img => !img.complete || !img.naturalWidth)) return waiting('Waiting for contribution images.');
  const question: Question = { source: 'wooclap', eventKey, questionId: null, wooclapType: type,
    kind: 'categorized', text: text(title), choices, multiple: false,
    constraints: { maxEntries: 1, maxLength }, application: 'automatic', responseMode: 'contribution',
    imageKeys: images.map(img => assetKey(`${img.currentSrc || img.src}|${compact(img.alt)}`)) };
  if (type === 'Framework') {
    const box = images[0].getBoundingClientRect();
    if (box.width > 0 && box.height > 0) question.imageKeys.push(`categories:${JSON.stringify(choices.map(choice => {
      const pin = controls.get(choice.id)!.getBoundingClientRect();
      return [choice.id, ...[(pin.left + pin.width / 2 - box.left) / box.width, (pin.top + pin.height / 2 - box.top) / box.height].map(value => Math.round(value * 10000) / 10000)];
    }))}`);
  }
  const boxes = [title, ...images, ...controls.values()].map(el => el.getBoundingClientRect()).filter(rect => rect.width && rect.height);
  const x = boxes.length ? Math.min(...boxes.map(rect => rect.left)) : 0, y = boxes.length ? Math.min(...boxes.map(rect => rect.top)) : 0;
  return { question, scope, controls, rect: { x, y,
    width: boxes.length ? Math.max(...boxes.map(rect => rect.right)) - x : 0,
    height: boxes.length ? Math.max(...boxes.map(rect => rect.bottom)) - y : 0,
    viewportWidth: doc.defaultView?.innerWidth ?? 0, viewportHeight: doc.defaultView?.innerHeight ?? 0 } };
}

export function snapshotContributions(live: AdvancedQuestion): string {
  const selected = live.question.wooclapType === 'Brainstorm' ? displayCategory(live.controls.get('category')!)
    : frameworkSelected(live.scope, live.question.choices);
  return JSON.stringify([selected, (live.controls.get('input') as HTMLInputElement | undefined)?.value ?? '']);
}
export function verifyContributions(live: AdvancedQuestion, answer: Answer): boolean {
  if (answer.values?.length !== 1) return false;
  const entry = answer.values[0], category = live.question.choices.find(choice => choice.id === entry.id);
  const input = live.controls.get('input') as HTMLInputElement | HTMLTextAreaElement | undefined;
  if (!category || !input || disabled(input) || input.value !== entry.value) return false;
  return live.question.wooclapType === 'Brainstorm' ? displayCategory(live.controls.get('category')!) === category.text
    : frameworkSelected(live.scope, live.question.choices) === category.id;
}
export async function applyContributions(question: Question, answer: Answer, readCurrent: () => Extraction,
  assertActive: () => void = () => {}): Promise<void> {
  const error = validateAnswer(question, answer);
  if (error) throw new Error(error);
  if (!['Brainstorm', 'Framework'].includes(question.wooclapType ?? '') || answer.values?.length !== 1) throw new Error('Expected exactly one contribution.');
  const entry = answer.values[0], original = fingerprint(question);
  if (question.wooclapType === 'Brainstorm'
    && entry.value.length + (entry.value.match(/\r\n|\r|\n/g)?.length ?? 0) > (question.constraints?.maxLength ?? 0)) throw new Error('The contribution exceeds the character limit including line breaks.');
  const current = () => {
    assertActive();
    const live = readCurrent();
    if (!('controls' in live) || fingerprint(live.question) !== original) throw new Error('The contribution question changed or is no longer available.');
    return live;
  };
  let live = current();
  if (question.wooclapType === 'Brainstorm') {
    const menu = live.controls.get('category')!;
    try {
      if (menu.getAttribute('aria-expanded') !== 'true') menu.click();
      const rendered = await waitFor(() => options(menu), () => { current(); }, 'The category chooser did not open.');
      if (JSON.stringify(rendered.choices) !== JSON.stringify(question.choices)) throw new Error('The contribution categories changed after generation.');
      current();
      rendered.elements[rendered.choices.findIndex(choice => choice.id === entry.id)].click();
    } finally {
      if (menu.isConnected && menu.getAttribute('aria-expanded') === 'true') {
        current();
        menu.click();
      }
    }
    await waitFor(() => displayCategory(current().controls.get('category')!) === question.choices.find(choice => choice.id === entry.id)!.text,
      assertActive, 'Wooclap did not retain the selected category.');
  } else {
    const pin = live.controls.get(entry.id);
    if (!pin || disabled(pin)) throw new Error('The framework category is unavailable.');
    pin.click();
    await waitFor(() => {
      const fresh = current(); return frameworkSelected(fresh.scope, question.choices) === entry.id && fresh.controls.get('input');
    }, assertActive, 'The selected framework contribution input did not open.');
  }
  live = current();
  const input = live.controls.get('input') as HTMLInputElement | HTMLTextAreaElement;
  // A draft in another framework category is never silently overwritten.
  if (input.value && input.value !== entry.value) throw new Error('This category contains an existing draft. Review it before replacing it.');
  const win = input.ownerDocument.defaultView!;
  const prototype = input.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  input.focus();
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, entry.value);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  input.blur();
  await waitFor(() => verifyContributions(current(), answer), assertActive, 'Wooclap did not retain the contribution.');
  await new Promise(resolve => setTimeout(resolve, 60));
  if (!verifyContributions(current(), answer)) throw new Error('The contribution changed before submission.');
}

/** Click the source-grounded send control once; the caller waits for positive receipt. */
export async function submitContributions(live: AdvancedQuestion, answer: Answer, assertActive: () => void = () => {}): Promise<void> {
  assertActive();
  if (!live.scope.isConnected || closed(live.scope) || !verifyContributions(live, answer)) throw new Error('The contribution changed before submission.');
  const input = live.controls.get('input') as HTMLInputElement | HTMLTextAreaElement;
  const button = submitControl(live.scope, input);
  if (!button || disabled(button)) throw new Error('The contribution send button is not ready.');
  const doc = live.scope.ownerDocument, entry = answer.values![0];
  receipts.set(doc, { scope: live.scope, title: live.scope.querySelector('[data-test-id="Question.participant.title"]'), question: live.question, previous: new Set(query(live.scope, '[id^="answer-"]').map(el => el.id)),
    value: entry.value, category: live.question.choices.find(choice => choice.id === entry.id)!, confirmed: false });
  assertActive(); button.click();
}

/** Both components append these own-answer rows only after a successful response. */
export function hasContributionsConfirmation(doc: Document): boolean {
  const receipt = receipts.get(doc);
  if (!receipt || !receipt.scope.isConnected || !receipt.title?.isConnected
    || context(receipt.scope) !== `${doc.URL}|${receipt.question.text}`) return false;
  if (receipt.confirmed) return true;
  const input = receipt.question.wooclapType === 'Brainstorm' ? brainstormInput(receipt.scope) : frameworkInput(receipt.scope);
  if (!input || input.value !== '') return false;
  const rows = query(receipt.scope, '[id^="answer-"]').filter(el => !receipt.previous.has(el.id) && text(el) === compact(receipt.value));
  const found = rows.some(row => {
    const parent = row.parentElement;
    if (!parent) return false;
    const ownerMenus = query(parent, '[aria-label][tabindex="0"]').filter(el => el.querySelector('.fa-ellipsis-v,[data-icon="ellipsis-v"]')
      && compact(el.getAttribute('aria-label')).endsWith(` - ${receipt.category.text}`));
    if (ownerMenus.length !== 1) return false;
    return receipt.question.wooclapType !== 'Framework'
      || query(parent, '[aria-labelledby]').some(el => el.getAttribute('aria-labelledby') === receipt.category.id);
  });
  if (found) receipt.confirmed = true;
  return found;
}
