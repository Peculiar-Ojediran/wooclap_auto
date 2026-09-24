import type { Answer, CaptureRect, Observation, Question } from '../shared/types';
import { fingerprint, validateAnswer } from '../shared/core';

/** Structural selectors inspected in Wooclap public participant build 14.111.0.
 * Unverified contribution and geometry interactions deliberately expose previews only.
 */
export const ADVANCED_TYPES = '.Rating, .Prioritization, .Brainstorm, .Framework, .LabelAnImage, .ShowOnImage, .DragAndDrop, .Concordance, .SCTJudgment';
export interface AdvancedQuestion {
  question: Question; scope: Element; controls: Map<string, HTMLElement>; rect: CaptureRect;
}
type Extraction = AdvancedQuestion | Observation;
const compact = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
const unsupported = (detail: string): Observation => ({ question: null, state: 'unsupported', detail });
const waiting = (detail: string): Observation => ({ question: null, state: 'waiting', detail });

function visible(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    // Meaningful Wooclap images can be aria-hidden; this checks rendering only.
    if (node.hasAttribute('hidden') || style?.display === 'none' || style?.visibility === 'hidden'
      || style?.visibility === 'collapse' || style?.opacity === '0') return false;
  }
  return true;
}
function query(scope: ParentNode, selector: string): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter(visible);
}
function text(element: Element | null): string {
  if (!element) return '';
  const clone = element.cloneNode(true) as Element;
  for (const ignored of clone.querySelectorAll('script,style,input,textarea,button,[hidden],[aria-hidden="true"]')) ignored.remove();
  return compact(clone.textContent);
}
function bounds(elements: Element[], doc: Document): CaptureRect {
  const boxes = elements.map(e => e.getBoundingClientRect()).filter(b => b.width > 0 && b.height > 0);
  const x = boxes.length ? Math.min(...boxes.map(b => b.left)) : 0;
  const y = boxes.length ? Math.min(...boxes.map(b => b.top)) : 0;
  return { x, y, width: boxes.length ? Math.max(...boxes.map(b => b.right)) - x : 0,
    height: boxes.length ? Math.max(...boxes.map(b => b.bottom)) - y : 0,
    viewportWidth: doc.defaultView?.innerWidth ?? 0, viewportHeight: doc.defaultView?.innerHeight ?? 0 };
}
function assetKey(value: string): string {
  if (value.length < 1900) return value;
  let hash = 0x811c9dc5;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return `asset:${value.length}:${(hash >>> 0).toString(16)}`;
}
function numericAttribute(element: Element, name: string): number | undefined {
  const value = element.getAttribute(name);
  if (value === null || !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
function disabled(element: HTMLElement): boolean {
  return element.matches(':disabled,[aria-disabled="true"]') || !!element.closest('[inert]');
}
function typeOf(scope: Element): string | undefined {
  return ADVANCED_TYPES.split(', ').map(s => s.slice(1)).find(type => scope.classList.contains(type));
}
function pinDecoration(svg: Element): boolean {
  if (!svg.closest('.LabelAnImage') || svg.getAttribute('viewBox') !== '0 0 160 160') return false;
  const sibling = svg.parentElement?.querySelector(':scope > button[aria-label]');
  if (!sibling || !/^[1-9]\d*$/.test(compact(sibling.textContent)) || ![1, 2].includes(svg.children.length)) return false;
  return Array.from(svg.children).every(circle => circle.tagName.toLowerCase() === 'circle'
    && circle.getAttribute('cx') === '80' && circle.getAttribute('cy') === '80'
    && circle.getAttribute('r') === '80' && circle.getAttribute('stroke-dasharray') === '565');
}

export function extractAdvanced(scope: Element, title: Element, eventKey: string, doc: Document): Extraction | null {
  const type = typeOf(scope);
  if (!type) return null;
  const prompt = text(title);
  if (!prompt) return unsupported('The question title is empty.');
  if (query(scope, 'audio,video,canvas').length) return unsupported('This question contains unsupported audio, video, or canvas content.');
  const diagrams = query(scope, 'svg').filter(svg => !svg.matches('[data-icon],.svg-inline--fa')
    // The inspected image pin component uses this circle as its decorative border.
    && !pinDecoration(svg));
  if (diagrams.length) return unsupported('Inline SVG diagrams require manual review; their image capture is not supported yet.');
  const images = query(scope, 'img').filter(img => !img.matches('[data-decorative],.icon,[data-icon],[role="presentation"]')) as unknown as HTMLImageElement[];
  if (images.some(img => !img.complete || img.naturalWidth === 0)) return waiting('Waiting for question images to load.');
  if (images.length > 16) return unsupported('This question contains too many images to capture.');
  const controls = new Map<string, HTMLElement>();
  const base: Question = { source: 'wooclap', eventKey, questionId: null, wooclapType: type,
    text: prompt, choices: [], multiple: false,
    imageKeys: images.map(img => assetKey(`${img.currentSrc || img.src}|${compact(img.alt)}`)),
    application: 'preview', responseMode: 'single' };
  const result = (question: Question, elements: Element[] = [scope]): AdvancedQuestion => ({ question, scope, controls, rect: bounds([title, ...elements, ...images], doc) });
  const hasSubmit = query(scope, '[data-test-id="Participant.Submit"]').length === 1;

  if (type === 'Rating') {
    if (!hasSubmit) return waiting('Rating is not accepting submissions.');
    if (query(scope, 'input,textarea,select').length) return unsupported('Rating contains an unexpected additional answer field.');
    const sliders = query(scope, '[role="slider"][aria-labelledby]');
    if (!sliders.length || sliders.length > 30) return unsupported('Rating propositions are missing or ambiguous.');
    const fields: NonNullable<Question['fields']> = [];
    for (const slider of sliders) {
      const labelId = slider.getAttribute('aria-labelledby') ?? '';
      const label = doc.getElementById(labelId);
      const min = numericAttribute(slider, 'aria-valuemin'), max = numericAttribute(slider, 'aria-valuemax');
      const options = query(slider, 'ul > li').map(row => text(row));
      if (!/^choice-text-.+/.test(labelId) || !label || !scope.contains(label) || !text(label)
        || min !== 1 || !Number.isInteger(max) || max! < 4 || max! > 10
        || options.length !== max || options.some((value, i) => value !== String(i + 1))) {
        return unsupported('The visible rating scale or proposition labels could not be read completely.');
      }
      const id = labelId.slice('choice-text-'.length);
      if (controls.has(id) || disabled(slider)) return unsupported('Rating controls are duplicated or unavailable.');
      controls.set(id, slider);
      fields.push({ id, label: text(label), kind: 'number', required: true, min, max, step: 1 });
    }
    return result({ ...base, kind: 'rating', fields, application: 'automatic' }, [title, ...sliders.map(s => s.closest('li') ?? s)]);
  }

  if (type === 'Prioritization') {
    if (!hasSubmit) return waiting('Prioritization is not accepting submissions.');
    const inputs = query(scope, 'input[type="number"][id^="choice-"]') as HTMLInputElement[];
    if (!inputs.length || inputs.length > 30 || query(scope, 'input:not([type="hidden"]),textarea,select').length !== inputs.length) return unsupported('Prioritization fields are missing or ambiguous.');
    const list = inputs[0].closest('ul');
    if (!list || inputs.some(input => input.closest('ul') !== list)) return unsupported('Prioritization fields do not share one list.');
    // The first child of the counter banner is the static budget instruction;
    // the second child is the changing points-left counter, which must not enter identity.
    const instruction = text(list.previousElementSibling?.firstElementChild ?? null);
    const numbers = instruction.match(/\d+/g) ?? [];
    const total = numbers.length === 1 ? Number(numbers[0]) : NaN;
    if (!Number.isSafeInteger(total) || total <= 0 || total > 100_000) return unsupported('The displayed allocation budget could not be read unambiguously.');
    const fields: NonNullable<Question['fields']> = [];
    for (const input of inputs) {
      const id = input.id.slice('choice-'.length), label = doc.getElementById(`choice-text-${id}`);
      if (!id || controls.has(id) || !label || !scope.contains(label) || !text(label) || disabled(input)) return unsupported('Allocation labels or controls are unavailable.');
      controls.set(id, input);
      fields.push({ id, label: text(label), kind: 'number', required: true, min: 0, max: total, step: 1 });
    }
    return result({ ...base, kind: 'allocation', text: `${prompt}\n${instruction}`, fields, constraints: { total }, application: 'automatic' }, [title, list]);
  }

  if (type === 'Brainstorm') {
    const inputs = query(scope, 'textarea') as HTMLTextAreaElement[];
    if (inputs.length !== 1 || disabled(inputs[0])) return waiting('Open the brainstorming contribution form to generate a draft.');
    const menus = query(scope, '[aria-haspopup="listbox"]');
    if (menus.length !== 1) return unsupported('The brainstorming category chooser is missing or ambiguous.');
    const category = compact(menus[0].textContent);
    if (!category) return unsupported('Choose a brainstorming category before generating a draft.');
    const id = 'category-current';
    controls.set(id, inputs[0]);
    // InputCard renders a remaining-characters span in the footer, rather than
    // a native maxlength. Restore the static total using the same public counter
    // semantics (UTF-16 length plus one extra unit for each line break).
    const footer = inputs[0].parentElement?.nextElementSibling;
    const counter = footer?.firstElementChild;
    const counterText = counter && !counter.matches('button') ? text(counter) : '';
    const counts = counterText.match(/\d+/g) ?? [];
    const used = inputs[0].value.length + (inputs[0].value.match(/\r\n|\r|\n/g)?.length ?? 0);
    const displayedLimit = counts.length === 1 ? Number(counts[0]) + used : undefined;
    const maxLength = inputs[0].maxLength > 0 ? inputs[0].maxLength
      : displayedLimit !== undefined && displayedLimit > 0 && displayedLimit <= 20_000 ? displayedLimit : 180;
    // Reading the current displayed category does not require opening menus or
    // inspecting React state. This preview intentionally drafts for that category only.
    return result({ ...base, kind: 'categorized', responseMode: 'contribution', choices: [{ id, text: category }],
      text: `${prompt}\nDraft one contribution for the currently selected category: ${category}.`,
      constraints: { maxEntries: 1, maxLength } }, [title, menus[0], inputs[0]]);
  }

  if (type === 'Framework') {
    const labels = query(scope, 'h3[id^="category-"]');
    const choices = labels.map(label => ({ id: label.id, text: text(label) }));
    if (!images.length || !choices.length || choices.length > 30 || choices.some(c => !c.text)
      || new Set(choices.map(c => c.id)).size !== choices.length) return unsupported('The framework image and category labels could not be read completely.');
    if (!query(scope, 'button[aria-label]').length) return waiting('The framework contribution controls are closed.');
    return result({ ...base, kind: 'categorized', responseMode: 'contribution', choices,
      text: `${prompt}\nDraft one contribution for one displayed framework category.`, constraints: { maxEntries: 1, maxLength: 180 } });
  }

  if (type === 'LabelAnImage') {
    const pins = query(scope, 'button[aria-label]').filter(pin => /^[1-9]\d*$/.test(compact(pin.textContent)));
    const numbers = pins.map(pin => Number(compact(pin.textContent)));
    if (!images.length || !pins.length || pins.length > 30 || numbers.some((n, i) => n !== i + 1)) return unsupported('The image caption markers could not be read completely.');
    const fields = pins.map((pin, i) => {
      const id = `marker-${i + 1}`;
      controls.set(id, pin);
      return { id, label: `Image marker ${i + 1}: ${pin.getAttribute('aria-label')}`, kind: 'text' as const, required: true, maxLength: 500 };
    });
    return result({ ...base, kind: 'fields', fields, text: `${prompt}\nGive a caption for every numbered image marker.` });
  }

  if (type === 'ShowOnImage') {
    if (!hasSubmit) return waiting('Find on image is not accepting submissions.');
    if (images.length !== 1) return unsupported('Find on image needs one unambiguous target image.');
    return result({ ...base, kind: 'point', choices: [{ id: 'point-1', text: 'One point on the target image' }],
      constraints: { maxEntries: 1 }, text: `${prompt}\nReturn one point relative to the image content: x is left-to-right and y is top-to-bottom, each from 0 to 1.` });
  }

  if (type === 'DragAndDrop') {
    if (!images.length) return unsupported('The drag-and-drop target image is missing.');
    // The inspected participant component renders each item as a numbered div + h6.
    const headings = query(scope, 'h6').filter(heading => /^[1-9]\d*$/.test(text(heading.previousElementSibling)));
    if (!headings.length || headings.length > 30 || headings.some((heading, i) => Number(text(heading.previousElementSibling)) !== i + 1 || !text(heading))) return unsupported('Drag-and-drop labels are missing or ambiguous.');
    const choices = headings.map((heading, i) => ({ id: `item-${i + 1}`, text: text(heading) }));
    return result({ ...base, kind: 'placements', choices,
      text: `${prompt}\nPlace every numbered label on the target image using x/y coordinates from 0 to 1 relative to the image content.` });
  }

  if (type === 'Concordance' || type === 'SCTJudgment') {
    if (!hasSubmit) return waiting('The scenario question is not accepting submissions.');
    const sliders = query(scope, '[role="slider"]');
    if (sliders.length !== 1) return unsupported('The scenario scale is missing or ambiguous.');
    const slider = sliders[0], min = numericAttribute(slider, 'aria-valuemin'), max = numericAttribute(slider, 'aria-valuemax');
    const positions = query(slider, 'ul > li');
    if (min !== -2 || max !== 2 || ![4, 5].includes(positions.length)) return unsupported('The scenario scale bounds are not recognized.');
    // Public ChoicesContainer is a <ul>; its context <li>, current-value <p>,
    // and slider <div> are siblings. Only the context row enters identity.
    const container = slider.parentElement;
    const contextRows = container?.matches('ul') ? query(container, ':scope > li') : [];
    if (contextRows.length !== 1) return unsupported('The full scenario context could not be isolated.');
    const context = text(contextRows[0]);
    if (!context) return unsupported('The full case and additional information are missing.');
    const values = positions.length === 5 ? [-2, -1, 0, 1, 2] : [-2, -1, 1, 2];
    const choices = values.map((value, i) => ({ id: `scale-${value}`, text: `Scale position ${i + 1} of ${values.length} (${value})` }));
    const visibleLabels = positions.map(position => text(position));
    return result({ ...base, kind: 'scenario', choices,
      text: `${prompt}\n${context}\nDisplayed scale: ${visibleLabels.join(' | ') || 'unlabelled positions'}. Exact custom scale descriptions are not all exposed in the participant form; do not assume their meaning. Review is required if the case does not establish the scale interpretation.` });
  }
  return null;
}

function numberValue(control: HTMLElement): string {
  return (control as HTMLInputElement).value ?? '';
}
export function advancedResponseSnapshot(live: AdvancedQuestion): string {
  return JSON.stringify(Array.from(live.controls, ([id, control]) => [id, control.matches('[role="slider"]')
    ? control.querySelector('[data-score]')?.getAttribute('data-score') ?? null : numberValue(control)]));
}
export function verifyAdvanced(live: AdvancedQuestion, answer: Answer): boolean {
  if (live.question.application !== 'automatic') return false;
  if (validateAnswer(live.question, answer)) return false;
  if (!answer.values || answer.values.length !== live.question.fields?.length) return false;
  return answer.values.every(({ id, value }) => {
    const control = live.controls.get(id);
    if (!control || disabled(control)) return false;
    if (live.question.kind === 'rating') {
      // aria-valuenow defaults to the minimum before the first response. data-score
      // is present only after a score is set, so the default cannot fake acceptance.
      const score = control.querySelector('[data-score]')?.getAttribute('data-score');
      return score !== null && score !== undefined && Number(score) === Number(value)
        && Number(control.getAttribute('aria-valuenow')) === Number(value);
    }
    return live.question.kind === 'allocation' && Number(numberValue(control) || '0') === Number(value);
  });
}

export async function applyAdvanced(question: Question, answer: Answer, readCurrent: () => Extraction, assertActive?: () => void): Promise<void> {
  if (question.application !== 'automatic' || !['rating', 'allocation'].includes(question.kind ?? '')) throw new Error('This question supports a preview only. Apply the suggested answer manually.');
  const error = validateAnswer(question, answer);
  if (error) throw new Error(error);
  const identity = fingerprint(question);
  const current = (): AdvancedQuestion => {
    assertActive?.();
    const live = readCurrent();
    if (!('controls' in live) || fingerprint(live.question) !== identity) throw new Error('The question changed before the answer could be applied.');
    return live;
  };
  const waitFor = async (check: (live: AdvancedQuestion) => boolean) => {
    const deadline = Date.now() + 800;
    while (!check(current())) {
      if (Date.now() >= deadline) throw new Error('Wooclap did not accept the proposed field value.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  for (const entry of answer.values ?? []) {
    const live = current(), control = live.controls.get(entry.id);
    if (!control || disabled(control)) throw new Error('An answer control is unavailable.');
    const win = control.ownerDocument.defaultView!;
    if (question.kind === 'rating') {
      const min = question.fields!.find(field => field.id === entry.id)!.min!;
      control.focus();
      control.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
      await waitFor(next => next.controls.get(entry.id)?.querySelector('[data-score]')?.getAttribute('data-score') === String(min));
      for (let value = min + 1; value <= Number(entry.value); value += 1) {
        const slider = current().controls.get(entry.id)!;
        slider.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        await waitFor(next => next.controls.get(entry.id)?.querySelector('[data-score]')?.getAttribute('data-score') === String(value));
      }
    } else {
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw new Error('The numeric input cannot be updated.');
      control.focus(); setter.call(control, entry.value);
      control.dispatchEvent(new win.Event('input', { bubbles: true }));
      control.dispatchEvent(new win.Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 50));
      await waitFor(next => Number(numberValue(next.controls.get(entry.id)!) || '0') === Number(entry.value));
    }
  }
  await waitFor(live => verifyAdvanced(live, answer)
    && query(live.scope, '[data-test-id="Participant.Submit"]').some(button => !disabled(button)));
}
