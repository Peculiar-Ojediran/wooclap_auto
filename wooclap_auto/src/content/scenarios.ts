import type { Answer, Choice, Observation, Question } from '../shared/types';
import { fingerprint, validateAnswer } from '../shared/core';
import type { AdvancedQuestion } from './advanced';

// AbstractSCT + RatingScale public components, participant build 14.111.2.
// Scale descriptions are rendered only for the current, unsubmitted selection.
type Structure = { scope: Element; title: Element; slider: HTMLElement; handle: HTMLElement;
  label: HTMLElement; context: Element; values: number[]; comment?: HTMLTextAreaElement };
type Cache = { identity: string; choices: Choice[]; at: number };
const cache = new WeakMap<HTMLElement, Cache>();
const inFlight = new WeakMap<Document, Promise<void>>();
const compact = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
const visible = (el: Element) => {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = el.ownerDocument.defaultView?.getComputedStyle(node);
    if (node.hasAttribute('hidden') || style?.display === 'none' || style?.visibility === 'hidden' || style?.opacity === '0') return false;
  }
  return true;
};
const query = (scope: ParentNode, selector: string) => Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter(visible);
function text(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('script,style,input,textarea,button,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
  return compact(clone.textContent);
}
function structure(scope: Element, title: Element): Structure | null {
  if (!scope.matches('.Concordance,.SCTJudgment')) return null;
  const sliders = query(scope, '[role="slider"]');
  const submits = query(scope, '[data-test-id="Participant.Submit"]');
  if (sliders.length !== 1 || submits.length !== 1) return null;
  const slider = sliders[0];
  if (slider.matches('[aria-disabled="true"],[inert]') || slider.closest('[inert]')) return null;
  const positions = query(slider, 'ul > li');
  const values = scope.matches('.SCTJudgment') ? [-2, -1, 1, 2] : [-2, -1, 0, 1, 2];
  const contextRows = slider.parentElement?.matches('ul') ? query(slider.parentElement, ':scope > li') : [];
  const handles = query(slider, 'span[draggable="false"]');
  const label = slider.previousElementSibling;
  const comments = query(scope, 'textarea') as HTMLTextAreaElement[];
  if (slider.getAttribute('aria-valuemin') !== '-2' || slider.getAttribute('aria-valuemax') !== '2'
    || positions.length !== values.length || contextRows.length !== 1 || handles.length !== 1 || !label?.matches('p')
    || comments.length > 1 || comments.some(c => c.required || c.getAttribute('aria-required') === 'true')
    || query(scope, 'input:not([type="hidden"]),select,[contenteditable="true"]').length) return null;
  if (scope.matches('.Concordance') && positions.some((position, index) => text(position) !== String(values[index]))) return null;
  if (!text(title) || !text(contextRows[0])) return null;
  return { scope, title, slider, handle: handles[0], label: label as HTMLElement,
    context: contextRows[0], values, comment: comments[0] };
}
function identity(s: Structure): string {
  return JSON.stringify([s.scope.ownerDocument.URL, s.scope.matches('.Concordance') ? 'Concordance' : 'SCTJudgment',
    text(s.title), text(s.context), s.values, query(s.scope, 'img').map(img => [(img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src, img.getAttribute('alt')]),
    s.comment ? [s.comment.getAttribute('aria-label'), s.comment.required, s.comment.maxLength] : null]);
}
function selected(s: Structure): number | null {
  if (!compact(s.label.textContent)) return null;
  const value = s.handle.getAttribute('data-score');
  if (s.scope.matches('.Concordance')) return value !== null && s.values.includes(Number(value)) ? Number(value) : null;
  const percent = /^(-?\d+(?:\.\d+)?)%$/.exec(s.handle.style.left);
  if (!percent) return null;
  const index = s.values.findIndex((_, i) => Math.abs(i / (s.values.length - 1) * 100 - Number(percent[1])) < 0.5);
  const score = s.values[index];
  return score !== undefined && Number(s.slider.getAttribute('aria-valuenow')) === score ? score : null;
}
function liveStructure(initial: Structure, expected: string, assertActive: () => void): Structure {
  assertActive();
  const next = structure(initial.scope, initial.title);
  if (!initial.scope.isConnected || !next || next.slider !== initial.slider || identity(next) !== expected
    || query(initial.scope, '[data-test-id="participant-feedback-banner"]').length) throw new Error('The scenario changed or closed while reading its scale.');
  return next;
}
async function move(s: Structure, target: number, guard: () => Structure): Promise<Structure> {
  const win = s.scope.ownerDocument.defaultView!;
  // Home and ArrowRight use the component's own ordered values, including the
  // missing zero in SCT Judgment. Do not infer the current score from ARIA alone:
  // this build reports -2 when Concordance's actual score is zero.
  const step = async (key: string, value: number) => {
    guard().slider.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
      const next = guard();
      if (selected(next) === value && compact(next.label.textContent)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('The scenario scale did not retain its selected position.');
  };
  guard().slider.focus();
  if (selected(guard()) === s.values[0]) await step('End', s.values[s.values.length - 1]);
  await step('Home', s.values[0]);
  for (let index = 1; index <= s.values.indexOf(target); index++) await step('ArrowRight', s.values[index]);
  return guard();
}

export function prepareScenarios(doc: Document, assertActive: () => void = () => {}): Promise<void> {
  const previous = inFlight.get(doc);
  if (previous) return previous;
  const work = (async () => {
    const titles = query(doc, '[data-test-id="Question.participant.title"]');
    if (titles.length !== 1) return;
    const scope = titles[0].closest('.Concordance,.SCTJudgment');
    if (!scope || query(scope, '[data-test-id="participant-feedback-banner"]').length) return;
    const initial = structure(scope, titles[0]);
    if (!initial) return; // Unknown layouts keep the existing read-only preview.
    const key = identity(initial), remembered = cache.get(initial.slider);
    const original = selected(initial);
    const currentLabel = compact(initial.label.textContent);
    if (remembered?.identity === key && Date.now() - remembered.at < 30_000
      && (original === null || remembered.choices.find(c => c.id === `scale-${original}`)?.text === currentLabel)) return;
    cache.delete(initial.slider);
    const originalComment = initial.comment?.value;
    const guard = () => {
      const next = liveStructure(initial, key, assertActive);
      if (next.comment?.value !== originalComment) throw new Error('The scenario comment changed. Scale preparation stopped.');
      return next;
    };
    const choices: Choice[] = [];
    try {
      for (const value of initial.values) {
        const next = await move(initial, value, guard);
        choices.push({ id: `scale-${value}`, text: compact(next.label.textContent) });
      }
      // There is no public "unselect" control. Preserve an existing choice;
      // otherwise leave the first position as a local, unsubmitted draft.
      await move(initial, original ?? initial.values[0], guard);
      if (choices.some(choice => !choice.text || choice.text.length > 8000)) throw new Error('The scenario scale descriptions are incomplete.');
      cache.set(initial.slider, { identity: key, choices, at: Date.now() });
    } catch (error) {
      cache.delete(initial.slider);
      throw error; // Never interact again after cancellation or human input.
    }
  })();
  inFlight.set(doc, work);
  void work.finally(() => inFlight.delete(doc)).catch(() => {});
  return work;
}

export function extractScenarios(scope: Element, title: Element, eventKey: string, doc: Document): AdvancedQuestion | Observation | null {
  const s = structure(scope, title);
  if (!s) return null;
  const remembered = cache.get(s.slider);
  if (!remembered || remembered.identity !== identity(s)) return null;
  const unsupported = (detail: string): Observation => ({ question: null, state: 'unsupported', detail });
  if (query(scope, 'audio,video,canvas').length || query(scope, 'svg').some(el => !el.matches('[data-icon],.svg-inline--fa'))) return unsupported('The scenario contains unsupported media.');
  const images = query(scope, 'img').filter(el => !el.matches('[data-decorative],.icon,[role="presentation"]')) as HTMLImageElement[];
  if (images.length > 16) return unsupported('The scenario contains too many images.');
  if (images.some(img => !img.complete || !img.naturalWidth)) return { question: null, state: 'waiting', detail: 'Waiting for scenario images.' };
  const imageKeys = images.map(img => {
    const value = `${img.currentSrc || img.src}|${img.alt}`;
    if (value.length < 1900) return value;
    let hash = 0x811c9dc5;
    for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
    return `scenario-image:${value.length}:${hash >>> 0}`;
  });
  const box = scope.getBoundingClientRect();
  const controls = new Map<string, HTMLElement>([['scale', s.slider]]);
  if (s.comment) controls.set('comment', s.comment);
  return { question: { kind: 'scenario', wooclapType: scope.matches('.Concordance') ? 'Concordance' : 'SCTJudgment', source: 'wooclap', eventKey,
    questionId: null, text: `${text(title)}\n${text(s.context)}\nChoose using the supplied full scale descriptions. Any optional participant comment will be preserved.`,
    choices: remembered.choices.map(choice => ({ ...choice })), multiple: false, imageKeys, application: 'automatic', responseMode: 'single' },
    scope, controls, rect: { x: box.left, y: box.top, width: box.width, height: box.height,
      viewportWidth: doc.defaultView?.innerWidth ?? 0, viewportHeight: doc.defaultView?.innerHeight ?? 0 } };
}
function fromLive(live: AdvancedQuestion): Structure | null {
  const titles = query(live.scope, '[data-test-id="Question.participant.title"]');
  return titles.length === 1 ? structure(live.scope, titles[0]) : null;
}
export function snapshotScenarios(live: AdvancedQuestion): string {
  const s = fromLive(live);
  return JSON.stringify(s ? [selected(s), compact(s.label.textContent), s.comment?.value ?? null] : null);
}
export function verifyScenarios(live: AdvancedQuestion, answer: Answer): boolean {
  if (live.question.application !== 'automatic' || validateAnswer(live.question, answer)) return false;
  const s = fromLive(live), choice = live.question.choices.find(c => c.id === answer.selectedChoiceIds[0]);
  return Boolean(s && choice && `scale-${selected(s)}` === choice.id && compact(s.label.textContent) === choice.text);
}
export async function applyScenarios(question: Question, answer: Answer, readCurrent: () => AdvancedQuestion, assertActive: () => void = () => {}): Promise<void> {
  const error = validateAnswer(question, answer);
  if (error || question.application !== 'automatic') throw new Error(error || 'This scenario needs manual review.');
  const expected = fingerprint(question), initial = readCurrent(), s = fromLive(initial);
  if (!s) throw new Error('The scenario controls are unavailable.');
  const key = identity(s), comment = s.comment?.value;
  const guard = () => {
    const next = liveStructure(s, key, assertActive);
    const current = readCurrent();
    if (fingerprint(current.question) !== expected || next.comment?.value !== comment) throw new Error('The scenario or comment changed. Submission stopped.');
    return next;
  };
  const target = Number(answer.selectedChoiceIds[0].slice('scale-'.length));
  if (!s.values.includes(target)) throw new Error('The scenario answer has an unavailable scale position.');
  await move(s, target, guard);
  guard();
  if (!verifyScenarios(readCurrent(), answer)) throw new Error('The selected scenario description changed. Review it before submitting.');
}
