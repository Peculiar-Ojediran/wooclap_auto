import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnthropicSolver } from '../server/anthropic.js';
import { SolveError } from '../server/solver.js';
import type { Answer, Question, SolveRequest } from '../src/shared/types.js';

// All transports are fixtures. No .env reads or paid API requests occur here.
const KEY = 'fixture-anthropic-key-never-sent-to-network';
const PRIVATE_TEXT = 'private-upstream-content-must-not-escape';
const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4i8AAAAASUVORK5CYII=';
const request: SolveRequest = {
  provider: 'anthropic', model: 'claude-sonnet-5-5', question: {
    source: 'wooclap', eventKey: 'https://app.wooclap.com/event/FIXTURE', questionId: 'fixture',
    text: 'What is six multiplied by seven?', choices: [{ id: 'a', text: '36' }, { id: 'b', text: '42' }], multiple: false, imageKeys: [],
  },
};
const answer: Answer = { selectedChoiceIds: ['b'], explanation: 'Six multiplied by seven is 42.', needsReview: false };
const signal = () => new AbortController().signal;
function responseBody(value: unknown = answer, extra: Record<string, unknown> = {}) {
  return { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }], usage: { input_tokens: 20, output_tokens: 30 }, ...extra };
}
function fixture(body: unknown, status = 200) {
  let calls = 0;
  let sent: Record<string, any> | undefined;
  let headers: Headers | undefined;
  let url: string | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls++;
    url = String(input);
    headers = new Headers(init?.headers);
    sent = JSON.parse(String(init?.body));
    assert.equal(init?.redirect, 'error');
    return Response.json(body, { status });
  };
  return { fetch, calls: () => calls, sent: () => sent!, headers: () => headers!, url: () => url! };
}
async function rejectsCode(operation: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof SolveError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.ok(!error.message.includes(PRIVATE_TEXT));
    assert.ok(!error.message.includes(KEY));
    return true;
  });
}

test('Claude sends an authenticated structured Messages request with no key in the prompt', async () => {
  const transport = fixture(responseBody());
  const result = await createAnthropicSolver(KEY, { fetch: transport.fetch })(request, signal());
  assert.deepEqual(result, { answer, provider: 'anthropic', model: request.model, demo: false, usage: { inputTokens: 20, outputTokens: 30 } });
  assert.equal(transport.calls(), 1);
  assert.equal(transport.url(), 'https://api.anthropic.com/v1/messages');
  assert.equal(transport.headers().get('x-api-key'), KEY);
  assert.equal(transport.headers().get('anthropic-version'), '2023-06-01');
  const sent = transport.sent();
  assert.equal(sent.model, request.model);
  assert.equal(sent.max_tokens, 800);
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.equal(sent.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(sent.output_config.format.schema.required.sort(), ['explanation', 'needsReview', 'selectedChoiceIds']);
  assert.equal(sent.tools, undefined);
  assert.match(sent.system, /untrusted data/);
  assert.deepEqual(JSON.parse(sent.messages[0].content[0].text), {
    question: request.question.text, kind: 'choice', choices: request.question.choices, multiple: false, imagesRequired: false, screenshotProvided: false,
  });
  assert.ok(!JSON.stringify(sent).includes(KEY));
  assert.ok(!JSON.stringify(sent).includes(request.question.eventKey));
});

test('Claude images use base64 image blocks while missing images avoid paid calls', async () => {
  const visual: SolveRequest = { ...request, question: { ...request.question, imageKeys: ['diagram'] } };
  const transport = fixture(responseBody());
  const solve = createAnthropicSolver(KEY, { fetch: transport.fetch });
  const missing = await solve(visual, signal());
  assert.equal(missing.answer.needsReview, true);
  assert.equal(missing.usage, null);
  assert.equal(transport.calls(), 0);
  await solve({ ...visual, screenshot }, signal());
  assert.deepEqual(transport.sent().messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot.split(',')[1] } });
});

test('Claude reuses choice, ordering, scalar, field, and point answer contracts', async () => {
  const base = request.question;
  const common = { explanation: 'Fixture answer.', needsReview: false };
  const examples: Array<{ question: Question; model: Record<string, unknown>; expected: Partial<Answer> }> = [
    { question: { ...base, kind: 'sorting' }, model: { selectedChoiceIds: ['a', 'b'] }, expected: { selectedChoiceIds: ['a', 'b'] } },
    { question: { ...base, kind: 'numeric', choices: [], constraints: { min: 0, max: 1, step: 0.1 } }, model: { value: '0.3' }, expected: { selectedChoiceIds: [], value: '0.3' } },
    { question: { ...base, kind: 'text', choices: [] }, model: { value: 'Photosynthesis' }, expected: { selectedChoiceIds: [], value: 'Photosynthesis' } },
    { question: { ...base, kind: 'fields', choices: [], fields: [{ id: 'field', label: 'Capital', kind: 'text', required: true }] }, model: { values: [{ id: 'field', value: 'Paris' }] }, expected: { selectedChoiceIds: [], values: [{ id: 'field', value: 'Paris' }] } },
    { question: { ...base, kind: 'point', choices: [base.choices[0]], imageKeys: ['image'] }, model: { points: [{ id: 'a', x: 0.2, y: 0.7 }] }, expected: { selectedChoiceIds: [], points: [{ id: 'a', x: 0.2, y: 0.7 }] } },
  ];
  for (const entry of examples) {
    const transport = fixture(responseBody({ ...common, ...entry.model }));
    const result = await createAnthropicSolver(KEY, { fetch: transport.fetch })({ ...request, question: entry.question, ...(entry.question.imageKeys.length ? { screenshot } : {}) }, signal());
    assert.deepEqual(result.answer, { ...common, ...entry.expected });
    assert.deepEqual(Object.keys(transport.sent().output_config.format.schema.properties).sort(), Object.keys({ ...common, ...entry.model }).sort());
    assert.match(transport.sent().system, /personal preferences/);
    assert.equal(JSON.parse(transport.sent().messages[0].content[0].text).kind, entry.question.kind);
  }
});

test('Claude rejects malformed input before transport and malformed or unsafe answers afterward', async () => {
  const transport = fixture(responseBody());
  const solve = createAnthropicSolver(KEY, { fetch: transport.fetch });
  await rejectsCode(solve({ ...request, screenshot: 'https://untrusted.example/image' }, signal()), 'INVALID_QUESTION', 400);
  await rejectsCode(solve({ ...request, model: 'https://untrusted.example' }, signal()), 'INVALID_QUESTION', 400);
  assert.equal(transport.calls(), 0);
  for (const invalid of [
    { ...answer, selectedChoiceIds: ['unknown'] }, { ...answer, selectedChoiceIds: ['a', 'b'] },
    { ...answer, selectedChoiceIds: ['b', 'b'] }, { ...answer, selectedChoiceIds: [] },
    { ...answer, explanation: 'x'.repeat(4001) }, { ...answer, apiKey: KEY }, { selectedChoiceIds: ['b'] },
  ]) await rejectsCode(createAnthropicSolver(KEY, { fetch: fixture(responseBody(invalid)).fetch })(request, signal()), 'API_INVALID_ANSWER', 422);
});

test('Claude refuses incomplete or refused answers before interpreting returned text', async () => {
  for (const [stopReason, code] of [['refusal', 'API_REFUSAL'], ['max_tokens', 'API_INCOMPLETE'], ['tool_use', 'API_INCOMPLETE'], ['pause_turn', 'API_INCOMPLETE'], [null, 'API_INCOMPLETE']]) {
    const transport = fixture(responseBody(answer, { stop_reason: stopReason, content: [{ type: 'text', text: PRIVATE_TEXT }] }));
    await rejectsCode(createAnthropicSolver(KEY, { fetch: transport.fetch })(request, signal()), code!, 422);
  }
  for (const content of [[], [{ type: 'text', text: PRIVATE_TEXT }], [{ type: 'tool_use' }], [{ type: 'text', text: JSON.stringify(answer) }, { type: 'text', text: JSON.stringify(answer) }]]) {
    await rejectsCode(createAnthropicSolver(KEY, { fetch: fixture(responseBody(answer, { content })).fetch })(request, signal()), 'API_INVALID_ANSWER', 422);
  }
});

test('Claude HTTP failures are sanitized, distinct, and never retried', async () => {
  for (const [status, code] of [
    [401, 'API_AUTH'], [402, 'API_QUOTA'], [403, 'API_ACCESS_DENIED'], [404, 'API_MODEL_UNAVAILABLE'],
    [408, 'API_TIMEOUT'], [429, 'API_RATE_LIMIT'], [400, 'API_REQUEST_REJECTED'], [529, 'API_UNAVAILABLE'],
  ] as const) {
    const transport = fixture({ error: { message: `${PRIVATE_TEXT} ${KEY}` } }, status);
    await rejectsCode(createAnthropicSolver(KEY, { fetch: transport.fetch })(request, signal()), code);
    assert.equal(transport.calls(), 1);
  }
  await rejectsCode(createAnthropicSolver(KEY, { fetch: async () => { throw new TypeError(`${KEY} ${PRIVATE_TEXT}`); } })(request, signal()), 'API_NETWORK', 502);
});

test('Claude deadline covers transport and stalled response bodies even if abort is ignored', { timeout: 5000 }, async () => {
  const stalledFetch: typeof globalThis.fetch = async () => new Promise(() => {});
  await rejectsCode(createAnthropicSolver(KEY, { fetch: stalledFetch, timeoutMs: 20 })(request, signal()), 'API_TIMEOUT', 504);
  const stalledBody: typeof globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }));
  await rejectsCode(createAnthropicSolver(KEY, { fetch: stalledBody, timeoutMs: 20 })(request, signal()), 'API_TIMEOUT', 504);
});

test('Claude caller cancellation rejects promptly and never uses a late successful response', async () => {
  let finish!: (response: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController();
  const pending = createAnthropicSolver(KEY, { fetch: async () => new Promise(resolve => { finish = resolve; entered(); }) })(request, controller.signal);
  await started;
  controller.abort();
  await rejectsCode(pending, 'API_CANCELLED', 499);
  finish(Response.json(responseBody()));
});

test('Claude discards invalid usage metadata without inventing counts', async () => {
  const result = await createAnthropicSolver(KEY, { fetch: fixture(responseBody(answer, { usage: { input_tokens: -1, output_tokens: KEY } })).fetch })(request, signal());
  assert.equal(result.usage, null);
  assert.deepEqual(result.answer, answer);
});
