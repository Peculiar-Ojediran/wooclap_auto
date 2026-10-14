import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observePage, selectAnswer, submitAnswer, hasSubmissionConfirmation, sourceForUrl } from '../src/content/adapter.js';
import { fingerprint } from '../src/shared/core.js';
import { DEFAULT_SETTINGS, type Answer, type Question, type SelectorConfig } from '../src/shared/types.js';

const config: SelectorConfig = { ...DEFAULT_SETTINGS.selectors };
function page(html = '', url = 'http://127.0.0.1:4318/practice') {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url }).window.document;
}
function fixture(options: { multiple?: boolean; extra?: string; id?: string } = {}) {
  const type = options.multiple ? 'checkbox' : 'radio';
  return `<form data-wooclap-question data-question-id="${options.id ?? 'math-1'}"><h2 data-wooclap-question-text>What is 6 × 7?</h2><label><input name="answer" id="a" type="${type}">36</label><label><input name="answer" id="b" type="${type}">42</label><label><input name="answer" id="c" type="${type}">48</label>${options.extra ?? ''}<button type="submit">Submit answer</button></form>`;
}
function question(doc: Document, selectors = config): Question {
  const observation = observePage(selectors, doc);
  assert.equal(observation.state, 'question', observation.detail);
  assert.ok(observation.question);
  return observation.question;
}
const answer = (ids = ['b']): Answer => ({ selectedChoiceIds: ids, explanation: 'Because 6 × 7 = 42.', needsReview: false });

test('URL detection accepts only HTTPS Wooclap domains and the exact local practice route', () => {
  assert.equal(sourceForUrl('https://app.wooclap.com/events/ABC123'), 'wooclap');
  assert.equal(sourceForUrl('https://wooclap.com/ABC123'), 'wooclap');
  assert.equal(sourceForUrl('https://wooclap.com.evil.test/ABC123'), null);
  assert.equal(sourceForUrl('https://fakewooclap.com/ABC123'), null);
  assert.equal(sourceForUrl('http://wooclap.com/ABC123'), null);
  assert.equal(sourceForUrl('http://127.0.0.1:4318/practice'), 'practice');
  assert.equal(sourceForUrl('http://127.0.0.1:4318/other'), null);
  assert.equal(sourceForUrl('http://localhost:4318/practice'), null);
});

test('event identity stays stable across question routes and unknown event URLs are rejected', () => {
  const first = question(page(fixture(), 'https://app.wooclap.com/events/ABC123/questions/one'));
  const second = question(page(fixture(), 'https://app.wooclap.com/events/ABC123/questions/two'));
  assert.equal(first.eventKey, second.eventKey);
  assert.equal(observePage(config, page(fixture(), 'https://www.wooclap.com/features')).state, 'unsupported');
});

test('extracts native radio labels and ignores unrelated timer mutations', () => {
  const doc = page(`<span id="timer">00:01</span>${fixture()}`);
  const first = question(doc);
  assert.equal(first.multiple, false);
  assert.deepEqual(first.choices, [{ id: 'a', text: '36' }, { id: 'b', text: '42' }, { id: 'c', text: '48' }]);
  doc.querySelector('#timer')!.textContent = '00:02';
  assert.equal(fingerprint(question(doc)), fingerprint(first));
  doc.querySelector('form')!.setAttribute('data-question-id', 'math-2');
  assert.notEqual(fingerprint(question(doc)), fingerprint(first));
});

test('recognizes semantic fieldset and radio controls without fixture attributes', () => {
  const doc = page('<form><fieldset><legend>Choose a color</legend><label for="red">Red</label><input id="red" name="color" type="radio"><input id="blue" name="color" type="radio" aria-label="Blue"></fieldset></form>');
  assert.deepEqual(question(doc).choices, [{ id: 'red', text: 'Red' }, { id: 'blue', text: 'Blue' }]);
});

test('does not treat a generic heading and arbitrary page buttons as a question', () => {
  const doc = page('<h1>Welcome</h1><button>Join</button><button>Log in</button>');
  assert.equal(observePage(config, doc).state, 'waiting');
});

test('rejects ambiguous forms, missing labels, mixed selection types and malformed selectors', () => {
  assert.equal(observePage(config, page(fixture() + fixture({ id: 'two' }))).state, 'unsupported');
  const noLabel = page(fixture());
  noLabel.querySelector('label')!.replaceWith(noLabel.querySelector('#a')!);
  assert.equal(observePage(config, noLabel).state, 'unsupported');
  const mixed = page(fixture());
  mixed.querySelector('#a')!.setAttribute('type', 'checkbox');
  assert.equal(observePage(config, mixed).state, 'unsupported');
  assert.equal(observePage({ ...config, choices: 'input' }, mixed).state, 'unsupported');
  const unnamed = page(fixture().replaceAll('name="answer"', ''));
  assert.equal(observePage(config, unnamed).state, 'unsupported');
  assert.equal(observePage({ ...config, question: '[' }, page(fixture())).state, 'unsupported');
});

test('waits for images to load and excludes explicitly decorative images', () => {
  const doc = page(fixture({ extra: '<img id="diagram" src="diagram.png" alt="A diagram"><img src="icon.png" alt="">' }));
  assert.equal(observePage(config, doc).state, 'waiting');
  Object.defineProperties(doc.querySelector('#diagram')!, { complete: { value: true }, naturalWidth: { value: 180 } });
  assert.deepEqual(question(doc).imageKeys, ['http://127.0.0.1:4318/diagram.png|A diagram']);
});

test('captures the union of the question container and overflowing answer labels', () => {
  const doc = page(fixture());
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
  doc.querySelector('form')!.getBoundingClientRect = () => rect(100, 50, 200, 100);
  doc.querySelector('label')!.getBoundingClientRect = () => rect(110, 180, 230, 30);
  assert.deepEqual(observePage(config, doc).rect, { x: 100, y: 50, width: 240, height: 160, viewportWidth: 1024, viewportHeight: 768 });
});

test('stale answers, unknown choices, review answers and disabled questions never click', async () => {
  const doc = page(fixture());
  const original = question(doc);
  let clicks = 0;
  doc.addEventListener('click', () => { clicks += 1; });
  await assert.rejects(selectAnswer(original, answer(['missing']), config, doc), /unknown choice/);
  await assert.rejects(selectAnswer(original, { ...answer(), needsReview: true }, config, doc), /requires review/);
  await assert.rejects(selectAnswer(original, answer(['a', 'b']), config, doc), /invalid number/);
  doc.querySelector('h2')!.textContent = 'A different question';
  await assert.rejects(selectAnswer(original, answer(), config, doc), /question changed/);
  doc.querySelector('h2')!.textContent = original.text;
  doc.querySelector('#b')!.setAttribute('disabled', '');
  await assert.rejects(selectAnswer(original, answer(), config, doc), /question changed/);
  assert.equal(clicks, 0);
});

test('selects one radio answer without clicking an already selected answer again', async () => {
  const doc = page(fixture());
  const q = question(doc);
  let clicks = 0;
  doc.addEventListener('click', () => { clicks += 1; });
  await selectAnswer(q, answer(), config, doc);
  await selectAnswer(q, answer(), config, doc);
  assert.equal(clicks, 1);
  assert.equal((doc.querySelector('#b') as HTMLInputElement).checked, true);
});

test('checkbox selection removes unwanted choices and preserves existing correct selections', async () => {
  const doc = page(fixture({ multiple: true }));
  (doc.querySelector('#a') as HTMLInputElement).checked = true;
  (doc.querySelector('#b') as HTMLInputElement).checked = true;
  const clicked: string[] = [];
  doc.addEventListener('click', event => clicked.push((event.target as HTMLElement).id));
  await selectAnswer(question(doc), answer(['b', 'c']), config, doc);
  assert.deepEqual(clicked, ['a', 'c']);
  assert.deepEqual([...doc.querySelectorAll('input:checked')].map(input => input.id), ['b', 'c']);
});

test('stops selection if clicking one checkbox replaces the question', async () => {
  const doc = page(fixture({ multiple: true }));
  const old = question(doc);
  let clicks = 0;
  doc.querySelector('#a')!.addEventListener('click', () => { clicks += 1; doc.querySelector('form')!.setAttribute('data-question-id', 'changed'); });
  doc.querySelector('#b')!.addEventListener('click', () => { clicks += 1; });
  await assert.rejects(selectAnswer(old, answer(['a', 'b']), config, doc), /question changed/);
  assert.equal(clicks, 1);
});

test('submission requires verified selection, a unique submit button and a matching current question', async () => {
  const doc = page(fixture());
  let submits = 0;
  doc.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); submits += 1; });
  await assert.rejects(submitAnswer(config, doc), /Select and verify/);
  await selectAnswer(question(doc), answer(), config, doc);
  doc.querySelector('form')!.insertAdjacentHTML('beforeend', '<button type="submit">Another submit</button>');
  await assert.rejects(submitAnswer(config, doc), /unique enabled submit/);
  doc.querySelector('form button:last-child')!.remove();
  await submitAnswer(config, doc);
  await assert.rejects(submitAnswer(config, doc), /Select and verify/);
  assert.equal(submits, 1);
  await selectAnswer(question(doc), answer(), config, doc);
  doc.querySelector('form')!.setAttribute('data-question-id', 'new');
  await assert.rejects(submitAnswer(config, doc), /question changed/);
  assert.equal(submits, 1);
});

test('configured role controls can be selected, and submit-on-choice is explicit', async () => {
  const doc = page('<section data-question-id="role-1"><h2>Pick one</h2><button role="radio" aria-checked="false" id="a">A</button><button role="radio" aria-checked="false" id="b">B</button></section>');
  doc.querySelector('#b')!.addEventListener('click', () => doc.querySelector('#b')!.setAttribute('aria-checked', 'true'));
  const custom = { ...config, question: 'h2', choices: '[role="radio"]', choiceClickSubmits: true };
  assert.deepEqual(await selectAnswer(question(doc, custom), answer(), custom, doc), { submittedBySelection: true });
  assert.equal(observePage({ ...config, choiceClickSubmits: true }, page(fixture({ multiple: true }))).state, 'unsupported');
});

test('does not submit when a participant changes selections after the answer was applied', async () => {
  const doc = page(fixture({ multiple: true }));
  let submits = 0;
  doc.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); submits += 1; });
  await selectAnswer(question(doc), answer(['a', 'b']), config, doc);
  (doc.querySelector('#c') as HTMLInputElement).checked = true;
  await assert.rejects(submitAnswer(config, doc), /choices changed/);
  assert.equal(submits, 0);
});

test('confirmation requires an explicit marker or a positive status, never general page text', () => {
  assert.equal(hasSubmissionConfirmation(config, page('<p>Answer submitted.</p>')), false);
  assert.equal(hasSubmissionConfirmation(config, page('<div role="status">Your answer was not submitted.</div>')), false);
  assert.equal(hasSubmissionConfirmation(config, page('<div role="status">Submitting your answer…</div>')), false);
  assert.equal(hasSubmissionConfirmation(config, page('<div role="status">Your answer was submitted successfully.</div>')), true);
  assert.equal(hasSubmissionConfirmation(config, page('<div data-wooclap-confirmation hidden>Answer submitted.</div>')), false);
  assert.equal(observePage(config, page('<div data-wooclap-confirmation>Done!</div>')).state, 'submitted');
  assert.equal(observePage(config, page('<div data-wooclap-waiting>Waiting</div>')).state, 'waiting');
});
