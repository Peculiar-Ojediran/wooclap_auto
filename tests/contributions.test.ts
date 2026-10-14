import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { applyContributions, extractContributions, hasContributionsConfirmation, prepareContributions,
  snapshotContributions, submitContributions, verifyContributions } from '../src/content/contributions.js';
import { fingerprint } from '../src/shared/core.js';
import type { Answer } from '../src/shared/types.js';
import type { AdvancedQuestion } from '../src/content/advanced.js';

const html = readFileSync(new URL('./fixtures/contributions-participant.html', import.meta.url), 'utf8');
interface Fixture {
  delay: number; receiptDelay: number; submissionCount: number; submitMode: string;
  show(type: string): void; closeQuestion(): void; changeCategories(names: string[]): void;
  addBoardRow(value: string, index: number, own: boolean): void; edit(value: string): void;
  selected(): number; value(): string; submitted: { category: number; text: string }[];
}
const answer = (id = 'category-1', value = 'Use a shared calendar'): Answer => ({ selectedChoiceIds: [], values: [{ id, value }], explanation: 'One idea.', needsReview: false });
const pause = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t: TestContext, type = 'Brainstorm', prepare = true) {
  const dom = new JSDOM(html, { url: 'https://app.wooclap.com/CONTRB', runScripts: 'dangerously', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'complete', { get: () => true, configurable: true });
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'naturalWidth', { get: () => 480, configurable: true });
  const doc = dom.window.document;
  const fixture = (dom.window as unknown as { contributionsFixture: Fixture }).contributionsFixture;
  fixture.show(type);
  if (prepare) await prepareContributions(doc);
  const read = () => extractContributions(doc.querySelector('main')!, doc.querySelector('h1')!, 'https://app.wooclap.com/event/CONTRB', doc)!;
  const live = (): AdvancedQuestion => { const value = read(); assert.ok('controls' in value, 'detail' in value ? value.detail : 'Missing controls'); return value; };
  return { dom, doc, fixture, read, live };
}

test('Brainstorm reads all rendered categories and closes only the menu it opened', async t => {
  const { doc, live } = await setup(t);
  assert.deepEqual(live().question.choices, [{ id: 'category-0', text: 'Communication' }, { id: 'category-1', text: 'Scheduling' }]);
  assert.equal(live().question.application, 'automatic');
  assert.equal(live().question.constraints?.maxLength, 180);
  assert.equal(doc.querySelector('[role=combobox]')!.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.querySelector('textarea')!.value, '');
});

for (const stage of ['preparation', 'application']) {
  test(`Brainstorm pause during ${stage} prevents even a menu cleanup click`, async t => {
    const { doc, live, read, fixture } = await setup(t, 'Brainstorm', stage === 'application');
    const menu = doc.querySelector<HTMLButtonElement>('[role=combobox]')!;
    let active = true, clicks = 0;
    menu.addEventListener('click', () => { clicks++; active = false; });
    const guard = () => { if (!active) throw new Error('Paused'); };
    await assert.rejects(stage === 'preparation' ? prepareContributions(doc, guard)
      : applyContributions(live().question, answer(), read, guard), /Paused/);
    assert.equal(clicks, 1);
    assert.equal(menu.getAttribute('aria-expanded'), 'true');
    assert.equal(fixture.value(), '');
    assert.equal(fixture.submissionCount, 0);
  });
}

for (const type of ['Brainstorm', 'Framework']) {
  test(`${type} selects a category, waits for controlled input, and confirms one own contribution`, async t => {
    const { doc, fixture, live, read } = await setup(t, type), initial = live().question, proposal = answer();
    await applyContributions(initial, proposal, read);
    assert.equal(fixture.selected(), 1); assert.equal(fixture.value(), 'Use a shared calendar');
    assert.equal(fixture.submissionCount, 0); assert.equal(verifyContributions(live(), proposal), true);
    assert.equal(fingerprint(live().question), fingerprint(initial));
    await submitContributions(live(), proposal);
    assert.equal(fingerprint(live().question), fingerprint(initial), 'A disabled loading send button must not change question identity.');
    assert.equal(hasContributionsConfirmation(doc), false);
    await pause(); assert.equal(hasContributionsConfirmation(doc), true); assert.equal(fixture.submissionCount, 1);
    assert.equal(fixture.value(), '');
    await assert.rejects(submitContributions(live(), proposal), /changed/);
    assert.equal(fixture.submissionCount, 1);
  });

  test(`${type} ignores audience board updates in identity and only changes its input snapshot`, async t => {
    const { fixture, live, read } = await setup(t, type), before = live(), signature = snapshotContributions(before);
    fixture.addBoardRow('Another participant idea', 0, false);
    assert.equal(fingerprint(live().question), fingerprint(before.question));
    assert.equal(snapshotContributions(live()), signature);
    await applyContributions(before.question, answer(), read);
    assert.notEqual(snapshotContributions(live()), signature);
  });

  test(`${type} cancels during asynchronous category selection without submission`, async t => {
    const { fixture, live, read } = await setup(t, type); fixture.delay = 150;
    let active = true; setTimeout(() => { active = false; }, 10);
    await assert.rejects(applyContributions(live().question, answer(), read, () => { if (!active) throw new Error('Paused'); }), /Paused/);
    assert.equal(fixture.submissionCount, 0); assert.equal(fixture.value(), '');
  });

  test(`${type} stops when the question closes during preparation of the answer`, async t => {
    const { fixture, live, read } = await setup(t, type); fixture.delay = 150;
    setTimeout(() => fixture.closeQuestion(), 10);
    await assert.rejects(applyContributions(live().question, answer(), read), /changed|no longer/);
    assert.equal(fixture.submissionCount, 0);
  });

  test(`${type} rejects an edited field before submit`, async t => {
    const { fixture, live, read } = await setup(t, type), proposal = answer();
    await applyContributions(live().question, proposal, read);
    fixture.edit('My own edited idea');
    await assert.rejects(submitContributions(live(), proposal), /changed/);
    assert.equal(fixture.value(), 'My own edited idea'); assert.equal(fixture.submissionCount, 0);
  });

  for (const mode of ['clear-only', 'other-user']) {
    test(`${type} does not count ${mode} as a successful receipt`, async t => {
      const { doc, fixture, live, read } = await setup(t, type), proposal = answer();
      fixture.submitMode = mode;
      await applyContributions(live().question, proposal, read);
      await submitContributions(live(), proposal);
      await pause(); assert.equal(hasContributionsConfirmation(doc), false);
    });
  }
}

test('Brainstorm checks the option set again before choosing, even when its cache is fresh', async t => {
  const { fixture, live, read } = await setup(t), initial = live().question;
  fixture.changeCategories(['Communication', 'New category']);
  await assert.rejects(applyContributions(initial, answer(), read), /categories changed/);
  assert.equal(fixture.value(), ''); assert.equal(fixture.submissionCount, 0);
});

test('Brainstorm applies its source-specific extra line-break units before modifying controls', async t => {
  const { fixture, live, read } = await setup(t);
  await assert.rejects(applyContributions(live().question, answer('category-0', 'a'.repeat(178) + '\nb'), read), /line breaks/);
  assert.equal(fixture.selected(), 0); assert.equal(fixture.value(), '');
});

test('Brainstorm preserves an existing draft and rejects an ambiguous missing limit', async t => {
  const { fixture, doc, live, read } = await setup(t);
  fixture.edit('My draft');
  await assert.rejects(applyContributions(live().question, answer('category-0'), read), /existing draft/);
  assert.equal(fixture.value(), 'My draft');
  doc.querySelector('#characters-left')!.textContent = 'Some characters remain';
  assert.equal('state' in read() && (read() as { state: string }).state, 'unsupported');
});

test('Framework fails before mutation when a pin or its category label is ambiguous', async t => {
  const { doc, read } = await setup(t, 'Framework');
  const pin = doc.querySelector('.pin')!; pin.parentElement!.append(pin.cloneNode(true));
  assert.equal('state' in read() && (read() as { state: string }).state, 'unsupported');
});

test('Framework preserves drafts in previously selected categories', async t => {
  const { fixture, live, read } = await setup(t, 'Framework');
  await applyContributions(live().question, answer('category-0', 'A saved first draft'), read);
  await applyContributions(live().question, answer('category-1', 'A second category draft'), read);
  await assert.rejects(applyContributions(live().question, answer('category-0', 'Overwrite'), read), /existing draft/);
  assert.equal(fixture.value(), 'A saved first draft'); assert.equal(fixture.submissionCount, 0);
});

test('Contribution receipt must be a new own row in the submitted category', async t => {
  const { doc, fixture, live, read } = await setup(t, 'Framework'), proposal = answer();
  fixture.addBoardRow(proposal.values![0].value, 1, true);
  fixture.submitMode = 'clear-only';
  await applyContributions(live().question, proposal, read); await submitContributions(live(), proposal); await pause();
  assert.equal(hasContributionsConfirmation(doc), false);
  fixture.addBoardRow(proposal.values![0].value, 0, true);
  assert.equal(hasContributionsConfirmation(doc), false);
  fixture.addBoardRow(proposal.values![0].value, 1, true);
  assert.equal(hasContributionsConfirmation(doc), true);
  fixture.show('Framework'); assert.equal(hasContributionsConfirmation(doc), false);
});
