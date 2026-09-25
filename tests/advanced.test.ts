import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { observePage, selectAnswer, submitAnswer, hasSubmissionConfirmation } from '../src/content/adapter';
import { extractAdvanced, applyAdvanced, advancedResponseSnapshot, verifyAdvanced, type AdvancedQuestion } from '../src/content/advanced';
import { DEFAULT_SETTINGS, type Answer } from '../src/shared/types';
import { fingerprint } from '../src/shared/core';

const html = readFileSync(new URL('./fixtures/advanced-participant.html', import.meta.url), 'utf8');
const config = DEFAULT_SETTINGS.selectors;
interface Fixture { show(type: string): void; fields(): [string, string][]; submissionCount: number; delay: number; closeQuestion(): void }
function setup(t: TestContext, type = 'Rating') {
  const dom = new JSDOM(html, { url: 'https://app.wooclap.com/advanced', runScripts: 'dangerously', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'complete', { get: () => true, configurable: true });
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'naturalWidth', { get: () => 400, configurable: true });
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'naturalHeight', { get: () => 200, configurable: true });
  const fixture = (dom.window as unknown as { advancedFixture: Fixture }).advancedFixture;
  fixture.show(type);
  const doc = dom.window.document;
  const read = () => extractAdvanced(doc.querySelector('main')!, doc.querySelector('h1')!, 'https://app.wooclap.com/event/ADVANCED', doc)!;
  const live = (): AdvancedQuestion => {
    const value = read(); assert.ok('controls' in value, 'detail' in value ? value.detail : 'Missing controls'); return value;
  };
  const question = () => { const value = observePage(config, doc); assert.equal(value.state, 'question', value.detail); return value.question!; };
  return { doc, fixture, dom, read, live, question };
}
const answer = (values: [string, string][]): Answer => ({ selectedChoiceIds: [], values: values.map(([id, value]) => ({ id, value })), explanation: 'Fixture answer.', needsReview: false });

test('advanced rating reads propositions and exact visible scale without preselecting minimum', t => {
  const { live } = setup(t); const extracted = live();
  assert.equal(extracted.question.kind, 'rating');
  assert.equal(extracted.question.application, 'automatic');
  assert.deepEqual(extracted.question.fields?.map(f => [f.id, f.min, f.max, f.step]), [['quality', 1, 5, 1], ['speed', 1, 5, 1]]);
  assert.equal(verifyAdvanced(extracted, answer([['quality', '1'], ['speed', '1']])), false);
});
test('advanced rating drives controlled keyboard events, verifies and submits once', async t => {
  const { doc, fixture, question } = setup(t);
  await selectAnswer(question(), answer([['quality', '2.0'], ['speed', '4']]), config, doc);
  assert.equal(fixture.submissionCount, 0);
  assert.deepEqual(Array.from(fixture.fields(), pair => Array.from(pair)), [['quality', '2'], ['speed', '4']]);
  await submitAnswer(config, doc); assert.equal(fixture.submissionCount, 1);
  assert.equal(hasSubmissionConfirmation(config, doc), true);
  await assert.rejects(submitAnswer(config, doc), /Select and verify/);
});
test('advanced rating fingerprint excludes participant scores while snapshot records them', async t => {
  const { doc, question, live } = setup(t); const first = question(), before = advancedResponseSnapshot(live());
  await selectAnswer(first, answer([['quality', '2'], ['speed', '4']]), config, doc);
  assert.equal(fingerprint(question()), fingerprint(first));
  assert.notEqual(advancedResponseSnapshot(live()), before);
});
test('advanced rating rejects missing scale positions, duplicate labels, and comments', t => {
  const { doc, fixture } = setup(t);
  doc.querySelector('[role=slider] li')!.remove(); assert.equal(observePage(config, doc).state, 'unsupported');
  fixture.show('Rating'); doc.querySelectorAll('[role=slider]')[1].setAttribute('aria-labelledby', 'choice-text-quality');
  assert.equal(observePage(config, doc).state, 'unsupported');
  fixture.show('Rating'); doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<textarea required></textarea>');
  assert.equal(observePage(config, doc).state, 'unsupported');
});
test('advanced rating stops when paused while awaiting first score update', async t => {
  const { doc, question, fixture } = setup(t); fixture.delay = 150; let active = true;
  setTimeout(() => { active = false; }, 20);
  await assert.rejects(selectAnswer(question(), answer([['quality', '5'], ['speed', '5']]), config, doc,
    () => { if (!active) throw new Error('Paused'); }), /Paused/);
  assert.equal(fixture.submissionCount, 0);
  assert.equal(doc.querySelectorAll('[role=slider]')[1].querySelector('[data-score]'), null);
});
test('advanced rating stops if question closes during application', async t => {
  const { doc, question, fixture } = setup(t); fixture.delay = 100;
  setTimeout(() => fixture.closeQuestion(), 10);
  await assert.rejects(selectAnswer(question(), answer([['quality', '2'], ['speed', '4']]), config, doc), /changed|no longer/);
  assert.equal(fixture.submissionCount, 0);
});
test('advanced rating detects changed selections immediately before submit', async t => {
  const { doc, question, fixture } = setup(t);
  await selectAnswer(question(), answer([['quality', '2'], ['speed', '4']]), config, doc);
  doc.querySelector('[data-score]')!.setAttribute('data-score', '3');
  await assert.rejects(submitAnswer(config, doc), /changed/); assert.equal(fixture.submissionCount, 0);
});
test('advanced allocation reads static budget and excludes points-left counter', t => {
  const { doc, question } = setup(t, 'Prioritization'); const first = question();
  assert.equal(first.kind, 'allocation'); assert.equal(first.constraints?.total, 100);
  doc.querySelector('#remaining')!.textContent = '20 points left';
  doc.querySelector<HTMLInputElement>('#choice-safety')!.value = '80';
  assert.equal(fingerprint(question()), fingerprint(first));
});
test('advanced allocation uses controlled inputs and waits for submit enablement', async t => {
  const { doc, question, fixture } = setup(t, 'Prioritization'); fixture.delay = 150;
  await selectAnswer(question(), answer([['safety', '60'], ['speed', '40']]), config, doc);
  assert.equal((doc.querySelector('[data-test-id="Participant.Submit"]') as HTMLButtonElement).disabled, false);
  await submitAnswer(config, doc); assert.equal(fixture.submissionCount, 1);
});
test('advanced allocation recognizes empty-rendered zero after controlled input', async t => {
  const { doc, question } = setup(t, 'Prioritization');
  await selectAnswer(question(), answer([['safety', '100'], ['speed', '0']]), config, doc);
  assert.equal(doc.querySelector<HTMLInputElement>('#choice-speed')!.value, '');
  await submitAnswer(config, doc);
});
test('advanced allocation refuses incorrect totals before writing any fields', async t => {
  const { doc, question, fixture } = setup(t, 'Prioritization');
  await assert.rejects(selectAnswer(question(), answer([['safety', '60'], ['speed', '50']]), config, doc), /total/);
  assert.equal(doc.querySelector<HTMLInputElement>('#choice-safety')!.value, '');
  assert.equal(fixture.submissionCount, 0);
});
test('advanced allocation refuses ambiguous visible budget rather than guessing 100', t => {
  const { doc } = setup(t, 'Prioritization');
  doc.querySelector('#remaining')!.previousElementSibling!.textContent = 'Allocate between 50 and 100 points';
  assert.equal(observePage(config, doc).state, 'unsupported');
});
test('advanced allocation detects title changes during controlled updates', async t => {
  const { doc, question, fixture } = setup(t, 'Prioritization');
  setTimeout(() => { doc.querySelector('h1')!.textContent = 'A different budget problem'; }, 10);
  await assert.rejects(selectAnswer(question(), answer([['safety', '60'], ['speed', '40']]), config, doc), /changed/);
  assert.equal(fixture.submissionCount, 0);
});
test('advanced brainstorming drafts one contribution for the displayed category only', t => {
  const { doc, question } = setup(t, 'Brainstorm'); const first = question();
  assert.equal(first.kind, 'categorized'); assert.equal(first.responseMode, 'contribution'); assert.equal(first.application, 'preview');
  assert.deepEqual(first.choices, [{ id: 'category-current', text: 'Communication' }]);
  doc.querySelector('#board')!.textContent = 'Other participants added many new ideas';
  doc.querySelector('textarea')!.value = 'My unsent idea';
  doc.querySelector('#characters-left')!.textContent = '166 characters left';
  assert.equal(fingerprint(question()), fingerprint(first));
  doc.querySelector('[aria-haspopup]')!.textContent = 'Scheduling';
  assert.notEqual(fingerprint(question()), fingerprint(first));
});
test('advanced brainstorming reads the displayed limit including extra line-break units', t => {
  const { doc, question } = setup(t, 'Brainstorm');
  doc.querySelector('#characters-left')!.textContent = '60 characters left';
  const first = question(); assert.equal(first.constraints?.maxLength, 60);
  doc.querySelector('textarea')!.value = 'a\nb';
  doc.querySelector('#characters-left')!.textContent = '56 characters left';
  assert.equal(fingerprint(question()), fingerprint(first));
});
test('advanced framework captures image and category mapping independently from audience board', t => {
  const { doc, question } = setup(t, 'Framework'); const first = question();
  assert.equal(first.application, 'preview'); assert.equal(first.kind, 'categorized'); assert.equal(first.imageKeys.length, 1);
  assert.deepEqual(first.choices.map(c => c.id), ['category-0', 'category-1']);
  doc.querySelector('#board')!.innerHTML = '<p>Newest answer</p><button>Like</button>';
  assert.equal(fingerprint(question()), fingerprint(first));
});
test('advanced label image reads every numbered marker as required caption field', t => {
  const { question } = setup(t, 'LabelAnImage'); const q = question();
  assert.equal(q.kind, 'fields'); assert.equal(q.application, 'preview'); assert.equal(q.imageKeys.length, 1);
  assert.deepEqual(q.fields?.map(field => [field.id, field.required]), [['marker-1', true], ['marker-2', true]]);
});
test('advanced label image refuses missing or duplicated numbered markers', t => {
  const { doc, fixture } = setup(t, 'LabelAnImage');
  doc.querySelector('.pin')!.remove(); assert.equal(observePage(config, doc).state, 'unsupported');
  fixture.show('LabelAnImage'); doc.querySelector('.second')!.textContent = '1';
  assert.equal(observePage(config, doc).state, 'unsupported');
});
test('advanced find-on-image and drag-and-drop expose bounded previews without clicking', async t => {
  const { doc, question, fixture, read } = setup(t, 'ShowOnImage');
  const point = question(); assert.equal(point.kind, 'point'); assert.equal(point.application, 'preview');
  const proposal: Answer = { selectedChoiceIds: [], points: [{ id: 'point-1', x: .275, y: .4 }], explanation: 'Circle.', needsReview: false };
  await assert.rejects(selectAnswer(point, proposal, config, doc), /preview/);
  await assert.rejects(applyAdvanced(point, proposal, read), /preview/);
  fixture.show('DragAndDrop'); const placements = question();
  assert.equal(placements.kind, 'placements'); assert.deepEqual(placements.choices.map(c => c.text), ['Circle', 'Rectangle']);
  assert.equal(fixture.submissionCount, 0);
});
test('advanced visual adapters wait for images even when aria-hidden is true', t => {
  const { doc } = setup(t, 'ShowOnImage');
  Object.defineProperty(doc.querySelector('img'), 'complete', { value: false });
  assert.equal(observePage(config, doc).state, 'waiting');
});
test('advanced inline SVG and aria-hidden video cannot silently bypass media guards', t => {
  const { doc, fixture } = setup(t);
  doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<svg aria-hidden="true"><text>A meaningful chart</text></svg>');
  assert.equal(observePage(config, doc).state, 'unsupported');
  fixture.show('Rating'); doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<video aria-hidden="true"></video>');
  assert.equal(observePage(config, doc).state, 'unsupported');
});
test('advanced SVG pin decoration exception cannot hide a circle diagram', t => {
  const { doc, fixture } = setup(t, 'LabelAnImage');
  doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 160 160"><circle cx="80" cy="80" r="40" fill="red"/></svg>');
  assert.equal(observePage(config, doc).state, 'unsupported');
  fixture.show('LabelAnImage');
  const pin = doc.querySelector('.pin')!;
  const wrapper = doc.createElement('div'); pin.replaceWith(wrapper); wrapper.append(pin);
  wrapper.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 160 160"><circle cx="80" cy="80" r="80" stroke-dasharray="565" stroke-dashoffset="0"/></svg>');
  assert.equal(observePage(config, doc).state, 'question');
});
test('advanced verifier rejects duplicate IDs even when both values match one rendered control', async t => {
  const { doc, question, live } = setup(t);
  await selectAnswer(question(), answer([['quality', '2'], ['speed', '4']]), config, doc);
  assert.equal(verifyAdvanced(live(), answer([['quality', '2'], ['quality', '2']])), false);
});
test('advanced scenario retains full case and additional information, with unverified scale as preview', t => {
  const { doc, question, fixture } = setup(t, 'Concordance'); const first = question();
  assert.equal(first.kind, 'scenario'); assert.equal(first.application, 'preview');
  assert.match(first.text, /sealed box/); assert.match(first.text, /reliable scan/); assert.match(first.text, /do not assume/);
  assert.equal(first.choices.length, 5);
  doc.querySelector('#selected-scale')!.textContent = 'Changed by participant';
  doc.querySelector('textarea')!.value = 'Participant comment';
  assert.equal(fingerprint(question()), fingerprint(first));
  fixture.show('SCTJudgment'); assert.equal(question().choices.length, 4);
});
test('advanced changed scenario evidence invalidates old proposed answers', t => {
  const { doc, question } = setup(t, 'Concordance'); const first = question();
  const paragraphs = Array.from(doc.querySelectorAll('li > div > div > div'));
  paragraphs[1].textContent = 'The scan instead shows a red ball.';
  assert.notEqual(fingerprint(question()), fingerprint(first));
});
