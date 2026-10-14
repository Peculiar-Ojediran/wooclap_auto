import type { Answer, CaptureRect, Observation, Question, SelectorConfig } from '../shared/types.js';
import { fingerprint, validateAnswer } from '../shared/core.js';
import { isPackagedPracticeUrl } from '../shared/urls.js';
import { eventKeyForUrl, extractWooclap, hasWooclapConfirmation } from './wooclap.js';
import { applyStructured, verifyStructured, structuredResponseSnapshot } from './structured.js';
import { applyAdvanced, verifyAdvanced, advancedResponseSnapshot } from './advanced.js';
import { isRemaining, snapshotRemaining, applyRemaining, verifyRemaining, submitRemaining, hasContributionsConfirmation } from './remaining.js';
export { eventKeyForUrl } from './wooclap.js';

type Extracted = { question: Question; scope: Element; controls: Map<string, HTMLElement>; rect: CaptureRect };
const lastSelection = new WeakMap<Document, { question: Question; answer: Answer }>();
const structuredKind = (question: Question) => ['numeric', 'text', 'fields', 'matching'].includes(question.kind ?? '');
const advancedKind = (question: Question) => ['rating', 'allocation', 'categorized', 'point', 'placements', 'scenario'].includes(question.kind ?? '');
const nativeChoices = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]';
const scopeSelector = '[data-wooclap-question], [data-question-id], form, fieldset, [role="radiogroup"], .MCQ, .Poll';
const compact = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

function imageIdentity(value: string): string {
  if (value.length <= 1_900) return value;
  // Data URLs and SVG diagrams can be large. Keep identity metadata below bridge limits.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < value.length; i += 1) {
    first = Math.imul(first ^ value.charCodeAt(i), 0x01000193);
    second = Math.imul(second ^ value.charCodeAt(i), 0x85ebca6b);
  }
  return `asset:${value.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

export function sourceForUrl(value: string): 'wooclap' | 'practice' | null {
  if (isPackagedPracticeUrl(value)) return 'practice';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && (url.hostname === 'wooclap.com' || url.hostname.endsWith('.wooclap.com'))) return 'wooclap';
    if (url.origin === 'http://127.0.0.1:4318' && url.pathname === '/practice') return 'practice';
  } catch { /* Invalid URLs are unsupported. */ }
  return null;
}

function eventKey(doc: Document, source: Question['source']): string | null {
  const url = new URL(doc.URL);
  if (source === 'practice') return isPackagedPracticeUrl(doc.URL) ? chrome.runtime.getURL('practice.html') : `${url.origin}/practice`;
  const participantKey = eventKeyForUrl(doc.URL);
  if (participantKey) return participantKey;
  const route = url.pathname.match(/^\/(?:events?|participant)\/([a-z\d_-]+)(?:\/|$)/i)
    ?? url.pathname.match(/^\/([a-z\d]{6})(?:\/|$)/i);
  return route ? `${url.origin}/event/${route[1].toUpperCase()}` : null;
}

function visible(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false;
    const style = view?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  }
  return true;
}

function query(scope: ParentNode, selector: string): Element[] {
  return Array.from(scope.querySelectorAll(selector)).filter(visible);
}

function textOf(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const ignored of clone.querySelectorAll('[hidden], [aria-hidden="true"], script, style')) ignored.remove();
  for (const img of clone.querySelectorAll('img[alt]')) img.replaceWith(img.getAttribute('alt') ?? '');
  return compact(clone.textContent);
}

function accessibleLabel(element: Element): string {
  const labelledBy = compact(element.getAttribute('aria-labelledby'));
  if (labelledBy) {
    const labels = labelledBy.split(' ').map(id => element.ownerDocument.getElementById(id));
    if (labels.every(Boolean)) return compact(labels.map(label => textOf(label!)).join(' '));
  }
  const ariaLabel = compact(element.getAttribute('aria-label'));
  if (ariaLabel) return ariaLabel;
  if (element.tagName === 'INPUT') {
    const labels = Array.from((element as HTMLInputElement).labels ?? []).filter(visible);
    if (labels.length) return compact(labels.map(textOf).join(' '));
    return compact(element.getAttribute('data-choice-text'));
  }
  return compact(element.getAttribute('data-choice-text')) || textOf(element);
}

function disabled(element: HTMLElement): boolean {
  return element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true'
    || Boolean(element.closest('[inert], [aria-disabled="true"]'));
}

function selected(element: HTMLElement): boolean {
  if (element.tagName === 'INPUT') return (element as HTMLInputElement).checked;
  return element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-pressed') === 'true'
    || element.getAttribute('data-selected') === 'true';
}

function controlsIn(scope: Element, config: SelectorConfig): HTMLElement[] {
  const selector = config.choices || `${nativeChoices}, [data-wooclap-choice]`;
  const matches = query(scope, selector).map(element => {
    if (element.matches(nativeChoices) || config.choices) return element;
    return element.querySelector(nativeChoices) ?? element;
  });
  return [...new Set(matches)] as HTMLElement[];
}

function questionText(scope: Element, questionElement?: Element): string {
  if (questionElement && questionElement !== scope) return textOf(questionElement);
  const explicit = query(scope, '[data-wooclap-question-text]');
  if (explicit.length === 1) return textOf(explicit[0]);
  if (explicit.length > 1) return '';
  if (scope.hasAttribute('aria-labelledby') || scope.hasAttribute('aria-label')) return accessibleLabel(scope);
  const headings = query(scope, 'legend, h1, h2, h3, [role="heading"]')
    .filter(element => !element.closest('label, [role="radio"], [role="checkbox"]'));
  return headings.length === 1 ? textOf(headings[0]) : '';
}

function bounds(elements: Element[], doc: Document): CaptureRect {
  const rectangles = elements.map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
  const left = rectangles.length ? Math.min(...rectangles.map(rect => rect.left)) : 0;
  const top = rectangles.length ? Math.min(...rectangles.map(rect => rect.top)) : 0;
  const right = rectangles.length ? Math.max(...rectangles.map(rect => rect.right)) : 0;
  const bottom = rectangles.length ? Math.max(...rectangles.map(rect => rect.bottom)) : 0;
  return { x: left, y: top, width: right - left, height: bottom - top,
    viewportWidth: doc.defaultView?.innerWidth ?? 0, viewportHeight: doc.defaultView?.innerHeight ?? 0 };
}

function extract(config: SelectorConfig, doc: Document): Extracted | Observation {
  const source = sourceForUrl(doc.URL);
  if (!source) return { question: null, state: 'unsupported', detail: 'Open an HTTPS Wooclap page or the local practice page.' };
  if (source === 'wooclap' && !doc.querySelector('[data-wooclap-question]')) {
    if (!eventKeyForUrl(doc.URL)) return { question: null, state: 'unsupported', detail: 'Open a Wooclap participant event, not the organizer or login page.' };
    if (!config.question && !config.choices) {
      if (config.choiceClickSubmits) return { question: null, state: 'unsupported', detail: 'Wooclap multiple-choice questions use a separate Submit button. Disable submit-on-choice.' };
      return extractWooclap(doc);
    }
    if (!doc.querySelector('[data-test-id="Question.participant.title"]')) return { question: null, state: 'waiting', detail: 'Waiting for the Wooclap participant question interface.' };
  }
  const key = eventKey(doc, source);
  if (!key) return { question: null, state: 'unsupported', detail: 'This Wooclap event URL is not recognized.' };
  if (hasSubmissionConfirmation(config, doc)) return { question: null, state: 'submitted', detail: 'The page confirms that an answer was submitted.' };
  if (query(doc, '[data-wooclap-waiting]').length) return { question: null, state: 'waiting', detail: 'Waiting for the next question.' };

  let scopes: Element[];
  let questionElement: Element | undefined;
  if (config.question) {
    const matches = query(doc, config.question);
    if (matches.length !== 1) return { question: null, state: 'unsupported', detail: 'The question selector must match exactly one visible element.' };
    questionElement = matches[0];
    const scope = questionElement.matches(scopeSelector) ? questionElement : questionElement.closest(scopeSelector);
    if (!scope) return { question: null, state: 'unsupported', detail: 'The configured question needs a form or question container.' };
    scopes = [scope];
  } else {
    scopes = query(doc, '[data-wooclap-question]');
    if (!scopes.length) {
      const candidates = query(doc, scopeSelector).filter(scope => controlsIn(scope, config).length >= 2);
      // A form and its nested fieldset often describe the same question. Keep the smallest equivalent scope.
      scopes = candidates.filter(scope => !candidates.some(other => other !== scope && scope.contains(other)
        && controlsIn(scope, config).length === controlsIn(other, config).length));
    }
  }
  if (!scopes.length) return { question: null, state: 'waiting', detail: 'No supported question is visible yet.' };
  if (scopes.length !== 1) return { question: null, state: 'unsupported', detail: 'More than one question or answer group is visible.' };
  const scope = scopes[0];
  const text = questionText(scope, questionElement);
  if (!text) return { question: null, state: 'unsupported', detail: 'Question text is missing or ambiguous.' };
  const controls = controlsIn(scope, config);
  if (controls.length < 2) return { question: null, state: 'unsupported', detail: 'At least two labeled answer controls are required.' };
  if (controls.every(disabled)) return { question: null, state: 'waiting', detail: 'The question is closed or its answer controls are disabled.' };
  if (controls.some(disabled)) return { question: null, state: 'unsupported', detail: 'Some answer controls are unavailable.' };
  const modes = new Set(controls.map(control => control.getAttribute('role')
    || (control.tagName === 'INPUT' ? control.getAttribute('type') : 'custom')));
  let multiple: boolean;
  if (modes.size === 1 && modes.has('radio')) multiple = false;
  else if (modes.size === 1 && modes.has('checkbox')) multiple = true;
  else if (modes.size === 1 && modes.has('custom') && config.choices) multiple = config.multiple;
  else if (modes.size === 1 && modes.has('custom') && ['true', 'false'].includes(scope.getAttribute('data-wooclap-multiple') ?? '')) {
    multiple = scope.getAttribute('data-wooclap-multiple') === 'true';
  } else return { question: null, state: 'unsupported', detail: 'The answer selection mode is missing or ambiguous.' };
  if (multiple && config.choiceClickSubmits) return { question: null, state: 'unsupported', detail: 'Submit-on-choice is only supported for single-answer questions.' };
  const radioNames = new Set(controls.filter(control => control.matches('input[type="radio"]')).map(control => control.getAttribute('name') ?? ''));
  if (radioNames.size > 1 || radioNames.has('')) return { question: null, state: 'unsupported', detail: 'Radio controls need one unambiguous named group.' };
  const choiceMap = new Map<string, HTMLElement>();
  const choices = controls.map((control, index) => {
    const id = compact(control.getAttribute('data-choice-id')) || control.id || `choice-${index + 1}`;
    const label = accessibleLabel(control);
    choiceMap.set(id, control);
    return { id, text: label };
  });
  if (choiceMap.size !== choices.length || choices.some(choice => !choice.text)) {
    return { question: null, state: 'unsupported', detail: 'Answer labels or answer identifiers are missing or duplicated.' };
  }
  const images = query(scope, 'img').filter(element => element.getAttribute('role') !== 'presentation'
    && element.getAttribute('alt') !== '' && !element.matches('[data-decorative], .icon, [class*="avatar"]')) as HTMLImageElement[];
  if (images.some(img => !img.complete || img.naturalWidth === 0)) return { question: null, state: 'waiting', detail: 'Waiting for question images to load.' };
  const visuals = query(scope, 'canvas, video, svg').filter(element => element.getAttribute('role') !== 'presentation'
    && element.getAttribute('aria-hidden') !== 'true' && !element.matches('.icon, [data-decorative]'));
  if (visuals.some(element => element.matches('canvas, video'))) return { question: null, state: 'unsupported', detail: 'Canvas and video questions require manual review.' };
  const imageKeys = images.map(img => imageIdentity(`${img.currentSrc || img.src}|${compact(img.alt)}`));
  // Inline SVG diagrams are supported through screenshot capture too.
  imageKeys.push(...visuals.map(element => imageIdentity(`${element.tagName.toLowerCase()}:${element.outerHTML}`)));
  const question: Question = { source, eventKey: key,
    questionId: compact(scope.getAttribute('data-question-id')) || compact(scope.closest('[data-question-id]')?.getAttribute('data-question-id')) || null,
    text, choices, multiple, imageKeys };
  const labels = controls.flatMap(control => control.tagName === 'INPUT' ? Array.from((control as HTMLInputElement).labels ?? []) : []);
  return { question, scope, controls: choiceMap, rect: bounds([scope, ...controls, ...labels, ...images], doc) };
}

export function observePage(config: SelectorConfig, doc: Document = document): Observation {
  try {
    const result = extract(config, doc);
    if ('state' in result) return result;
    return { question: result.question, state: 'question', detail: 'A supported question is ready.', rect: result.rect,
      ...(isRemaining(result.question) ? { inputSignature: snapshotRemaining(result) }
        : structuredKind(result.question) ? { inputSignature: structuredResponseSnapshot(result) }
        : advancedKind(result.question) ? { inputSignature: advancedResponseSnapshot(result) } : {}) };
  } catch (error) {
    return { question: null, state: 'unsupported', detail: `Could not read question: ${error instanceof Error ? error.message : 'invalid page or selectors'}` };
  }
}

function currentQuestion(expected: Question, config: SelectorConfig, doc: Document): Extracted {
  const result = extract(config, doc);
  if ('state' in result || fingerprint(result.question) !== fingerprint(expected)) throw new Error('The question changed or is no longer available. No answer was submitted.');
  return result;
}

async function waitForSelection(question: Question, id: string, desired: boolean, config: SelectorConfig, doc: Document, assertActive?: () => void): Promise<void> {
  const deadline = Date.now() + 800;
  do {
    assertActive?.();
    const latest = currentQuestion(question, config, doc);
    const control = latest.controls.get(id);
    if (!control || disabled(control)) throw new Error('The answer control became unavailable before selection was confirmed.');
    if (selected(control) === desired) return;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error('The page did not confirm the requested selection. Review the answer manually.');
}

async function arrangeSorting(question: Question, ids: string[], config: SelectorConfig, doc: Document, assertActive?: () => void): Promise<void> {
  for (let target = 0; target < ids.length; target++) {
    for (let moves = 0; moves < ids.length; moves++) {
      assertActive?.();
      const current = currentQuestion(question, config, doc);
      const order = [...current.controls.keys()];
      const index = order.indexOf(ids[target]);
      if (index === target) break;
      if (index < target) throw new Error('The sorting order changed unexpectedly.');
      const row = current.controls.get(ids[target])!;
      const up = query(row, 'button[aria-controls]').filter(button =>
        button.getAttribute('aria-controls') === `choice-text-${ids[target]}` && button.querySelector('.fa-arrow-up'));
      if (up.length !== 1 || disabled(up[0] as HTMLElement)) throw new Error('A unique sorting move-up control is unavailable.');
      const expectedOrder = [...order];
      [expectedOrder[index - 1], expectedOrder[index]] = [expectedOrder[index], expectedOrder[index - 1]];
      (up[0] as HTMLElement).click();
      const deadline = Date.now() + 1800;
      let confirmed = false;
      do {
        await new Promise(resolve => setTimeout(resolve, 50));
        assertActive?.();
        const actual = [...currentQuestion(question, config, doc).controls.keys()];
        if (JSON.stringify(actual) === JSON.stringify(expectedOrder)) { confirmed = true; break; }
        if (JSON.stringify(actual) !== JSON.stringify(order)) throw new Error('The sorting order changed unexpectedly.');
      } while (Date.now() < deadline);
      if (!confirmed) throw new Error('The page did not confirm the sorting move. Review manually.');
    }
  }
  assertActive?.();
  if (JSON.stringify([...currentQuestion(question, config, doc).controls.keys()]) !== JSON.stringify(ids)) throw new Error('The final sorting order could not be verified.');
}

export async function selectAnswer(question: Question, answer: Answer, config: SelectorConfig, doc: Document = document, assertActive?: () => void): Promise<{ submittedBySelection: boolean }> {
  assertActive?.();
  lastSelection.delete(doc);
  if (answer.needsReview) throw new Error('This answer requires review and cannot be applied.');
  if (question.application === 'preview') throw new Error('This layout supports answer previews only. Apply the answer on the page.');
  if (structuredKind(question) || advancedKind(question)) {
    const issue = validateAnswer(question, answer);
    if (issue) throw new Error(issue);
    const read = () => currentQuestion(question, config, doc);
    if (isRemaining(question)) await applyRemaining(question, answer, read, assertActive);
    else if (structuredKind(question)) await applyStructured(question, answer, read, assertActive);
    else await applyAdvanced(question, answer, read, assertActive);
    lastSelection.set(doc, { question, answer: structuredClone(answer) });
    return { submittedBySelection: false };
  }
  if (question.kind === 'sorting') {
    const issue = validateAnswer(question, answer);
    if (issue) throw new Error(issue);
    await arrangeSorting(question, answer.selectedChoiceIds, config, doc, assertActive);
    lastSelection.set(doc, { question, answer: structuredClone(answer) });
    return { submittedBySelection: false };
  }
  const ids = answer.selectedChoiceIds;
  if (!ids.length || new Set(ids).size !== ids.length || (!question.multiple && ids.length !== 1)) throw new Error('The answer has an invalid number of choices.');
  const initial = currentQuestion(question, config, doc);
  if (ids.some(id => !initial.controls.has(id))) throw new Error('The answer contains an unknown choice identifier.');
  // Removing unwanted checkbox selections is necessary when a participant has already selected something.
  const changes = [...initial.controls].filter(([id, control]) => question.multiple
    ? selected(control) !== ids.includes(id) : ids.includes(id) && !selected(control));
  let clicked = false;
  for (const [id] of changes) {
    assertActive?.();
    const latest = currentQuestion(question, config, doc);
    const control = latest.controls.get(id);
    if (!control || disabled(control)) throw new Error('The requested answer control is unavailable.');
    if (selected(control) === ids.includes(id)) continue;
    control.click();
    clicked = true;
    await Promise.resolve();
    if (config.choiceClickSubmits) return { submittedBySelection: true };
    await waitForSelection(question, id, ids.includes(id), config, doc, assertActive);
  }
  const after = currentQuestion(question, config, doc);
  if ([...after.controls].some(([id, control]) => selected(control) !== ids.includes(id))) throw new Error('The page did not confirm the requested selections.');
  if (config.choiceClickSubmits && !clicked) throw new Error('The choice was already selected; submission cannot be confirmed safely.');
  lastSelection.set(doc, { question, answer: structuredClone(answer) });
  return { submittedBySelection: false };
}

export async function submitAnswer(config: SelectorConfig, doc: Document = document, assertActive: () => void = () => {}): Promise<void> {
  assertActive();
  const expected = lastSelection.get(doc);
  if (!expected) throw new Error('Select and verify an answer before submitting.');
  const current = currentQuestion(expected.question, config, doc);
  const valid = isRemaining(expected.question) ? verifyRemaining(current, expected.answer)
    : structuredKind(expected.question) ? verifyStructured(current, expected.answer)
    : advancedKind(expected.question) ? verifyAdvanced(current, expected.answer)
    : expected.question.kind === 'sorting' ? JSON.stringify([...current.controls.keys()]) === JSON.stringify(expected.answer.selectedChoiceIds)
    : [...current.controls].every(([id, control]) => selected(control) === expected.answer.selectedChoiceIds.includes(id));
  if (!valid) {
    lastSelection.delete(doc);
    throw new Error('The selected choices changed before submission. Review the answer before continuing.');
  }
  if (isRemaining(expected.question) && ['Brainstorm', 'Framework'].includes(expected.question.wooclapType ?? '')) {
    lastSelection.delete(doc);
    await submitRemaining(current, expected.answer, assertActive);
    return;
  }
  const matches = config.submit ? query(doc, config.submit)
    : query(current.scope, '[data-wooclap-submit], [data-test-id="Participant.Submit"], button[type="submit"], input[type="submit"], button')
      .filter(element => element.matches('[data-wooclap-submit], [data-test-id="Participant.Submit"], [type="submit"]') || /^(submit|send|vote|validate)(?:\s+answer)?$/i.test(accessibleLabel(element)));
  const buttons = [...new Set(matches)].filter(element => !disabled(element as HTMLElement));
  if (buttons.length !== 1) throw new Error('A unique enabled submit control was not found. Configure its selector or submit manually.');
  lastSelection.delete(doc);
  assertActive();
  (buttons[0] as HTMLElement).click();
  await Promise.resolve();
}

export function hasSubmissionConfirmation(config: SelectorConfig, doc: Document = document): boolean {
  if (sourceForUrl(doc.URL) === 'wooclap' && hasContributionsConfirmation(doc)) return true;
  if (sourceForUrl(doc.URL) === 'wooclap' && hasWooclapConfirmation(doc)) return true;
  const explicit = config.confirmation || '[data-wooclap-confirmation]';
  if (query(doc, explicit).length === 1) return true;
  return query(doc, '[role="status"]').some(element => /^(?:your\s+)?(?:answer|response|vote|submission)\s+(?:(?:has been|was|is)\s+)?(?:submitted|recorded|saved|received|accepted)(?:\s+successfully)?[.!]?$/i.test(textOf(element)));
}
