import type { Answer, Observation, Question } from '../shared/types';
import type { AdvancedQuestion } from './advanced';
import { pinDecoration } from './advanced';
import { fingerprint, validateAnswer } from '../shared/core';

/** Public participant builds 14.111.0 / 14.111.2: modules 69126, 87036, 44087,
 * 84118 and 39556. Only rendered DOM and ordinary browser events are used. */
export const IMAGE_TYPES = ['LabelAnImage', 'ShowOnImage', 'DragAndDrop'];
type Extraction = AdvancedQuestion | Observation;
const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
const unavailable = (detail: string): Observation => ({ question: null, state: 'unsupported', detail });
const pause = (ms = 35) => new Promise<void>(resolve => setTimeout(resolve, ms));
const visible = (element: Element): boolean => {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (node.hasAttribute('hidden') || style?.display === 'none' || style?.visibility === 'hidden' || style?.opacity === '0') return false;
  }
  return true;
};
const query = <T extends HTMLElement = HTMLElement>(scope: ParentNode, selector: string): T[] => Array.from(scope.querySelectorAll<T>(selector)).filter(visible);
const disabled = (element: Element) => element.matches(':disabled,[aria-disabled="true"]') || !!element.closest('[inert]');
function key(value: string): string {
  if (value.length < 1800) return value;
  let hash = 0x811c9dc5;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return `image:${value.length}:${(hash >>> 0).toString(16)}`;
}
function image(live: AdvancedQuestion): HTMLImageElement { return live.controls.get('@image') as HTMLImageElement; }
function rectKey(element: Element): number[] {
  const r = element.getBoundingClientRect();
  return [r.left, r.top, r.width, r.height].map(n => Math.round(n * 100) / 100);
}

/** Wooclap handlers normalize the displayed image box, not a letterboxed image.
 * Reject CSS cropping/padding/transforms instead of guessing a different mapping. */
function geometryError(img: HTMLImageElement, type: string): string | null {
  const r = img.getBoundingClientRect(), win = img.ownerDocument.defaultView!;
  if (!img.complete || !img.naturalWidth || !img.naturalHeight || r.width <= 0 || r.height <= 0) return 'The target image has not finished laying out.';
  const style = win.getComputedStyle(img);
  const fit = style.objectFit || 'fill';
  if (fit !== 'fill' && Math.abs(r.width / r.height - img.naturalWidth / img.naturalHeight) > 0.001) return 'Cropped or letterboxed target images need manual placement.';
  for (const p of ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'borderLeftWidth', 'borderRightWidth', 'borderTopWidth', 'borderBottomWidth'] as const) {
    if (parseFloat(style[p]) > 0) return 'Image padding or borders make the placement geometry ambiguous.';
  }
  for (let parent: Element | null = img; parent; parent = parent.parentElement) {
    const transform = win.getComputedStyle(parent).transform;
    if (transform && transform !== 'none') return 'Transformed image layouts need manual placement.';
  }
  if (type !== 'LabelAnImage') {
    const wrapper = type === 'ShowOnImage' ? img.parentElement?.parentElement : img.parentElement;
    if (!wrapper) return 'The image interaction wrapper is missing.';
    const b = wrapper.getBoundingClientRect();
    if (Math.abs(b.left - r.left) > 1 || Math.abs(b.top - r.top) > 1 || Math.abs(b.width - r.width) > 1) return 'The image and interaction origins do not match.';
  }
  return null;
}
function pins(live: AdvancedQuestion): Map<string, HTMLElement> {
  const img = image(live), type = live.question.wooclapType;
  const scope = type === 'ShowOnImage' ? img.parentElement?.parentElement : img.parentElement;
  const result = new Map<string, HTMLElement>();
  const seen = new Set<string>();
  if (!scope) return result;
  for (const node of query(scope, 'span,button')) {
    const value = clean(node.textContent), parent = node.parentElement;
    if (!parent || !/^(?:\+|[1-9]\d*)$/.test(value)) continue;
    const style = img.ownerDocument.defaultView!.getComputedStyle(parent);
    if (style.position !== 'absolute' || !Number.isFinite(parseFloat(style.left)) || !Number.isFinite(parseFloat(style.top))) continue;
    // The pin contains its label inside a span. Select the direct pin element only.
    if (node.parentElement?.matches('span,button')) continue;
    if (type === 'ShowOnImage' && (value !== '+' || !parent.querySelector('button [data-icon="times"],button .fa-times,button .fa-xmark'))) continue;
    const id = type === 'ShowOnImage' ? 'point-1' : `item-${value}`;
    if (seen.has(id)) { result.delete(id); continue; }
    seen.add(id);
    result.set(id, parent);
  }
  return result;
}
function pinPoint(pin: HTMLElement, img: HTMLImageElement): [number, number] {
  const r = pin.getBoundingClientRect(), b = img.getBoundingClientRect();
  return [(r.left + r.width / 2 - b.left) / b.width, (r.top + r.height / 2 - b.top) / b.height];
}
function captionInput(live: AdvancedQuestion): { marker: string; input: HTMLInputElement } | null {
  const inputs = query<HTMLInputElement>(live.scope, 'input:not([type="hidden"])');
  if (inputs.length !== 1 || !['text', ''].includes(inputs[0].type)) return null;
  const input = inputs[0], label = input.previousElementSibling;
  const number = clean(label?.textContent);
  return label?.matches('span') && /^[1-9]\d*$/.test(number) ? { marker: `marker-${number}`, input } : null;
}
const verifiedCaptions = new WeakMap<Element, { identity: string; values: string; input: HTMLInputElement; marker: string; snapshot: string }>();

export function extractImageInteraction(scope: Element, title: Element, eventKey: string, doc: Document): Extraction | null {
  const type = IMAGE_TYPES.find(type => scope.classList.contains(type));
  if (!type) return null;
  const prompt = clean(title.textContent), images = query<HTMLImageElement>(scope, 'img').filter(img => !img.matches('[data-icon],[data-decorative],.icon,[role="presentation"]'));
  if (!prompt || images.length !== 1) return unavailable('Image questions require one visible target image and a readable title.');
  if (query(scope, 'textarea,select,audio,video,canvas').length) return unavailable('Unexpected additional answer fields or media need manual review.');
  if (query(scope, 'svg').some(svg => !svg.matches('[data-icon],.svg-inline--fa') && !pinDecoration(svg))) return unavailable('Additional SVG diagrams require manual review.');
  if (images.some(img => !img.complete || !img.naturalWidth || !img.naturalHeight)) return { question: null, state: 'waiting', detail: 'Waiting for the target image to load.' };
  const img = images[0], error = geometryError(img, type);
  if (error) return unavailable(error);
  const buttons = query<HTMLButtonElement>(scope, '[data-test-id="Participant.Submit"]');
  if (buttons.length !== 1) return unavailable('The image question submit control is missing or ambiguous.');
  const controls = new Map<string, HTMLElement>([['@image', img]]);
  const base: Question = { source: 'wooclap', eventKey, questionId: null, wooclapType: type, text: prompt, choices: [], multiple: false,
    imageKeys: [key(`${img.currentSrc || img.src}|${img.alt}`)], application: 'automatic', responseMode: 'single' };
  const sr = scope.getBoundingClientRect();
  const result = (question: Question): AdvancedQuestion => ({ question, scope, controls, rect: { x: sr.left, y: sr.top, width: sr.width, height: sr.height,
    viewportWidth: doc.defaultView?.innerWidth ?? 0, viewportHeight: doc.defaultView?.innerHeight ?? 0 } });
  if (type === 'LabelAnImage') {
    const markers = query(scope, 'button[aria-label]').filter(button => /^[1-9]\d*$/.test(clean(button.textContent)));
    if (!markers.length || markers.length > 30 || markers.some((button, i) => clean(button.textContent) !== String(i + 1) || disabled(button))) return unavailable('The numbered caption markers could not be read completely.');
    for (const [i, marker] of markers.entries()) controls.set(`marker-${i + 1}`, marker);
    const q = result({ ...base, kind: 'fields', fields: markers.map((marker, i) => ({ id: `marker-${i + 1}`, label: `Image marker ${i + 1}: ${marker.getAttribute('aria-label')}`, kind: 'text', required: true, maxLength: 500 })),
      text: `${prompt}\nGive a caption for every numbered image marker.` });
    const inputs = query(scope, 'input:not([type="hidden"])');
    if (inputs.length && (!captionInput(q) || inputs.length !== 1 || !controls.has(captionInput(q)!.marker))) return unavailable('The selected caption field does not identify its marker.');
    // Marker locations are question content, unlike mutable participant text.
    q.question.imageKeys.push(`markers:${JSON.stringify(markers.map(marker => {
      const r = marker.getBoundingClientRect(), b = img.getBoundingClientRect();
      return [(r.left + r.width / 2 - b.left) / b.width, (r.top + r.height / 2 - b.top) / b.height].map(v => Math.round(v * 10000) / 10000);
    }))}`);
    return q;
  }
  if (query(scope, 'input:not([type="hidden"])').length) return unavailable('Unexpected additional input needs manual review.');
  if (type === 'ShowOnImage') {
    if (!img.parentElement?.matches('button') || disabled(img.parentElement)) return unavailable('The point-selection image button is unavailable.');
    controls.set('@surface', img.parentElement);
    return result({ ...base, kind: 'point', responseMode: 'contribution', choices: [{ id: 'point-1', text: 'One point on the target image' }], constraints: { maxEntries: 1 },
      text: `${prompt}\nReturn one point relative to the image content: x is left-to-right and y is top-to-bottom, each from 0 to 1.` });
  }
  if (img.draggable !== false || !img.parentElement?.matches('div')) return unavailable('The image placement surface is not recognized.');
  controls.set('@surface', img.parentElement);
  const headings = query(scope, 'h6');
  if (!headings.length || headings.length > 30 || headings.some((h, i) => !clean(h.textContent) || clean(h.previousElementSibling?.textContent) !== String(i + 1) || !h.parentElement?.matches('div') || disabled(h.parentElement))) return unavailable('Drag-and-drop item labels are missing or ambiguous.');
  headings.forEach((h, i) => controls.set(`item-${i + 1}`, h.parentElement!));
  return result({ ...base, kind: 'placements', choices: headings.map((h, i) => ({ id: `item-${i + 1}`, text: clean(h.textContent) })),
    text: `${prompt}\nPlace every numbered label on the target image using x/y coordinates from 0 to 1 relative to the image content.` });
}

export function snapshotImageInteraction(live: AdvancedQuestion): string {
  const img = image(live), caption = captionInput(live);
  return JSON.stringify({ image: rectKey(img), natural: [img.naturalWidth, img.naturalHeight],
    pins: Array.from(pins(live), ([id, pin]) => [id, ...pinPoint(pin, img)]),
    caption: caption ? [caption.marker, caption.input.value] : null });
}
export function verifyImageInteraction(live: AdvancedQuestion, answer: Answer): boolean {
  if (validateAnswer(live.question, answer) || geometryError(image(live), live.question.wooclapType!)) return false;
  if (live.question.wooclapType === 'LabelAnImage') {
    const saved = verifiedCaptions.get(live.scope), current = captionInput(live);
    return !!saved && saved.identity === fingerprint(live.question) && saved.values === JSON.stringify(answer.values)
      && !!current && current.marker === saved.marker && current.input === saved.input && !disabled(current.input)
      && snapshotImageInteraction(live) === saved.snapshot;
  }
  const current = pins(live), img = image(live), rect = img.getBoundingClientRect();
  return current.size === answer.points?.length && answer.points.every(point => {
    const pin = current.get(point.id); if (!pin) return false;
    const [x, y] = pinPoint(pin, img);
    return Math.abs(x - point.x) * rect.width <= 1.5 && Math.abs(y - point.y) * rect.height <= 1.5;
  });
}

export async function applyImageInteraction(question: Question, answer: Answer, readCurrent: () => Extraction, assertActive?: () => void): Promise<void> {
  const error = validateAnswer(question, answer); if (error) throw new Error(error);
  if (question.application !== 'automatic' || !IMAGE_TYPES.includes(question.wooclapType ?? '')) throw new Error('This image question does not support automatic application.');
  const identity = fingerprint(question);
  let initialGeometry: string | undefined;
  const current = (): AdvancedQuestion => {
    assertActive?.(); const live = readCurrent();
    if (!('controls' in live) || fingerprint(live.question) !== identity) throw new Error('The image question changed while applying the answer.');
    const error = geometryError(image(live), question.wooclapType!); if (error) throw new Error(error);
    const geometry = JSON.stringify(rectKey(image(live)));
    if (initialGeometry && question.wooclapType !== 'LabelAnImage' && geometry !== initialGeometry) throw new Error('The image geometry changed during placement.');
    initialGeometry ??= geometry; return live;
  };
  const waitFor = async (predicate: (live: AdvancedQuestion) => boolean, detail: string) => {
    const deadline = Date.now() + 1400;
    while (!predicate(current())) { if (Date.now() >= deadline) throw new Error(detail); await pause(); }
  };
  current();
  if (question.wooclapType === 'LabelAnImage') {
    verifiedCaptions.delete(current().scope);
    const open = async (id: string) => {
      const pin = current().controls.get(id); if (!pin || disabled(pin)) throw new Error('The caption marker is unavailable.');
      pin.click();
      await waitFor(live => captionInput(live)?.marker === id, 'Wooclap did not open the requested caption.');
      const input = captionInput(current())!.input;
      if (disabled(input)) throw new Error('The caption field is unavailable.');
      return input;
    };
    for (const entry of answer.values ?? []) {
      const input = await open(entry.id), win = input.ownerDocument.defaultView!;
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw new Error('The caption cannot be updated.');
      setter.call(input, entry.value); input.dispatchEvent(new win.Event('input', { bubbles: true })); input.dispatchEvent(new win.Event('change', { bubbles: true }));
      await pause(80);
      await waitFor(live => captionInput(live)?.marker === entry.id && captionInput(live)?.input.value === entry.value, 'Wooclap did not retain the caption.');
    }
    // Reopening every marker proves the page's controlled state retained each
    // caption; a value left on a detached/replaced input is not sufficient.
    for (const entry of answer.values ?? []) {
      await open(entry.id);
      await waitFor(live => captionInput(live)?.input.value === entry.value, 'A previously entered caption was not retained.');
    }
    const live = current(), input = captionInput(live)!;
    verifiedCaptions.set(live.scope, { identity, values: JSON.stringify(answer.values), input: input.input, marker: input.marker, snapshot: snapshotImageInteraction(live) });
  } else {
    for (const point of answer.points ?? []) {
      // The inspected renderer suppresses zero coordinates. Avoid rounding a
      // requested edge into an absent pin: require an interior point explicitly.
      if (point.x <= 0 || point.y <= 0 || point.x >= 1 || point.y >= 1) throw new Error('Place image answers inside the image, away from the exact boundary.');
      if (question.wooclapType === 'DragAndDrop') {
        const item = current().controls.get(point.id); if (!item || disabled(item)) throw new Error('The requested image label is unavailable.');
        item.click(); await pause(80); current();
      }
      const live = current(), img = image(live), r = img.getBoundingClientRect(), surface = live.controls.get('@surface')!;
      const win = img.ownerDocument.defaultView!, init = { clientX: r.left + point.x * r.width, clientY: r.top + point.y * r.height, bubbles: true, cancelable: true, button: 0 };
      if (question.wooclapType === 'ShowOnImage') surface.dispatchEvent(new win.MouseEvent('click', init));
      else {
        surface.dispatchEvent(new win.MouseEvent('mousedown', { ...init, buttons: 1 }));
        // React state from mouse-down must commit before the window mouse-up
        // handler can observe its recorded base position and creation mode.
        await pause(80); current();
        win.dispatchEvent(new win.MouseEvent('mouseup', { ...init, buttons: 0 }));
      }
      await waitFor(next => {
        const pin = pins(next).get(point.id); if (!pin) return false;
        const [x, y] = pinPoint(pin, image(next)), b = image(next).getBoundingClientRect();
        return Math.abs(x - point.x) * b.width <= 1.5 && Math.abs(y - point.y) * b.height <= 1.5;
      }, 'Wooclap did not retain the requested image position.');
    }
  }
  await waitFor(live => verifyImageInteraction(live, answer) && query(live.scope, '[data-test-id="Participant.Submit"]').some(button => !disabled(button)), 'The completed image answer is not ready to submit.');
}
