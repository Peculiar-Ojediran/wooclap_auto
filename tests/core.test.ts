import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, normalizeSettings, QuestionLedger, validateAnswer } from '../src/shared/core';
import type { Question } from '../src/shared/types';
const q: Question = { source: 'practice', eventKey: 'test', questionId: '1', text: 'A question?', multiple: false, imageKeys: [], choices: [{ id: 'a', text: 'First' }, { id: 'b', text: 'Second' }] };

test('fingerprint ignores whitespace but detects reordered choices, images, and question occurrence IDs', () => {
  assert.equal(fingerprint(q), fingerprint({ ...q, text: ' A   question? ' }));
  assert.notEqual(fingerprint(q), fingerprint({ ...q, choices: [...q.choices].reverse() }));
  assert.notEqual(fingerprint(q), fingerprint({ ...q, imageKeys: ['diagram-2'] }));
  assert.notEqual(fingerprint(q), fingerprint({ ...q, questionId: '2' }));
});
test('ledger survives serialization and blocks repeated claims', () => {
  const ledger = new QuestionLedger();
  assert.equal(ledger.claim('doc/1/question'), true);
  assert.equal(new QuestionLedger(ledger.serialize()).claim('doc/1/question'), false);
  assert.equal(ledger.claim('doc/2/question'), true);
});
test('answer validation rejects unknown, duplicated, multiple, and review answers', () => {
  const answer = { selectedChoiceIds: ['a'], explanation: 'Example.', needsReview: false };
  assert.equal(validateAnswer(q, answer), null);
  for (const ids of [[], ['c'], ['a', 'a'], ['a', 'b']]) assert.ok(validateAnswer(q, { ...answer, selectedChoiceIds: ids }));
  assert.ok(validateAnswer(q, { ...answer, needsReview: true }));
  assert.equal(validateAnswer({ ...q, multiple: true }, { ...answer, selectedChoiceIds: ['a', 'b'] }), null);
});
test('settings bounds and mutually exclusive selection semantics are enforced', () => {
  assert.throws(() => normalizeSettings({ requestLimit: 0 }));
  assert.throws(() => normalizeSettings({ requestLimit: 1.5 }));
  assert.throws(() => normalizeSettings({ model: 'bad model' }));
  assert.equal(normalizeSettings({}).mode, 'suggest');
});

test('background mode is an explicit opt-in and existing settings keep foreground behavior', () => {
  assert.equal(normalizeSettings({}).backgroundMode, false);
  assert.equal(normalizeSettings({ mode: 'auto', captureImages: true }).backgroundMode, false);
  assert.equal(normalizeSettings({ backgroundMode: true }).backgroundMode, true);
  assert.equal(normalizeSettings({ backgroundMode: false }).backgroundMode, false);
  for (const value of [undefined, null, 'true', 'false', 1]) {
    assert.equal(normalizeSettings({ backgroundMode: value as unknown as boolean }).backgroundMode, false);
  }
});

test('provider migration preserves OpenAI models and excludes credentials from ordinary settings', () => {
  assert.equal(normalizeSettings({ model: 'my-openai-model' }).provider, 'openai');
  assert.equal(normalizeSettings({ model: 'my-openai-model' }).model, 'my-openai-model');
  assert.equal(normalizeSettings({ provider: 'anthropic' }).model, 'claude-sonnet-5-5');
  assert.throws(() => normalizeSettings({ provider: 'unknown' as any }), /Choose/);
  const settings = normalizeSettings({ apiKey: 'secret', credentials: { openai: 'secret' }, selectors: { apiKey: 'secret' } } as any);
  assert.ok(!JSON.stringify(settings).includes('secret'));
});
