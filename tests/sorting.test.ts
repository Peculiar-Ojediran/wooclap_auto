import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { observePage, selectAnswer, submitAnswer, hasSubmissionConfirmation } from '../src/content/adapter';
import { fingerprint, validateAnswer } from '../src/shared/core';
import { validAnswer, solveRequestSchema } from '../server/validation';
import { DEFAULT_SETTINGS, type Answer } from '../src/shared/types';

const html = readFileSync(new URL('./fixtures/wooclap-participant.html', import.meta.url), 'utf8');
const config = DEFAULT_SETTINGS.selectors;
const answer: Answer = { selectedChoiceIds: ['sort-10', 'sort-20', 'sort-30'], explanation: 'Ascending order.', needsReview: false };
function setup(t: { after(fn: () => void): void }) {
  const dom = new JSDOM(html, { url: 'https://app.wooclap.com/test', runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const fixture = (dom.window as any).fixture;
  fixture.show('sorting');
  const doc = dom.window.document;
  const question = observePage(config, doc).question!;
  assert.equal(question?.kind, 'sorting');
  return { doc, fixture, question };
}
test('sorting requires a complete permutation in both client and bridge', t => {
  const { question } = setup(t);
  assert.ok(solveRequestSchema.safeParse({ question, model: 'test' }).success);
  assert.equal(validateAnswer(question, answer), null);
  assert.ok(validAnswer(answer, question));
  for (const ids of [[], ['sort-10'], ['sort-10', 'sort-10', 'sort-30'], ['sort-10', 'sort-20', 'unknown']]) {
    const bad = { ...answer, selectedChoiceIds: ids };
    assert.ok(validateAnswer(question, bad)); assert.equal(validAnswer(bad, question), false);
  }
});
test('sorting uses asynchronous movement controls, stable identity and separate submit', async t => {
  const { doc, fixture, question } = setup(t);
  await selectAnswer(question, answer, config, doc);
  assert.equal(fixture.submissionCount, 0);
  assert.equal(fingerprint(observePage(config, doc).question!), fingerprint(question));
  await submitAnswer(config, doc);
  assert.deepEqual(Array.from(fixture.submittedIds), answer.selectedChoiceIds);
  assert.ok(hasSubmissionConfirmation(config, doc));
});
test('sorting order changed after selection prevents submission', async t => {
  const { doc, fixture, question } = setup(t);
  await selectAnswer(question, answer, config, doc);
  doc.querySelector('ul')!.append(doc.querySelector('li')!);
  await assert.rejects(submitAnswer(config, doc), /changed/);
  assert.equal(fixture.submissionCount, 0);
});
test('pause or question replacement interrupts sorting', async t => {
  for (const pause of [true, false]) {
    const { doc, fixture, question } = setup(t);
    let active = true;
    setTimeout(() => { if (pause) active = false; else fixture.show('single'); }, 80);
    await assert.rejects(selectAnswer(question, answer, config, doc, () => { if (!active) throw new Error('Paused'); }), /Paused|changed/);
    assert.equal(fixture.submissionCount, 0);
  }
});
test('sorting rejects missing movement controls and duplicate identities', t => {
  const { doc, fixture } = setup(t);
  doc.querySelector('li')!.querySelectorAll('button').forEach(button => button.remove());
  assert.equal(observePage(config, doc).state, 'unsupported');
  fixture.show('sorting');
  doc.querySelectorAll('li')[1].setAttribute('data-rbd-draggable-id', 'sort-30');
  assert.equal(observePage(config, doc).state, 'unsupported');
});

test('sorting refuses visually meaningful ARIA-hidden images, diagrams, and extra comments', t => {
  const { doc, fixture } = setup(t);
  for (const markup of ['<img aria-hidden="true" alt="" src="diagram.png">',
    '<svg aria-hidden="true"><path d="M0 0 L10 10"/></svg>', '<textarea required></textarea>']) {
    fixture.show('sorting');
    doc.querySelector('.Sorting')!.insertAdjacentHTML('beforeend', markup);
    assert.equal(observePage(config, doc).state, 'unsupported');
    assert.equal(fixture.submissionCount, 0);
  }
});

test('media appearing after a sorting answer was generated prevents application', async t => {
  const { doc, fixture, question } = setup(t);
  doc.querySelector('.Sorting')!.insertAdjacentHTML('beforeend', '<img aria-hidden="true" alt="" src="diagram.png">');
  await assert.rejects(selectAnswer(question, answer, config, doc), /changed|available/);
  assert.equal(fixture.submissionCount, 0);
});
