import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createBridgeServer } from '../server/http.js';
import { createOpenAISolver, SolveError } from '../server/solver.js';
import { modelAnswerSchema, normalizeModelAnswer, questionSchema, solveRequestSchema, validAnswer } from '../server/validation.js';
import { fingerprint, validateAnswer, validateNumericValue } from '../src/shared/core.js';
import { PROTOCOL_VERSION, type Answer, type Question, type QuestionKind } from '../src/shared/types.js';

const base: Question = {
  source: 'wooclap', eventKey: 'https://app.wooclap.com/contract-test', questionId: 'test-question',
  text: 'An example question', choices: [], multiple: false, imageKeys: [],
};
const common = { selectedChoiceIds: [], explanation: 'A concise explanation.', needsReview: false };
const options = [{ id: 'a', text: 'First' }, { id: 'b', text: 'Second' }];
const textField = { id: 'text', label: 'The blank', kind: 'text' as const, required: true, maxLength: 10 };
const numberField = { id: 'number', label: 'A numeric field', kind: 'number' as const, required: true, min: 0, max: 100, step: 0.1 };
const selectField = { id: 'select', label: 'A dropdown', kind: 'select' as const, required: true, options };
const q = (kind: QuestionKind, extra: Partial<Question> = {}): Question => ({ ...base, kind, ...extra });
const examples: Array<{ question: Question; answer: Answer; model: object }> = [
  { question: q('numeric', { constraints: { min: -1, max: 2, step: 0.1 } }), answer: { ...common, value: '0.3' }, model: { value: '0.3' } },
  { question: q('text', { constraints: { maxLength: 20 }, responseMode: 'contribution' }), answer: { ...common, value: 'Photosynthesis' }, model: { value: 'Photosynthesis' } },
  { question: q('fields', { fields: [textField, numberField, selectField] }), answer: { ...common, values: [{ id: 'text', value: 'Paris' }, { id: 'number', value: '0.3' }, { id: 'select', value: 'b' }] }, model: { values: [{ id: 'text', value: 'Paris' }, { id: 'number', value: '0.3' }, { id: 'select', value: 'b' }] } },
  { question: q('matching', { fields: [selectField, { ...selectField, id: 'other' }] }), answer: { ...common, values: [{ id: 'select', value: 'a' }, { id: 'other', value: 'a' }] }, model: { values: [{ id: 'select', value: 'a' }, { id: 'other', value: 'a' }] } },
  { question: q('rating', { fields: [numberField] }), answer: { ...common, values: [{ id: 'number', value: '4' }] }, model: { values: [{ id: 'number', value: '4' }] } },
  { question: q('allocation', { fields: [numberField, { ...numberField, id: 'other' }], constraints: { total: 0.3 } }), answer: { ...common, values: [{ id: 'number', value: '0.1' }, { id: 'other', value: '0.2' }] }, model: { values: [{ id: 'number', value: '0.1' }, { id: 'other', value: '0.2' }] } },
  { question: q('categorized', { choices: options, constraints: { maxEntries: 1, maxLength: 30 } }), answer: { ...common, values: [{ id: 'a', value: 'A factual contribution.' }] }, model: { values: [{ id: 'a', value: 'A factual contribution.' }] } },
  { question: q('point', { choices: [options[0]], imageKeys: ['diagram'] }), answer: { ...common, points: [{ id: 'a', x: 0.2, y: 0.8 }] }, model: { points: [{ id: 'a', x: 0.2, y: 0.8 }] } },
  { question: q('placements', { choices: options, imageKeys: ['diagram'] }), answer: { ...common, points: [{ id: 'a', x: 0, y: 1 }, { id: 'b', x: 1, y: 0 }] }, model: { points: [{ id: 'a', x: 0, y: 1 }, { id: 'b', x: 1, y: 0 }] } },
  { question: q('scenario', { choices: options }), answer: { ...common, selectedChoiceIds: ['b'] }, model: { selectedChoiceIds: ['b'] } },
];

test('expanded question contracts accept each supported family and reject incompatible definitions', () => {
  for (const { question, answer } of examples) {
    assert.equal(questionSchema.safeParse(question).success, true, question.kind);
    assert.equal(validateAnswer(question, answer), null, question.kind);
    assert.equal(validAnswer(answer, question), true, question.kind);
  }
  for (const question of [
    q('choice'), q('sorting', { choices: [options[0]] }), q('numeric', { choices: options }),
    q('fields'), q('matching', { fields: [textField] }), q('rating', { fields: [selectField] }),
    q('allocation', { fields: [numberField] }), q('point', { choices: options, imageKeys: ['image'] }),
    q('placements', { choices: options }), q('categorized'), q('scenario', { choices: options, fields: [textField] }),
    q('fields', { fields: [textField, textField] }), q('numeric', { constraints: { min: 3, max: 1 } }),
    q('numeric', { constraints: { step: 0 } }), q('text', { constraints: { maxLength: 0 } }),
    q('fields', { fields: [{ ...selectField, options: [options[0], options[0]] }] }),
  ]) assert.equal(questionSchema.safeParse(question).success, false, JSON.stringify(question));
});

test('numeric validation preserves exact decimal ranges and steps without floating-point rounding', () => {
  for (const value of ['0', '-0.5', '9007199254740993', '0.00000000000000000001']) assert.equal(validateNumericValue(value), null);
  assert.equal(validateNumericValue('0.3', { min: 0.1, max: 0.3, step: 0.1 }), null);
  assert.equal(validateNumericValue('0.0000001', { min: 0, step: 1e-7 }), null);
  assert.equal(validateNumericValue('1.25', { min: 0.25, step: 0.5 }), null);
  for (const value of ['', ' ', '01', '+1', '.5', '1.', '1e3', 'NaN', 'Infinity', '1,234', '42 kg', '0x10']) assert.ok(validateNumericValue(value), value);
  assert.ok(validateNumericValue('0.30000000000000001', { max: 0.3 }));
  assert.ok(validateNumericValue('9007199254740993', { max: 9007199254740992 }));
  assert.ok(validateNumericValue('0.25', { min: 0.1, step: 0.1 }));
});

test('field validation enforces coverage, types, IDs, lengths, and visible dropdown values', () => {
  const { question, answer } = examples.find(item => item.question.kind === 'fields')!;
  for (const values of [
    answer.values!.slice(1), [...answer.values!, answer.values![0]],
    answer.values!.map(item => item.id === 'select' ? { ...item, value: 'Second' } : item),
    answer.values!.map(item => item.id === 'text' ? { ...item, value: ' '.repeat(3) } : item),
    answer.values!.map(item => item.id === 'text' ? { ...item, value: 'x'.repeat(11) } : item),
    answer.values!.map(item => item.id === 'number' ? { ...item, value: '0.05' } : item),
    [...answer.values!, { id: 'unknown', value: 'value' }],
  ]) assert.ok(validateAnswer(question, { ...answer, values }));
  const optional = { ...question, fields: [...question.fields!, { ...textField, id: 'optional', required: false }] };
  assert.equal(validateAnswer(optional, answer), null);
});

test('matching permits shared targets unless the observed controls explicitly require uniqueness', () => {
  const { question, answer } = examples.find(item => item.question.kind === 'matching')!;
  assert.equal(validateAnswer(question, answer), null);
  assert.ok(validateAnswer({ ...question, constraints: { uniqueTargets: true } }, answer));
  assert.equal(validateAnswer({ ...question, constraints: { uniqueTargets: true } }, {
    ...answer, values: [{ id: 'select', value: 'a' }, { id: 'other', value: 'b' }],
  }), null);
});

test('allocation uses exact arithmetic for the total and rejects negative points', () => {
  const { question, answer } = examples.find(item => item.question.kind === 'allocation')!;
  assert.equal(validateAnswer(question, answer), null);
  assert.ok(validateAnswer(question, { ...answer, values: [{ id: 'number', value: '0.1' }, { id: 'other', value: '0.1' }] }));
  const allowsNegative = { ...question, fields: question.fields!.map(field => ({ ...field, min: -10 })) };
  assert.ok(validateAnswer(allowsNegative, { ...answer, values: [{ id: 'number', value: '-0.1' }, { id: 'other', value: '0.4' }] }));
  assert.ok(validateAnswer({ ...question, fields: [textField] }, { ...common, values: [{ id: 'text', value: 'not a number' }] }));
});

test('categorized answers have bounded contributions and image points require known IDs and coverage', () => {
  const category = examples.find(item => item.question.kind === 'categorized')!;
  assert.ok(validateAnswer(category.question, { ...category.answer, values: [...category.answer.values!, ...category.answer.values!] }));
  assert.ok(validateAnswer(category.question, { ...category.answer, values: [{ id: 'missing', value: 'Text' }] }));
  assert.ok(validateAnswer(category.question, { ...category.answer, values: [{ id: 'a', value: 'x'.repeat(31) }] }));
  const placements = examples.find(item => item.question.kind === 'placements')!;
  for (const points of [
    placements.answer.points!.slice(1), [...placements.answer.points!, placements.answer.points![0]],
    [{ id: 'a', x: -0.1, y: 0.5 }, { id: 'b', x: 0.5, y: 0.5 }],
    [{ id: 'a', x: 0.5, y: Number.NaN }, { id: 'b', x: 0.5, y: 0.5 }],
    [{ id: 'unknown', x: 0.5, y: 0.5 }, { id: 'b', x: 0.5, y: 0.5 }],
  ]) assert.ok(validateAnswer(placements.question, { ...placements.answer, points }));
});

test('answer families reject extraneous payloads and permit empty unresolved review responses', () => {
  for (const { question, answer } of examples) {
    assert.equal(validAnswer({ ...common, needsReview: true }, question), true, question.kind);
    assert.ok(validateAnswer(question, { ...common, needsReview: true }), question.kind);
    assert.equal(validAnswer({ ...answer, unexpected: 'hidden' } as Answer, question), false);
    if (question.kind !== 'scenario') assert.ok(validateAnswer(question, { ...answer, selectedChoiceIds: ['a'] }));
    if (question.kind !== 'text' && question.kind !== 'numeric') assert.ok(validateAnswer(question, { ...answer, value: 'mixed family' }));
  }
  assert.ok(validateAnswer(q('choice', { choices: options }), { ...common, selectedChoiceIds: ['a'], points: [] }));
});

test('extended fingerprints include full field context and constraints while preserving legacy keys', () => {
  const legacy = q('choice', { choices: options });
  const expected = JSON.stringify({ source: legacy.source, event: legacy.eventKey, id: legacy.questionId, text: legacy.text,
    multiple: false, kind: 'choice', choices: options.map(option => [option.id, option.text]), images: [] });
  assert.equal(fingerprint(legacy), expected);
  const fields = examples.find(item => item.question.kind === 'fields')!.question;
  assert.notEqual(fingerprint(fields), fingerprint({ ...fields, fields: fields.fields!.map(field => ({ ...field, label: field.label + ' context' })) }));
  assert.notEqual(fingerprint(fields), fingerprint({ ...fields, fields: fields.fields!.map(field => ({ ...field, required: !field.required })) }));
  assert.notEqual(fingerprint(fields), fingerprint({ ...fields, constraints: { maxEntries: 1 } }));
  assert.notEqual(fingerprint(fields), fingerprint({ ...fields, wooclapType: 'LabelAnImage' }));
  assert.equal(fingerprint(fields), fingerprint({ ...fields, fields: fields.fields!.map(field => ({ ...field, label: ' ' + field.label + ' ' })) }));
  assert.equal(fingerprint(q('sorting', { choices: options })), fingerprint(q('sorting', { choices: [...options].reverse() })));
});

test('model schemas are strict per family and normalize only their own payload', () => {
  for (const { question, answer, model } of examples) {
    const data = { ...model, explanation: common.explanation, needsReview: false };
    assert.deepEqual(normalizeModelAnswer(question, data), answer);
    assert.equal(modelAnswerSchema(question).safeParse({ ...data, unrelated: [] }).success, false);
    if (question.kind !== 'scenario') assert.equal(modelAnswerSchema(question).safeParse({ ...data, selectedChoiceIds: [] }).success, false);
  }
  assert.deepEqual(normalizeModelAnswer(q('text'), { value: null, explanation: 'Need your preference.', needsReview: true }), {
    selectedChoiceIds: [], explanation: 'Need your preference.', needsReview: true,
  });
});

test('actual SDK transport uses the right schema and full metadata for every new family', async () => {
  const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4i8AAAAASUVORK5CYII=';
  for (const { question, answer, model } of examples) {
    let sent: Record<string, any> | undefined;
    const solve = createOpenAISolver('fixture-key-no-network', { fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ id: 'resp_fixture', object: 'response', created_at: 1, model: 'gpt-4.1-mini', status: 'completed',
        error: null, incomplete_details: null, output: [{ id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify({ ...model, explanation: common.explanation, needsReview: false }), annotations: [] }] }],
        usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 } });
    } });
    const result = await solve({ protocolVersion: 2, model: 'gpt-4.1-mini', question, ...(question.imageKeys.length ? { screenshot } : {}) }, new AbortController().signal);
    assert.deepEqual(result.answer, answer, question.kind);
    assert.equal(sent!.text.format.strict, true);
    assert.deepEqual(Object.keys(sent!.text.format.schema.properties).sort(), Object.keys({ ...model, explanation: '', needsReview: false }).sort());
    const prompt = JSON.parse(sent!.input[0].content[0].text);
    assert.deepEqual(prompt.fields, question.fields);
    assert.deepEqual(prompt.constraints, question.constraints);
    assert.match(sent!.instructions, /personal preferences/);
    assert.ok(sent!.max_output_tokens >= 1_600 && sent!.max_output_tokens <= 6_000);
  }
});

test('incompatible or incomplete structured answers fail before returning a usable response', async () => {
  for (const value of [ { value: '0.30000000000000001' }, { value: null }, { selectedChoiceIds: ['a'] }, { value: '0.3', points: [] } ]) {
    const solve = createOpenAISolver('fixture-key-no-network', { fetch: async () => Response.json({
      id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', error: null, incomplete_details: null,
      output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ ...value, explanation: 'Test', needsReview: false }), annotations: [] }] }],
    }) });
    await assert.rejects(solve({ model: 'gpt-4.1-mini', question: q('numeric', { constraints: { max: 0.3 } }) }, new AbortController().signal),
      (error: unknown) => error instanceof SolveError && error.code === 'API_INVALID_ANSWER');
  }
});

test('bridge advertises protocol 2, accepts legacy and version 2 requests, and rejects other versions before solver', async t => {
  let calls = 0;
  const token = 'test-pairing-token-for-protocol-check-123456789';
  const server = createBridgeServer({ token, solver: async () => {
    calls++;
    return { answer: { ...common, value: '42' }, model: 'fixture', usage: null, demo: false };
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await (await fetch(url + '/health', { headers })).json()).protocolVersion, PROTOCOL_VERSION);
  const request = { model: 'gpt-4.1-mini', question: q('numeric') };
  for (const body of [request, { ...request, protocolVersion: 2 }]) {
    assert.equal(solveRequestSchema.safeParse(body).success, true);
    assert.equal((await fetch(url + '/solve', { method: 'POST', headers, body: JSON.stringify(body) })).status, 200);
  }
  for (const protocolVersion of [1, 3, null, '2']) {
    const response = await fetch(url + '/solve', { method: 'POST', headers, body: JSON.stringify({ ...request, protocolVersion }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'PROTOCOL_MISMATCH');
  }
  assert.equal(calls, 2);
});
