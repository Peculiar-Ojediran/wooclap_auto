import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { observePage, selectAnswer, submitAnswer, hasSubmissionConfirmation, eventKeyForUrl } from '../src/content/adapter';
import { DEFAULT_SETTINGS, type Answer } from '../src/shared/types';
import { fingerprint } from '../src/shared/core';

const html = readFileSync(new URL('./fixtures/wooclap-participant.html', import.meta.url), 'utf8');
const config = DEFAULT_SETTINGS.selectors;
interface Fixture {
  show(kind: 'single' | 'multiple' | 'image'): void;
  close(): void; waiting(): void; miss(): void;
  feedback(icon: string, text: string): void;
  submissionCount: number; submittedIds: string[]; selectedIds: string[];
  selectionDelay: number;
}
function setup(t: TestContext, path = 'course-alias') {
  const dom = new JSDOM(html, { url: `https://app.wooclap.com/${path}`, runScripts: 'dangerously', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const fixture = (dom.window as unknown as { fixture: Fixture }).fixture;
  const question = () => {
    const observation = observePage(config, doc);
    assert.equal(observation.state, 'question', observation.detail);
    assert.ok(observation.question);
    return observation.question;
  };
  return { doc, fixture, question };
}
const answer = (...ids: string[]): Answer => ({ selectedChoiceIds: ids, explanation: 'Test answer.', needsReview: false });

test('live route aliases and self-paced routes retain event identity and exclude organizer/login', () => {
  const base = eventKeyForUrl('https://app.wooclap.com/physics-2026');
  assert.equal(base, 'https://app.wooclap.com/event/PHYSICS-2026');
  for (const path of ['/questionnaires/id123', '/presentations/slides123', '/wall', '/report/votes']) {
    assert.equal(eventKeyForUrl('https://app.wooclap.com/physics-2026' + path), base);
  }
  for (const url of ['https://app.wooclap.com/auth', 'https://app.wooclap.com/events/ABCDEF', 'https://app.wooclap.com/public', 'https://wooclap.com.evil.test/code', 'http://wooclap.com/code']) assert.equal(eventKeyForUrl(url), null);
});

test('extracts observed custom buttons and ignores selection/timer mutations', t => {
  const { doc, question } = setup(t);
  const first = question();
  assert.equal(first.questionId, null);
  assert.deepEqual(first.choices.map(choice => choice.id), ['choice-1', 'choice-2', 'choice-3']);
  doc.querySelector('#fixture-timer')!.textContent = '10';
  doc.querySelector('button[role]')!.setAttribute('aria-checked', 'true');
  assert.equal(fingerprint(question()), fingerprint(first));
  doc.querySelector('ul')!.append(doc.querySelector('li')!);
  assert.notEqual(fingerprint(question()), fingerprint(first));
});

test('waits for asynchronous single selection and uses the separate submit control', async t => {
  const { doc, fixture, question } = setup(t);
  await selectAnswer(question(), answer('choice-2'), config, doc);
  assert.equal(fixture.submissionCount, 0);
  assert.deepEqual(Array.from(fixture.selectedIds), ['choice-2']);
  await submitAnswer(config, doc);
  assert.equal(fixture.submissionCount, 1);
  assert.equal(hasSubmissionConfirmation(config, doc), true);
  assert.equal(observePage(config, doc).state, 'submitted');
});

test('multiple-answer selection handles async updates and clears unwanted choices', async t => {
  const { doc, fixture, question } = setup(t);
  fixture.show('multiple');
  doc.querySelector('button[data-idx="2"]')!.setAttribute('aria-checked', 'true');
  await selectAnswer(question(), answer('choice-1', 'choice-3'), config, doc);
  assert.deepEqual(Array.from(fixture.selectedIds), ['choice-1', 'choice-3']);
  await submitAnswer(config, doc);
  assert.deepEqual(Array.from(fixture.submittedIds), ['choice-1', 'choice-3']);
});

test('pause during an asynchronous update prevents later choice clicks and submission', async t => {
  const { doc, fixture, question } = setup(t);
  fixture.show('multiple');
  fixture.selectionDelay = 100;
  let active = true;
  const clicked: string[] = [];
  doc.addEventListener('click', event => clicked.push((event.target as Element).closest('[data-idx]')?.getAttribute('data-idx') || ''));
  setTimeout(() => { active = false; }, 35);
  await assert.rejects(selectAnswer(question(), answer('choice-1', 'choice-3'), config, doc, () => { if (!active) throw new Error('Paused'); }), /Paused/);
  assert.deepEqual(clicked, ['1']);
  assert.equal(fixture.submissionCount, 0);
});

test('a question closing during asynchronous selection prevents submission', async t => {
  const { doc, fixture, question } = setup(t);
  fixture.selectionDelay = 100;
  setTimeout(() => fixture.close(), 20);
  await assert.rejects(selectAnswer(question(), answer('choice-2'), config, doc), /changed|available/);
  assert.equal(fixture.submissionCount, 0);
});

test('missed and generic feedback never count as submitted; positive icons do', t => {
  const { doc, fixture } = setup(t);
  for (const icon of ['hourglass-start', 'hourglass-end', 'unknown']) {
    fixture.show('single'); fixture.close(); fixture.feedback(icon, 'Feedback');
    assert.equal(hasSubmissionConfirmation(config, doc), false);
    assert.equal(observePage(config, doc).state, 'waiting');
  }
  for (const icon of ['paper-plane', 'stars', 'circle-xmark']) {
    fixture.show('single'); fixture.close(); fixture.feedback(icon, 'Localized feedback');
    assert.equal(hasSubmissionConfirmation(config, doc), true);
  }
});

test('meaningful images with empty alt and aria-hidden still require capture', t => {
  const { doc, fixture, question } = setup(t);
  fixture.show('image');
  assert.equal(observePage(config, doc).state, 'waiting');
  for (const image of doc.querySelectorAll('img')) {
    Object.defineProperty(image, 'complete', { value: true });
    Object.defineProperty(image, 'naturalWidth', { value: 180 });
  }
  assert.equal(question().imageKeys.length, 2);
  doc.querySelector('button[role] span')!.textContent = '';
  assert.match(question().choices[0].text, /Image option 1/);
});

test('unknown types, comments, inconsistent controls and immediate-submit config are rejected', t => {
  const { doc, fixture } = setup(t);
  doc.querySelector('.MCQ')!.className = 'OpenQuestion';
  assert.equal(observePage(config, doc).state, 'unsupported');
  fixture.show('single');
  doc.querySelector('.MCQ')!.append(doc.createElement('textarea'));
  assert.equal(observePage(config, doc).state, 'unsupported');
  fixture.show('single');
  doc.querySelector('button[role]')!.removeAttribute('aria-checked');
  assert.equal(observePage(config, doc).state, 'unsupported');
  fixture.show('single');
  assert.equal(observePage({ ...config, choiceClickSubmits: true }, doc).state, 'unsupported');
});
