import type { Answer, CaptureRect, Choice, Observation, Question, QuestionField } from '../shared/types.js';
import type { LiveQuestion } from './wooclap.js';

// Selectors follow the public participant components (GuessNumber, OpenQuestion,
// FillInTheBlanks, Matching and the shared Dropdown), not organizer controls.
const titleSelector = '[data-test-id="Question.participant.title"]';
const inputSelector = 'input[type="text"], input[type="number"], input:not([type])';
const blankSelector = `${inputSelector}, button[role="combobox"][aria-haspopup="listbox"]`;
const compact = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
const unsupported = (detail: string): Observation => ({ question: null, state: 'unsupported', detail });
const waiting = (detail: string): Observation => ({ question: null, state: 'waiting', detail });
const dropdownCache = new WeakMap<HTMLElement, { context: string; options: Choice[]; capturedAt: number }>();
const preparations = new WeakMap<Document, Promise<void>>();

function visible(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false;
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.opacity === '0') return false;
  }
  return true;
}

function query(scope: ParentNode, selector: string): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter(visible);
}

function label(element: Element): string {
  const read = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    if (!visible(el) || el.matches('script, style, svg, [role="img"], i[class*="fa-"], label')) return '';
    return Array.from(node.childNodes).map(read).join('');
  };
  return compact(read(element));
}

function bounds(elements: Element[], doc: Document): CaptureRect {
  const boxes = elements.map(element => element.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
  const left = boxes.length ? Math.min(...boxes.map(box => box.left)) : 0;
  const top = boxes.length ? Math.min(...boxes.map(box => box.top)) : 0;
  const right = boxes.length ? Math.max(...boxes.map(box => box.right)) : 0;
  const bottom = boxes.length ? Math.max(...boxes.map(box => box.bottom)) : 0;
  return { x: left, y: top, width: right - left, height: bottom - top,
    viewportWidth: doc.defaultView?.innerWidth ?? 0, viewportHeight: doc.defaultView?.innerHeight ?? 0 };
}

function disabled(control: HTMLElement): boolean {
  return control.matches(':disabled, [readonly], [aria-disabled="true"], [aria-readonly="true"]');
}

function numericAttribute(control: HTMLElement, name: string): number | undefined {
  const raw = control.getAttribute(name);
  if (raw === null || !raw.trim()) return undefined;
  const result = Number(raw);
  return Number.isFinite(result) ? result : undefined;
}

function limits(control: HTMLElement): { min?: number; max?: number; step?: number; maxLength?: number } {
  const result: ReturnType<typeof limits> = {};
  for (const [attribute, key] of [['min', 'min'], ['max', 'max'], ['step', 'step'], ['maxlength', 'maxLength']] as const) {
    const value = numericAttribute(control, attribute);
    if (value !== undefined && (key !== 'maxLength' || value >= 0) && (key !== 'step' || value > 0)) result[key] = value;
  }
  return result;
}

/** Preserve the actual sentence around each blank, excluding the selected answer. */
function blankText(scope: Element, title: Element, controls: HTMLElement[]): string {
  const indices = new Map(controls.map((control, index) => [control, index + 1]));
  const read = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const el = node as HTMLElement;
    if (el === title || !visible(el)) return '';
    const index = indices.get(el);
    if (index) return ` [blank-${index}] `;
    if (el.matches('button, input, textarea, select, nav, script, style, svg, [role="img"], [role="alert"], [role="listbox"], [role="timer"]')) return '';
    const text = Array.from(el.childNodes).map(read).join('');
    return el.matches('p, div, section, br') ? ` ${text} ` : text;
  };
  return compact(read(scope));
}

function blankContext(scope: Element, title: Element, controls: HTMLElement[]): string {
  return JSON.stringify([scope.ownerDocument.URL, label(title), blankText(scope, title, controls),
    controls.map(control => [control.tagName, control.getAttribute('aria-label')])]);
}

function dropdownOptions(control: HTMLElement): { elements: HTMLElement[]; options: Choice[] } | null {
  if (control.getAttribute('aria-expanded') !== 'true') return null;
  const owner = control.parentElement;
  if (!owner) return null;
  const lists = query(owner, '[role="listbox"]').filter(list => list.id === control.getAttribute('aria-controls'));
  if (lists.length !== 1) return null;
  const elements = query(lists[0], '[role="option"]');
  if (elements.length < 1 || elements.length > 50 || elements.some(el => disabled(el) || query(el, 'img, svg, audio, video, canvas').length)) return null;
  const options = elements.map((element, index) => ({ id: `option-${index + 1}`, text: label(element) }));
  if (options.some(option => !option.text) || new Set(options.map(option => option.text)).size !== options.length) return null;
  return { elements, options };
}

async function waitFor<T>(read: () => T | null | false | undefined, assertActive: () => void, detail: string): Promise<T> {
  const deadline = Date.now() + 900;
  while (Date.now() < deadline) {
    assertActive();
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(detail);
}

/** Open closed-choice blank menus only to inspect rendered options; never selects an answer. */
export function prepareStructured(doc: Document, assertActive: () => void = () => {}): Promise<void> {
  const running = preparations.get(doc);
  if (running) return running;
  const operation = (async () => {
    const titles = query(doc, titleSelector);
    if (titles.length !== 1) return;
    const title = titles[0];
    const scope = title.closest('.FillInTheBlanks');
    if (!scope || query(scope, '[data-test-id="participant-feedback-banner"]').length) return;
    const controls = query(scope, blankSelector);
    const context = blankContext(scope, title, controls);
    const current = () => scope.isConnected && title.isConnected && blankContext(scope, title, query(scope, blankSelector)) === context;
    for (const control of controls.filter(item => item.matches('button[role="combobox"]'))) {
      assertActive();
      if (!current()) return;
      if (disabled(control)) continue;
      const cache = dropdownCache.get(control);
      if (cache?.context === context && Date.now() - cache.capturedAt < 30_000) continue;
      const wasOpen = control.getAttribute('aria-expanded') === 'true';
      try {
        if (!wasOpen) control.click();
        const rendered = await waitFor(() => current() && dropdownOptions(control), assertActive, 'Blank dropdown options could not be read.');
        dropdownCache.set(control, { context, options: rendered.options, capturedAt: Date.now() });
      } catch (error) {
        dropdownCache.delete(control);
        assertActive();
        // Extraction will explain the unavailable dropdown; no guessed choices.
        if (!current()) return;
      } finally {
        if (!wasOpen && control.isConnected && control.getAttribute('aria-expanded') === 'true') control.click();
      }
    }
  })();
  preparations.set(doc, operation);
  void operation.finally(() => preparations.delete(doc)).catch(() => {});
  return operation;
}

export function extractStructured(scope: Element, title: Element, eventKey: string, doc: Document): LiveQuestion | Observation | null {
  const type = ['GuessNumber', 'OpenQuestion', 'WordCloud', 'FillInTheBlanks', 'Matching'].find(name => scope.classList.contains(name));
  if (!type) return null;
  if (!label(title)) return unsupported('The question title is empty.');
  if (query(scope, '[data-test-id="Participant.Submit"]').length !== 1) return waiting('Wooclap is not accepting a submission for this question.');
  const question: Question = { kind: 'text', wooclapType: type, source: 'wooclap', eventKey,
    questionId: null, text: label(title), choices: [], multiple: false, imageKeys: [], application: 'automatic', responseMode: 'single' };
  const controls = new Map<string, HTMLElement>();
  if (type === 'GuessNumber') {
    const inputs = query(scope, 'input[aria-live="polite"]');
    if (inputs.length !== 1 || query(scope, 'input:not([type="hidden"])').length !== 1 || query(scope, 'textarea, select, [contenteditable="true"]').length) return unsupported('The numeric answer field is missing or ambiguous.');
    if (disabled(inputs[0])) return waiting('The numeric answer field is closed.');
    if (!inputs[0].matches(inputSelector)) return unsupported('The numeric answer control is not a supported input.');
    controls.set('answer', inputs[0]);
    question.kind = 'numeric';
    question.constraints = limits(inputs[0]);
    // Public GuessNumber prints limits in visible paragraphs rather than input min/max.
    const descriptions = query(scope, 'p').filter(el => !el.closest('nav, [role="alert"], [aria-live], [role="status"]') && !title.contains(el)).map(label).filter(Boolean);
    if (descriptions.length) question.text += `\n${descriptions.join('\n')}`;
  } else if (type === 'OpenQuestion' || type === 'WordCloud') {
    const inputs = query(scope, 'textarea#send-message-textarea[data-test-id="TextareaAnswerQuestion"]');
    if (inputs.length !== 1 || query(scope, 'textarea').length !== 1 || query(scope, 'input:not([type="hidden"]), select, [contenteditable="true"]').length) return unsupported('The text answer field is missing or ambiguous.');
    if (disabled(inputs[0])) return waiting('The text answer field is closed.');
    controls.set('answer', inputs[0]);
    question.constraints = limits(inputs[0]);
    // Both share the OpenQuestion component; the DOM may not disclose multipleAnswers.
    // Treat all as one contribution per appearance to prevent repeated messages.
    question.responseMode = 'contribution';
  } else if (type === 'FillInTheBlanks') {
    const inputs = query(scope, blankSelector);
    if (!inputs.length || inputs.length > 30 || query(scope, 'input:not([type="hidden"])').some(input => !inputs.includes(input))
      || query(scope, 'textarea, select, [contenteditable="true"]').length) return unsupported('The blank answer controls are missing or ambiguous.');
    if (inputs.some(disabled)) return waiting('The blank answer fields are closed.');
    const context = blankContext(scope, title, inputs);
    const fields: QuestionField[] = [];
    for (const [index, control] of inputs.entries()) {
      const id = `blank-${index + 1}`;
      controls.set(id, control);
      if (control.matches('button[role="combobox"]')) {
        const cache = dropdownCache.get(control);
        if (!cache || cache.context !== context) return unsupported('A closed-choice blank needs its visible dropdown options to be read first.');
        fields.push({ id, label: `Blank ${index + 1}`, kind: 'select', required: true, options: cache.options });
      } else fields.push({ id, label: `Blank ${index + 1}`, kind: 'text', required: true, ...limits(control) });
    }
    question.kind = 'fields';
    question.fields = fields;
    question.text += `\n${blankText(scope, title, inputs)}`;
  } else {
    const inputs = query(scope, 'select[name="answer"][aria-labelledby]') as HTMLSelectElement[];
    if (inputs.length < 2 || inputs.length > 30 || query(scope, 'select').length !== inputs.length
      || query(scope, 'input:not([type="hidden"]), textarea, [contenteditable="true"]').length) return unsupported('The matching answer controls are missing or ambiguous.');
    if (inputs.some(disabled)) return waiting('The matching answer fields are closed.');
    const fields: QuestionField[] = [];
    for (const control of inputs) {
      const labelledBy = control.getAttribute('aria-labelledby') ?? '';
      const source = query(scope, '[id]').filter(el => el.id === labelledBy);
      const id = labelledBy.startsWith('choice-text-') ? labelledBy.slice('choice-text-'.length) : '';
      const options = Array.from(control.options).filter(option => option.value !== 'none').map(option => ({
        id: option.value, text: compact(option.textContent).replace(/^✓\s*/, '')
      }));
      if (!id || id.length > 256 || source.length !== 1 || !label(source[0]) || controls.has(id)
        || options.length < 2 || options.length > 50 || options.some(option => !option.id || !option.text)
        || new Set(options.map(option => option.id)).size !== options.length) return unsupported('The matching labels or destinations are missing or ambiguous.');
      controls.set(id, control);
      fields.push({ id, label: label(source[0]), kind: 'select', required: true, options });
    }
    question.kind = 'matching';
    question.fields = fields;
    question.constraints = { uniqueTargets: true };
  }
  return { question, scope, controls, rect: bounds([title, ...controls.values()], doc) };
}

function setInputValue(control: HTMLElement, value: string): void {
  const win = control.ownerDocument.defaultView;
  if (!win) throw new Error('The answer document is unavailable.');
  const prototype = control.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype
    : control.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('The answer control cannot accept a value.');
  control.focus();
  setter.call(control, value);
  // Bypass React's instance value tracker, then notify its delegated handlers.
  control.dispatchEvent(new win.Event('input', { bubbles: true }));
  control.dispatchEvent(new win.Event('change', { bubbles: true }));
  control.blur();
}

function expectedEntries(question: Question, answer: Answer): { id: string; value: string }[] {
  if (question.kind === 'numeric' || question.kind === 'text') return [{ id: 'answer', value: answer.value ?? '' }];
  return answer.values ?? [];
}

function currentValue(control: HTMLElement): string {
  return control.matches('button[role="combobox"]') ? label(control)
    : (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
}

function expectedValue(question: Question, id: string, value: string, control: HTMLElement): string {
  if (!control.matches('button[role="combobox"]')) return value;
  return question.fields?.find(field => field.id === id)?.options?.find(option => option.id === value)?.text ?? '';
}

function decimalKey(value: string): string | null {
  const match = value.trim().replace(',', '.').match(/^([+-]?)(\d*)(?:\.(\d*))?$/);
  if (!match || (!match[2] && !match[3])) return null;
  const integer = (match[2] || '0').replace(/^0+(?=\d)/, '');
  const fraction = (match[3] || '').replace(/0+$/, '');
  const sign = match[1] === '-' && (integer !== '0' || fraction) ? '-' : '';
  return `${sign}${integer}${fraction ? `.${fraction}` : ''}`;
}

function numericValuesEqual(actual: string, expected: string): boolean {
  const value = decimalKey(expected);
  return value !== null && decimalKey(actual) === value;
}

// The observed GuessNumber handler parses the displayed decimal into a JavaScript
// number. A raw input string can survive while that backing value was rounded.
function numericValueRoundTrips(value: string): boolean {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return false;
  let rendered = String(numeric);
  const scientific = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(rendered);
  if (scientific) {
    const digits = scientific[2] + (scientific[3] ?? '');
    const position = scientific[2].length + Number(scientific[4]);
    rendered = scientific[1] + (position <= 0 ? `0.${'0'.repeat(-position)}${digits}`
      : position >= digits.length ? digits + '0'.repeat(position - digits.length)
        : `${digits.slice(0, position)}.${digits.slice(position)}`);
  }
  return numericValuesEqual(rendered, value);
}

export function structuredResponseSnapshot(live: LiveQuestion): string {
  return JSON.stringify(Array.from(live.controls, ([id, control]) => [id, currentValue(control)]));
}

export function verifyStructured(live: LiveQuestion, answer: Answer): boolean {
  const entries = expectedEntries(live.question, answer);
  if (entries.length !== live.controls.size) return false;
  return entries.every(({ id, value }) => {
    const control = live.controls.get(id);
    if (!control || disabled(control)) return false;
    const expected = expectedValue(live.question, id, value, control);
    const actual = currentValue(control);
    // GuessNumber accepts either decimal separator and reformats on blur.
    if (live.question.kind === 'numeric') return numericValuesEqual(actual, value);
    return actual === expected;
  });
}

/** Populate all inputs; the caller revalidates and clicks the shared submit button. */
export async function applyStructured(question: Question, answer: Answer,
  readCurrent: () => LiveQuestion, assertActive: () => void = () => {}): Promise<void> {
  const entries = expectedEntries(question, answer);
  const initial = readCurrent();
  if (!entries.length || entries.length !== initial.controls.size || new Set(entries.map(entry => entry.id)).size !== entries.length
    || entries.some(entry => !entry.value || !initial.controls.has(entry.id))) throw new Error('The answer does not cover every current field.');
  if (question.kind === 'numeric' && !numericValueRoundTrips(entries[0].value)) {
    throw new Error('Wooclap would round this number. Review the required precision before submitting.');
  }
  if (question.kind === 'matching' && question.constraints?.uniqueTargets && new Set(entries.map(entry => entry.value)).size !== entries.length) {
    throw new Error('This matching layout requires a different destination for each source.');
  }
  // Validate every destination before changing any field.
  for (const entry of entries) {
    const field = question.fields?.find(item => item.id === entry.id);
    if (field?.kind === 'select' && !field.options?.some(option => option.id === entry.value)) throw new Error('An answer destination is no longer available.');
  }
  for (const entry of entries) {
    assertActive();
    const live = readCurrent();
    const control = live.controls.get(entry.id);
    if (!control || disabled(control)) throw new Error('An answer field is no longer available.');
    if (control.matches('button[role="combobox"]')) {
      const wasOpen = control.getAttribute('aria-expanded') === 'true';
      try {
        if (!wasOpen) control.click();
        const rendered = await waitFor(() => dropdownOptions(control), assertActive, 'The blank dropdown did not open.');
        const expected = question.fields?.find(field => field.id === entry.id)?.options;
        if (JSON.stringify(rendered.options) !== JSON.stringify(expected)) throw new Error('Blank dropdown options changed after the answer was prepared.');
        assertActive();
        readCurrent();
        const index = rendered.options.findIndex(option => option.id === entry.value);
        if (index < 0) throw new Error('The blank option is no longer available.');
        rendered.elements[index].click();
      } finally {
        if (control.isConnected && control.getAttribute('aria-expanded') === 'true') control.click();
      }
    } else setInputValue(control, entry.value);
    await waitFor(() => {
      const current = readCurrent();
      const updated = current.controls.get(entry.id);
      if (!updated) return false;
      const actual = currentValue(updated);
      const expected = expectedValue(question, entry.id, entry.value, updated);
      return question.kind === 'numeric' ? numericValuesEqual(actual, entry.value) : actual === expected;
    }, assertActive, 'Wooclap did not retain the answer value.');
  }
  // Give controlled inputs a render turn before verifying the entire form together.
  await new Promise(resolve => setTimeout(resolve, 50));
  assertActive();
  if (!verifyStructured(readCurrent(), answer)) throw new Error('The answer values changed before submission.');
}
