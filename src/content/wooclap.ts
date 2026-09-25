import type { CaptureRect, Observation, Question } from '../shared/types.js';
import { extractStructured } from './structured.js';
import { ADVANCED_TYPES, extractAdvanced } from './advanced.js';
import { extractRemaining } from './remaining.js';

export interface LiveQuestion {
  question: Question;
  scope: Element;
  controls: Map<string, HTMLElement>;
  rect: CaptureRect;
}

function extractSorting(scope: Element, title: Element, eventKey: string, doc: Document): LiveQuestion | Observation {
  const unsupported = (detail: string): Observation => ({ question: null, state: 'unsupported', detail });
  const lists = query(scope, '[data-rbd-droppable-id="sorting"]');
  if (lists.length !== 1) return unsupported('The sorting list is missing or ambiguous.');
  const rows = query(lists[0], '[data-rbd-draggable-id]') as HTMLElement[];
  if (rows.length < 2 || rows.length > 30) return unsupported('Sorting needs between two and thirty items.');
  if (query(scope, '[data-test-id="Participant.Submit"]').length !== 1) return { question: null, state: 'waiting', detail: 'Sorting is closed.' };
  if (query(scope, 'img, audio, video, canvas', true).length
    || query(scope, 'svg', true).some(svg => !svg.matches('[data-icon], .icon, [data-decorative]') && !svg.closest('button'))) {
    return unsupported('Sorting with media requires manual review.');
  }
  const controls = new Map<string, HTMLElement>();
  const choices = rows.map(row => {
    const id = row.getAttribute('data-rbd-draggable-id')!;
    const textElement = Array.from(row.querySelectorAll('[id]')).find(el => el.id === `choice-text-${id}`);
    controls.set(id, row);
    return { id, text: textElement ? label(textElement) : '' };
  });
  if (controls.size !== rows.length || choices.some(c => !c.id || c.id.length > 256 || !c.text)
    || !label(title)) return unsupported('Sorting item labels or identifiers are missing or duplicated.');
  if (rows.some(row => !query(row, 'button[aria-controls]').length)) return unsupported('Sorting movement controls are unavailable.');
  return { question: { kind: 'sorting', source: 'wooclap', eventKey, questionId: null,
    text: label(title), choices, multiple: false, imageKeys: [] }, scope, controls, rect: bounds([title, lists[0]], doc) };
}

const titleSelector = '[data-test-id="Question.participant.title"]';
const feedbackSelector = '[data-test-id="participant-feedback-banner"]';
const participantSelector = `.MCQ, .Poll, .Sorting, .GuessNumber, .OpenQuestion, .WordCloud, .FillInTheBlanks, .Matching, ${ADVANCED_TYPES}`;
const presentationSelector = '.Video, .Slide, .Timer, .SpinTheWheel, .Instructions';
const choiceSelector = 'button[data-idx][role="radio"], button[data-idx][role="checkbox"]';
const reservedRoutes = new Set(['public', 'auth', 'login', 'signin', 'signup', 'register', 'events', 'event',
  'participant', 'features', 'pricing', 'about', 'blog', 'logout', 'blocked-locked-plan', 'trial']);
const compact = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

/** Participant routes found in Wooclap's public router; aliases are not limited to six characters. */
export function eventKeyForUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !(url.hostname === 'wooclap.com' || url.hostname.endsWith('.wooclap.com'))) return null;
    const match = url.pathname.match(/^\/([a-z\d_-]+)(?:\/(?:questionnaires|presentations)\/[a-z\d_-]+|\/(?:wall|report)(?:\/votes)?)?\/?$/i);
    if (!match || reservedRoutes.has(match[1].toLowerCase())) return null;
    return `${url.origin}/event/${match[1].toUpperCase()}`;
  } catch { return null; }
}

function visible(element: Element, visual = false): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || (!visual && node.getAttribute('aria-hidden') === 'true')) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(node);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.opacity === '0') return false;
  }
  return true;
}

function query(scope: ParentNode, selector: string, visual = false): Element[] {
  return Array.from(scope.querySelectorAll(selector)).filter(element => visible(element, visual));
}

function label(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const ignored of clone.querySelectorAll('script, style, [hidden], [aria-hidden="true"], button, [role="img"]')) ignored.remove();
  return compact(clone.textContent);
}

function images(scope: Element): HTMLImageElement[] {
  // Wooclap sets aria-hidden on meaningful option images. ARIA visibility is not pixel visibility.
  return query(scope, 'img', true).filter(img => !img.matches('[data-decorative], .icon, [data-icon], [role="presentation"]')) as HTMLImageElement[];
}

function imageKey(value: string): string {
  if (value.length <= 1_900) return value;
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let i = 0; i < value.length; i += 1) {
    first = Math.imul(first ^ value.charCodeAt(i), 0x01000193);
    second = Math.imul(second ^ value.charCodeAt(i), 0x85ebca6b);
  }
  return `asset:${value.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
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

function participantScope(doc: Document): Element | null {
  const titles = query(doc, titleSelector);
  if (titles.length !== 1) return null;
  return titles[0].closest(participantSelector);
}

export function hasWooclapConfirmation(doc: Document): boolean {
  if (!eventKeyForUrl(doc.URL)) return false;
  const scope = participantScope(doc);
  if (!scope) return false;
  const banners = query(scope, feedbackSelector);
  if (banners.length !== 1 || !banners[0].closest('[role="alert"]')) return false;
  const banner = banners[0];
  if (banner.querySelector('.fa-hourglass-start, .fa-hourglass-end')) return false;
  // The public component uses these icons only when hasVote is true, independent of UI language.
  return Boolean(banner.querySelector('.fa-paper-plane, .fa-stars, .fa-circle-xmark'));
}

export function extractWooclap(doc: Document): LiveQuestion | Observation {
  const eventKey = eventKeyForUrl(doc.URL);
  if (!eventKey) return { question: null, state: 'unsupported', detail: 'Open a Wooclap participant event, not the organizer or login page.' };
  if (query(doc, presentationSelector).length && !query(doc, participantSelector).length) {
    return { question: null, state: 'waiting', detail: 'A presentation activity is visible. Waiting for the next answerable question.' };
  }
  const titles = query(doc, titleSelector);
  if (!titles.length) return { question: null, state: 'waiting', detail: 'Waiting for a supported Wooclap participant question.' };
  if (titles.length !== 1) return { question: null, state: 'unsupported', detail: 'Multiple participant question titles are visible.' };
  const title = titles[0];
  const scope = title.closest(participantSelector);
  if (!scope) return { question: null, state: 'unsupported', detail: 'This participant question layout is not recognized.' };
  if (hasWooclapConfirmation(doc)) return { question: null, state: 'submitted', detail: 'Wooclap confirms that your answer was submitted.' };
  if (query(scope, feedbackSelector).length) return { question: null, state: 'waiting', detail: 'The question is closed or displaying feedback. Waiting for the next question.' };
  if (scope.matches('.Sorting') && query(scope, 'textarea, input:not([type="hidden"]):not([type="button"]):not([type="submit"])').length) {
    return { question: null, state: 'unsupported', detail: 'This sorting question has additional input fields. Review it manually.' };
  }
  if (scope.matches('.Sorting')) return extractSorting(scope, title, eventKey, doc);
  const structured = extractStructured(scope, title, eventKey, doc);
  if (structured) {
    if ('state' in structured) return structured;
    if (query(scope, 'audio,video,canvas', true).length) return { question: null, state: 'unsupported', detail: 'Audio, video, and canvas content requires manual review.' };
    const meaningfulImages = images(scope);
    if (meaningfulImages.some(img => !img.complete || !img.naturalWidth)) return { question: null, state: 'waiting', detail: 'Waiting for question images to load.' };
    const diagrams = query(scope, 'svg', true).filter(svg => !svg.matches('[data-icon],.icon,[data-decorative],[role="presentation"]') && !svg.closest('button'));
    if (meaningfulImages.length + diagrams.length > 16) return { question: null, state: 'unsupported', detail: 'This question contains too many images.' };
    structured.question.imageKeys = [
      ...meaningfulImages.map(img => imageKey(`${img.currentSrc || img.src}|${compact(img.alt)}`)),
      ...diagrams.map(svg => imageKey(svg.outerHTML))
    ];
    if (structured.question.imageKeys.length) structured.rect = bounds([scope, title, ...meaningfulImages, ...diagrams], doc);
    return structured;
  }
  const remaining = extractRemaining(scope, title, eventKey, doc);
  if (remaining) return remaining;
  const advanced = extractAdvanced(scope, title, eventKey, doc);
  if (advanced) return advanced;
  const groups = query(scope, 'ul[aria-labelledby="question-title"][role="radiogroup"], ul[aria-labelledby="question-title"][role="group"]');
  if (groups.length !== 1) return { question: null, state: 'unsupported', detail: 'The Wooclap answer group is missing or ambiguous.' };
  const group = groups[0];
  const controls = query(group, choiceSelector) as HTMLElement[];
  if (!controls.length && query(group, 'div[data-idx][aria-disabled="true"]').length) {
    return { question: null, state: 'waiting', detail: 'Voting is closed. Waiting for the next question.' };
  }
  if (controls.length < 2 || controls.length > 30) return { question: null, state: 'unsupported', detail: 'The question needs between two and thirty recognizable choices.' };
  const multiple = group.getAttribute('role') === 'group';
  if (controls.some(control => control.getAttribute('role') !== (multiple ? 'checkbox' : 'radio')
    || !['true', 'false'].includes(control.getAttribute('aria-checked') ?? ''))) {
    return { question: null, state: 'unsupported', detail: 'Wooclap choice selection states are missing or inconsistent.' };
  }
  if (controls.some(control => control.getAttribute('aria-disabled') === 'true' || control.matches(':disabled'))) {
    return { question: null, state: 'waiting', detail: 'The answer controls are disabled. Waiting for the next question.' };
  }
  const submit = query(scope, '[data-test-id="Participant.Submit"]');
  if (submit.length !== 1) return { question: null, state: 'waiting', detail: 'Wooclap is not accepting a submission for this question.' };
  if (query(scope, 'textarea').length) return { question: null, state: 'unsupported', detail: 'This question asks for an answer comment. Review it manually.' };
  if (query(scope, 'audio, video, canvas').length) return { question: null, state: 'unsupported', detail: 'Audio, video, and canvas questions require manual review.' };
  const text = label(title);
  const meaningfulImages = images(scope);
  if (meaningfulImages.some(img => !img.complete || img.naturalWidth === 0)) return { question: null, state: 'waiting', detail: 'Waiting for the Wooclap question images to load.' };
  if (meaningfulImages.length > 16) return { question: null, state: 'unsupported', detail: 'This question contains too many images to capture safely.' };
  const controlMap = new Map<string, HTMLElement>();
  const choices = controls.map(control => {
    const idx = control.getAttribute('data-idx') ?? '';
    const id = `choice-${idx}`;
    controlMap.set(id, control);
    // An image-only option still needs a label connecting its ID to its visible ordinal in the screenshot.
    return { id, text: label(control) || (images(control).length ? `Image option ${idx}` : '') };
  });
  if (!text || choices.some(choice => !choice.text || !/^choice-[1-9]\d*$/.test(choice.id)) || controlMap.size !== choices.length) {
    return { question: null, state: 'unsupported', detail: 'Question text or choice labels/indices are missing or ambiguous.' };
  }
  const question: Question = { source: 'wooclap', eventKey, questionId: null, text, choices, multiple,
    imageKeys: meaningfulImages.map(img => imageKey(`${img.currentSrc || img.src}|${compact(img.alt)}`)) };
  return { question, scope, controls: controlMap, rect: bounds([title, group, ...controls, ...meaningfulImages], doc) };
}
