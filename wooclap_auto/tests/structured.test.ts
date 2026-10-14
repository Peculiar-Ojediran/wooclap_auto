import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { observePage, selectAnswer, submitAnswer, hasSubmissionConfirmation } from '../src/content/adapter';
import { extractStructured, prepareStructured, structuredResponseSnapshot, verifyStructured } from '../src/content/structured';
import { fingerprint } from '../src/shared/core';
import { DEFAULT_SETTINGS, type Answer } from '../src/shared/types';

const html = readFileSync(new URL('./fixtures/structured-participant.html', import.meta.url), 'utf8');
const config = DEFAULT_SETTINGS.selectors;
type FixtureType = 'numeric' | 'text' | 'wordcloud' | 'blanks' | 'closed-blanks' | 'matching';
interface Fixture {
  show(type: FixtureType): void;
  submissionCount: number;
  submittedValues: Record<string, string>;
  values: Record<string, string>;
  updateCount: number;
  inputDelay: number;
  setDropdownOptions(values: string[]): void;
  clearFeedback(): void;
  close(): void;
}
function setup(t: TestContext, type: FixtureType = 'numeric') {
  const dom = new JSDOM(html, { url: 'https://app.wooclap.com/structured-test', runScripts: 'dangerously', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const fixture = (dom.window as unknown as { fixture: Fixture }).fixture;
  fixture.show(type);
  const question = () => {
    const result = observePage(config, doc);
    assert.equal(result.state, 'question', result.detail);
    assert.ok(result.question);
    return result.question;
  };
  const live = () => {
    const title = doc.querySelector('[data-test-id="Question.participant.title"]')!;
    const result = extractStructured(doc.querySelector('main')!, title, 'https://app.wooclap.com/event/STRUCTURED-TEST', doc);
    assert.ok(result && !('state' in result));
    return result;
  };
  return { doc, dom, fixture, question, live };
}
const scalar = (value: string): Answer => ({ selectedChoiceIds: [], value, explanation: 'Fixture answer.', needsReview: false });
const fields = (values: Record<string, string>): Answer => ({ selectedChoiceIds: [], values: Object.entries(values).map(([id, value]) => ({ id, value })), explanation: 'Fixture answer.', needsReview: false });

test('numeric extraction includes visible limits and controlled updates retain exact answer before submission', async t => {
  const { doc, fixture, question } = setup(t);
  const before = question();
  assert.equal(before.kind, 'numeric');
  assert.match(before.text, /between 0 and 100/);
  assert.deepEqual(before.constraints, {}); // Actual GuessNumber model limits are not input attributes.
  await selectAnswer(before, scalar('25'), config, doc);
  assert.equal(fixture.values.answer, '25');
  assert.equal(fixture.updateCount, 1);
  assert.equal(fixture.submissionCount, 0);
  assert.equal(fingerprint(question()), fingerprint(before));
  await submitAnswer(config, doc);
  assert.equal(fixture.submittedValues.answer, '25');
  assert.equal(hasSubmissionConfirmation(config, doc), true);
});

test('numeric verification compares decimal strings without lossy float equality', t => {
  const { doc, live } = setup(t);
  const input = doc.querySelector('input')!;
  input.value = '9007199254740992';
  assert.equal(verifyStructured(live(), scalar('9007199254740993')), false);
  input.value = '-0012,5000';
  assert.equal(verifyStructured(live(), scalar('-12.5')), true);
  input.value = '-0.000';
  assert.equal(verifyStructured(live(), scalar('0')), true);
});

test('numeric application refuses decimals the observed numeric handler would round', async t => {
  const { doc, fixture, question } = setup(t);
  await assert.rejects(selectAnswer(question(), scalar('9007199254740993'), config, doc), /round.*number|number.*round/);
  await assert.rejects(selectAnswer(question(), scalar('0.10000000000000001'), config, doc), /round.*number|number.*round/);
  assert.equal(fixture.updateCount, 0);
  await selectAnswer(question(), scalar('0.0000001'), config, doc);
  assert.equal(fixture.values.answer, '0.0000001');
});

test('numeric extraction ignores live validation errors and rejects unexpected inputs', t => {
  const { doc, question } = setup(t);
  const before = fingerprint(question());
  doc.querySelector('#answer-body')!.insertAdjacentHTML('beforeend', '<div role="alert"><p>Invalid number</p></div>');
  assert.equal(fingerprint(question()), before);
  doc.querySelector('#answer-body')!.insertAdjacentHTML('beforeend', '<input type="text" aria-label="Required comment">');
  assert.equal(observePage(config, doc).state, 'unsupported');
});

for (const type of ['text', 'wordcloud'] as const) test(`${type} applies one contribution and verifies the textarea state`, async t => {
  const { doc, fixture, question } = setup(t, type);
  const before = question();
  assert.equal(before.kind, 'text');
  assert.equal(before.responseMode, 'contribution');
  const value = type === 'text' ? 'Paris' : 'Solar energy';
  await selectAnswer(before, scalar(value), config, doc);
  assert.equal(fixture.values.answer, value);
  await submitAnswer(config, doc);
  assert.equal(fixture.submittedValues.answer, value);
  assert.equal(fixture.values.answer, '');
  assert.equal(hasSubmissionConfirmation(config, doc), true);
});

test('text rejects a second answer field and respects actual DOM maxlength', async t => {
  const { doc, fixture, question } = setup(t, 'text');
  const input = doc.querySelector('textarea')!;
  input.maxLength = 5;
  assert.equal(question().constraints?.maxLength, 5);
  await assert.rejects(selectAnswer(question(), scalar('Too many characters'), config, doc), /maximum|long|length/i);
  assert.equal(fixture.updateCount, 0);
  doc.querySelector('#answer-body')!.insertAdjacentHTML('beforeend', '<input type="text" aria-label="Additional answer">');
  assert.equal(observePage(config, doc).state, 'unsupported');
});

test('open blanks preserve full sentence and map every stable field identifier', async t => {
  const { doc, fixture, question, live } = setup(t, 'blanks');
  const before = question();
  assert.equal(before.kind, 'fields');
  assert.match(before.text, /Paris is the capital of \[blank-1\].*Two plus two is \[blank-2\]/);
  assert.deepEqual(before.fields?.map(field => field.id), ['blank-1', 'blank-2']);
  const originalSnapshot = structuredResponseSnapshot(live());
  await selectAnswer(before, fields({ 'blank-1': 'France', 'blank-2': '4' }), config, doc);
  assert.notEqual(structuredResponseSnapshot(live()), originalSnapshot);
  assert.equal(fingerprint(question()), fingerprint(before));
  await submitAnswer(config, doc);
  assert.deepEqual({ ...fixture.submittedValues }, { 'blank-1': 'France', 'blank-2': '4' });
});

test('closed blanks inspect rendered menu options without choosing and apply exact option with context intact', async t => {
  const { doc, fixture, question } = setup(t, 'closed-blanks');
  assert.equal(observePage(config, doc).state, 'unsupported');
  await prepareStructured(doc);
  assert.equal(fixture.updateCount, 0);
  assert.equal(doc.querySelector('[role="combobox"]')!.getAttribute('aria-expanded'), 'false');
  const before = question();
  assert.deepEqual(before.fields?.[0].options, [
    { id: 'option-1', text: 'France' }, { id: 'option-2', text: 'Germany' }, { id: 'option-3', text: 'Spain' }
  ]);
  await selectAnswer(before, fields({ 'blank-1': 'option-1', 'blank-2': '4' }), config, doc);
  assert.equal(fingerprint(question()), fingerprint(before));
  assert.equal(doc.querySelector('[role="listbox"]'), null);
  await submitAnswer(config, doc);
  assert.deepEqual({ ...fixture.submittedValues }, { 'blank-1': 'France', 'blank-2': '4' });
});

test('dropdown choice changes invalidate cached proposal before any selection', async t => {
  const { doc, fixture, question } = setup(t, 'closed-blanks');
  await prepareStructured(doc);
  const before = question();
  fixture.setDropdownOptions(['Spain', 'Italy']);
  await assert.rejects(selectAnswer(before, fields({ 'blank-1': 'option-1', 'blank-2': '4' }), config, doc), /options changed/);
  assert.equal(fixture.updateCount, 0);
  assert.equal(fixture.submissionCount, 0);
  assert.equal(doc.querySelector('[role="listbox"]'), null);
});

test('dropdown cache cannot leak between question contexts reusing the same DOM', async t => {
  const { doc, fixture, question } = setup(t, 'closed-blanks');
  await prepareStructured(doc);
  const before = question();
  doc.querySelector('h1')!.textContent = 'A new question with different choices';
  fixture.setDropdownOptions(['Portugal', 'Italy']);
  assert.equal(observePage(config, doc).state, 'unsupported');
  await prepareStructured(doc);
  assert.notEqual(fingerprint(question()), fingerprint(before));
  assert.deepEqual(question().fields?.[0].options?.map(option => option.text), ['Portugal', 'Italy']);
});

test('matching normalizes selection markers and verifies all unique native select destinations', async t => {
  const { doc, fixture, question } = setup(t, 'matching');
  const before = question();
  assert.equal(before.kind, 'matching');
  assert.equal(before.constraints?.uniqueTargets, true);
  assert.deepEqual(before.fields?.map(field => [field.id, field.label]), [['france', 'France'], ['germany', 'Germany']]);
  await selectAnswer(before, fields({ france: 'paris', germany: 'berlin' }), config, doc);
  assert.equal(fingerprint(question()), fingerprint(before));
  await submitAnswer(config, doc);
  assert.deepEqual({ ...fixture.submittedValues }, { france: 'paris', germany: 'berlin' });
});

test('matching refuses repeated destinations before changing any field', async t => {
  const { doc, fixture, question } = setup(t, 'matching');
  await assert.rejects(selectAnswer(question(), fields({ france: 'paris', germany: 'paris' }), config, doc), /different|unique|same|once/i);
  assert.equal(fixture.updateCount, 0);
});

test('pause after an asynchronous first blank stops all later fields and submission', async t => {
  const { doc, fixture, question } = setup(t, 'blanks');
  await assert.rejects(selectAnswer(question(), fields({ 'blank-1': 'France', 'blank-2': '4' }), config, doc, () => {
    if (fixture.updateCount > 0) throw new Error('Session paused');
  }), /paused/);
  assert.equal(fixture.values['blank-1'], 'France');
  assert.equal(fixture.values['blank-2'], '');
  assert.equal(fixture.submissionCount, 0);
});

test('user edit between verified application and submit prevents the click', async t => {
  const { doc, fixture, question } = setup(t, 'text');
  await selectAnswer(question(), scalar('Paris'), config, doc);
  doc.querySelector('textarea')!.value = 'Participant correction';
  await assert.rejects(submitAnswer(config, doc), /changed before submission/);
  assert.equal(fixture.submissionCount, 0);
});

test('closed controls and missing required fields stop before editing', async t => {
  const { doc, fixture, question } = setup(t, 'blanks');
  await assert.rejects(selectAnswer(question(), fields({ 'blank-1': 'France' }), config, doc), /required|every|missing|field/i);
  assert.equal(fixture.updateCount, 0);
  fixture.close();
  assert.equal(observePage(config, doc).state, 'waiting');
});
