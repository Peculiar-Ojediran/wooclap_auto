import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { prepareScenarios, extractScenarios, applyScenarios, verifyScenarios, snapshotScenarios } from '../src/content/scenarios';
import { fingerprint } from '../src/shared/core';
import type { Answer } from '../src/shared/types';
import type { AdvancedQuestion } from '../src/content/advanced';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { observePage, selectAnswer, submitAnswer, hasSubmissionConfirmation } from '../src/content/adapter';

const html = readFileSync(new URL('./fixtures/scenario-participant.html', import.meta.url), 'utf8');
function setup(t: TestContext, kind = 'Concordance') {
  const dom = new JSDOM(html, { url: 'https://app.wooclap.com/SCENARIOS', runScripts: 'dangerously', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, fixture = (dom.window as any).scenarioFixture;
  fixture.show(kind);
  const live = () => {
    const result = extractScenarios(doc.querySelector('main')!, doc.querySelector('h1')!, 'event', doc);
    assert.ok(result && 'controls' in result, 'The prepared scenario should be answerable');
    return result as AdvancedQuestion;
  };
  return { doc, fixture, live, dom };
}
const answer = (value: number): Answer => ({ selectedChoiceIds: [`scale-${value}`], explanation: 'Fixture reasoning', needsReview: false });

test('scenario preparation reads every actual custom label, preserves existing selection, and never submits', async t => {
  const { doc, fixture, live } = setup(t); fixture.select(1);
  fixture.setLabels(['Impossible', 'Less plausible', 'Unchanged', 'More plausible', 'Certain']);
  await prepareScenarios(doc);
  assert.deepEqual(live().question.choices.map(c => c.text), Array.from(fixture.labels));
  assert.equal(fixture.score, 1); assert.equal(fixture.submissionCount, 0);
  const before = fixture.keyCount; await prepareScenarios(doc); assert.equal(fixture.keyCount, before);
  assert.match(live().question.text, /forecast.*New radar/s);
});
test('unanswered scenario preparation leaves a local draft without sending an answer', async t => {
  const { doc, fixture, live } = setup(t); await prepareScenarios(doc);
  assert.equal(fixture.score, -2); assert.equal(live().question.application, 'automatic'); assert.equal(fixture.submissionCount, 0);
});
test('Concordance verifies actual zero despite incorrect ARIA fallback and submits through the common adapter', async t => {
  const { doc, fixture } = setup(t); await prepareScenarios(doc);
  const q = observePage(DEFAULT_SETTINGS.selectors, doc).question!;
  await selectAnswer(q, answer(0), DEFAULT_SETTINGS.selectors, doc);
  assert.equal(doc.querySelector('[role=slider]')!.getAttribute('aria-valuenow'), '-2');
  assert.equal(doc.querySelector('[data-score]')!.getAttribute('data-score'), '0');
  await submitAnswer(DEFAULT_SETTINGS.selectors, doc);
  assert.equal(fixture.submitted.score, 0); assert.ok(hasSubmissionConfirmation(DEFAULT_SETTINGS.selectors, doc));
});
test('SCT Judgment respects its four hidden-label positions and preserves optional comments', async t => {
  const { doc, fixture, live } = setup(t, 'SCTJudgment');
  const comment = doc.querySelector('textarea')!; comment.value = 'My existing reasoning.';
  comment.dispatchEvent(new doc.defaultView!.Event('input', { bubbles: true }));
  await prepareScenarios(doc); const q = live().question; const before = fingerprint(q), snap = snapshotScenarios(live());
  assert.deepEqual(q.choices.map(c => c.id), ['scale--2', 'scale--1', 'scale-1', 'scale-2']);
  await applyScenarios(q, answer(1), live);
  assert.ok(verifyScenarios(live(), answer(1))); assert.equal(fixture.score, 1);
  assert.equal(comment.value, 'My existing reasoning.'); assert.equal(fingerprint(live().question), before);
  assert.notEqual(snapshotScenarios(live()), snap);
});
test('changing a selected custom label invalidates its cached description before submission', async t => {
  const { doc, fixture, live } = setup(t); await prepareScenarios(doc); const q = live().question;
  fixture.setLabels(['A', 'B', 'Different meaning', 'D', 'E']);
  await assert.rejects(applyScenarios(q, answer(0), live), /description changed/);
  assert.equal(fixture.submissionCount, 0);
  await prepareScenarios(doc); assert.notEqual(fingerprint(live().question), fingerprint(q));
});
test('scenario preparation stops on cancellation without later keys or submission', async t => {
  const { doc, fixture } = setup(t); let active = true; fixture.delay = 120;
  setTimeout(() => { active = false; }, 40);
  await assert.rejects(prepareScenarios(doc, () => { if (!active) throw new Error('Paused'); }), /Paused/);
  const count = fixture.keyCount; await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(fixture.keyCount, count); assert.equal(fixture.submissionCount, 0);
});
test('scenario close or case replacement interrupts application', async t => {
  const { doc, fixture, live } = setup(t); await prepareScenarios(doc); const q = live().question;
  fixture.delay = 120; setTimeout(() => fixture.close(), 40);
  await assert.rejects(applyScenarios(q, answer(2), live), /changed|closed/);
  assert.equal(fixture.submissionCount, 0);
});
test('changed scenario evidence cannot reuse previously prepared scale metadata', async t => {
  const { doc, live } = setup(t); await prepareScenarios(doc); const old = live().question;
  doc.querySelector('#case-text')!.textContent = 'A different case';
  assert.equal(extractScenarios(doc.querySelector('main')!, doc.querySelector('h1')!, 'event', doc), null);
  await prepareScenarios(doc); assert.notEqual(fingerprint(live().question), fingerprint(old));
});
test('required extra comments stay preview-only and incomplete scales cannot be automated', async t => {
  const { doc } = setup(t); doc.querySelector('textarea')!.required = true;
  await prepareScenarios(doc); const current = observePage(DEFAULT_SETTINGS.selectors, doc);
  assert.equal(current.question?.application, 'preview');
  await assert.rejects(selectAnswer(current.question!, answer(1), DEFAULT_SETTINGS.selectors, doc), /preview/);
});
