import assert from 'node:assert/strict';
import test from 'node:test';
import { createNvidiaSolver } from '../src/ai/nvidia.js';
import { SolveError } from '../src/ai/solver.js';
import type { Answer, Question, SolveRequest } from '../src/shared/types.js';

// Fixture transports only: these tests never load credentials or call NVIDIA.
const KEY = 'fixture-nvidia-key-never-sent-to-network';
const PRIVATE_TEXT = 'private-upstream-content-must-not-escape';
const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4i8AAAAASUVORK5CYII=';
const request: SolveRequest = {
  provider: 'nvidia', model: 'deepseek-ai/deepseek-v4.1-flash', question: {
    source: 'wooclap', eventKey: 'https://app.wooclap.com/event/FIXTURE', questionId: 'fixture',
    text: 'What is six multiplied by seven?', choices: [{ id: 'a', text: '36' }, { id: 'b', text: '42' }], multiple: false, imageKeys: [],
  },
};
const answer: Answer = { selectedChoiceIds: ['b'], explanation: 'Six multiplied by seven is 42.', needsReview: false };
const signal = () => new AbortController().signal;
function responseBody(value: unknown = answer, choice: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    id: 'fixture', object: 'chat.completion', model: request.model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) }, ...choice }],
    usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 }, ...extra,
  };
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
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.referrerPolicy, 'no-referrer');
    assert.equal(init?.cache, 'no-store');
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
function promptSchema(sent: Record<string, any>) {
  const system = sent.messages[0].content as string;
  return JSON.parse(system.slice(system.indexOf('JSON Schema: ') + 'JSON Schema: '.length));
}

test('NVIDIA uses its authenticated Chat Completions contract and a strict schema in the prompt', async () => {
  const transport = fixture(responseBody());
  const result = await createNvidiaSolver(KEY, { fetch: transport.fetch })(request, signal());
  assert.deepEqual(result, { answer, provider: 'nvidia', model: request.model, demo: false, usage: { inputTokens: 20, outputTokens: 30 } });
  assert.equal(transport.calls(), 1);
  assert.equal(transport.url(), 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(transport.headers().get('authorization'), `Bearer ${KEY}`);
  assert.equal(transport.headers().get('content-type'), 'application/json');
  const sent = transport.sent();
  assert.deepEqual(Object.keys(sent).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature', 'top_p']);
  assert.equal(sent.model, request.model);
  assert.equal(sent.max_tokens, 4096);
  assert.equal(sent.temperature, 1);
  assert.equal(sent.top_p, 0.95);
  assert.equal(sent.stream, false);
  assert.equal(promptSchema(sent).additionalProperties, false);
  assert.deepEqual(promptSchema(sent).required.sort(), ['explanation', 'needsReview', 'selectedChoiceIds']);
  assert.equal(sent.messages[0].role, 'system');
  assert.match(sent.messages[0].content, /untrusted data/);
  assert.match(sent.messages[0].content, /Do not add markdown fences/);
  assert.deepEqual(JSON.parse(sent.messages[1].content[0].text), {
    question: request.question.text, kind: 'choice', choices: request.question.choices, multiple: false, imagesRequired: false, screenshotProvided: false,
  });
  assert.ok(!JSON.stringify(sent).includes(KEY));
  assert.ok(!JSON.stringify(sent).includes(request.question.eventKey));
});

test('NVIDIA uses inline image_url parts and avoids requests when required images are missing', async () => {
  const visual: SolveRequest = { ...request, question: { ...request.question, imageKeys: ['diagram'] } };
  const transport = fixture(responseBody());
  const solve = createNvidiaSolver(KEY, { fetch: transport.fetch });
  const missing = await solve(visual, signal());
  assert.equal(missing.answer.needsReview, true);
  assert.equal(missing.usage, null);
  assert.equal(transport.calls(), 0);
  await solve({ ...visual, screenshot }, signal());
  assert.deepEqual(transport.sent().messages[1].content[1], { type: 'image_url', image_url: { url: screenshot } });
});

test('NVIDIA validates all supported question families with the existing answer contracts', async () => {
  const base = request.question;
  const common = { explanation: 'Fixture answer.', needsReview: false };
  const examples: Array<{ question: Question; model: Record<string, unknown>; expected: Partial<Answer> }> = [
    { question: { ...base, kind: 'choice' }, model: { selectedChoiceIds: ['b'] }, expected: { selectedChoiceIds: ['b'] } },
    { question: { ...base, kind: 'sorting' }, model: { selectedChoiceIds: ['a', 'b'] }, expected: { selectedChoiceIds: ['a', 'b'] } },
    { question: { ...base, kind: 'scenario' }, model: { selectedChoiceIds: ['a'] }, expected: { selectedChoiceIds: ['a'] } },
    { question: { ...base, kind: 'numeric', choices: [], constraints: { min: 0, max: 1, step: 0.1 } }, model: { value: '0.3' }, expected: { selectedChoiceIds: [], value: '0.3' } },
    { question: { ...base, kind: 'text', choices: [] }, model: { value: 'Photosynthesis' }, expected: { selectedChoiceIds: [], value: 'Photosynthesis' } },
    { question: { ...base, kind: 'fields', choices: [], fields: [{ id: 'field', label: 'Capital', kind: 'text', required: true }] }, model: { values: [{ id: 'field', value: 'Paris' }] }, expected: { selectedChoiceIds: [], values: [{ id: 'field', value: 'Paris' }] } },
    { question: { ...base, kind: 'matching', choices: [], fields: [{ id: 'field', label: 'Capital', kind: 'select', required: true, options: [{ id: 'paris', text: 'Paris' }] }] }, model: { values: [{ id: 'field', value: 'paris' }] }, expected: { selectedChoiceIds: [], values: [{ id: 'field', value: 'paris' }] } },
    { question: { ...base, kind: 'rating', choices: [], fields: [{ id: 'field', label: 'Rating', kind: 'number', required: true, min: 1, max: 5, step: 1 }] }, model: { values: [{ id: 'field', value: '3' }] }, expected: { selectedChoiceIds: [], values: [{ id: 'field', value: '3' }] } },
    { question: { ...base, kind: 'allocation', choices: [], fields: [{ id: 'field', label: 'Points', kind: 'number', required: true, min: 0, max: 100, step: 1 }], constraints: { total: 100 } }, model: { values: [{ id: 'field', value: '100' }] }, expected: { selectedChoiceIds: [], values: [{ id: 'field', value: '100' }] } },
    { question: { ...base, kind: 'categorized', constraints: { maxEntries: 1 } }, model: { values: [{ id: 'a', value: 'An idea' }] }, expected: { selectedChoiceIds: [], values: [{ id: 'a', value: 'An idea' }] } },
    { question: { ...base, kind: 'point', choices: [base.choices[0]], imageKeys: ['image'] }, model: { points: [{ id: 'a', x: 0.2, y: 0.7 }] }, expected: { selectedChoiceIds: [], points: [{ id: 'a', x: 0.2, y: 0.7 }] } },
    { question: { ...base, kind: 'placements', imageKeys: ['image'] }, model: { points: [{ id: 'a', x: 0.2, y: 0.7 }, { id: 'b', x: 0.5, y: 0.5 }] }, expected: { selectedChoiceIds: [], points: [{ id: 'a', x: 0.2, y: 0.7 }, { id: 'b', x: 0.5, y: 0.5 }] } },
  ];
  for (const entry of examples) {
    const transport = fixture(responseBody({ ...common, ...entry.model }));
    const result = await createNvidiaSolver(KEY, { fetch: transport.fetch })({ ...request, question: entry.question, ...(entry.question.imageKeys.length ? { screenshot } : {}) }, signal());
    assert.deepEqual(result.answer, { ...common, ...entry.expected }, entry.question.kind);
    assert.deepEqual(Object.keys(promptSchema(transport.sent()).properties).sort(), Object.keys({ ...common, ...entry.model }).sort());
    assert.match(transport.sent().messages[0].content, /personal preferences/);
    assert.equal(JSON.parse(transport.sent().messages[1].content[0].text).kind, entry.question.kind);
  }
});

test('NVIDIA rejects malformed input and absent credentials before transport', async () => {
  const transport = fixture(responseBody());
  const solve = createNvidiaSolver(KEY, { fetch: transport.fetch });
  await rejectsCode(solve({ ...request, screenshot: 'https://untrusted.example/image' }, signal()), 'INVALID_QUESTION', 400);
  await rejectsCode(solve({ ...request, model: 'https://untrusted.example' }, signal()), 'INVALID_QUESTION', 400);
  await rejectsCode(createNvidiaSolver('', { fetch: transport.fetch })(request, signal()), 'API_AUTH', 503);
  assert.equal(transport.calls(), 0);
});

test('NVIDIA rejects answers outside the question schema and never repairs JSON', async () => {
  for (const invalid of [
    { ...answer, selectedChoiceIds: ['unknown'] }, { ...answer, selectedChoiceIds: ['a', 'b'] },
    { ...answer, selectedChoiceIds: ['b', 'b'] }, { ...answer, selectedChoiceIds: [] },
    { ...answer, explanation: 'x'.repeat(4001) }, { ...answer, apiKey: KEY }, { selectedChoiceIds: ['b'] },
  ]) await rejectsCode(createNvidiaSolver(KEY, { fetch: fixture(responseBody(invalid)).fetch })(request, signal()), 'API_INVALID_ANSWER', 422);
  for (const content of [PRIVATE_TEXT, `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``, `Answer: ${JSON.stringify(answer)}`, JSON.stringify(answer).slice(0, -1), `<think>${PRIVATE_TEXT}</think>${JSON.stringify(answer)}`]) {
    await rejectsCode(createNvidiaSolver(KEY, { fetch: fixture(responseBody(answer, { message: { role: 'assistant', content } })).fetch })(request, signal()), 'API_INVALID_ANSWER', 422);
  }
});

test('NVIDIA rejects refusals, truncation, tools, and multiple completions before using the answer', async () => {
  for (const [finishReason, code] of [['content_filter', 'API_REFUSAL'], ['refusal', 'API_REFUSAL'], ['length', 'API_INCOMPLETE'], ['tool_calls', 'API_INCOMPLETE'], [null, 'API_INCOMPLETE']]) {
    await rejectsCode(createNvidiaSolver(KEY, { fetch: fixture(responseBody(answer, { finish_reason: finishReason })).fetch })(request, signal()), code!, 422);
  }
  for (const [extra, code] of [
    [{ refusal: PRIVATE_TEXT }, 'API_REFUSAL'], [{ tool_calls: [{ id: 'tool' }] }, 'API_INVALID_ANSWER'],
    [{ function_call: { name: 'tool' } }, 'API_INVALID_ANSWER'], [{ content: null }, 'API_INVALID_ANSWER'],
    [{ role: 'user' }, 'API_INVALID_ANSWER'],
  ] as const) {
    await rejectsCode(createNvidiaSolver(KEY, { fetch: fixture(responseBody(answer, { message: { role: 'assistant', content: JSON.stringify(answer), ...extra } })).fetch })(request, signal()), code, 422);
  }
  for (const choices of [[], [...responseBody().choices, ...responseBody().choices]]) {
    await rejectsCode(createNvidiaSolver(KEY, { fetch: fixture(responseBody(answer, {}, { choices })).fetch })(request, signal()), 'API_INVALID_ANSWER', 422);
  }
});

test('NVIDIA ignores separate reasoning and discards invalid usage without inventing counts', async () => {
  const body = responseBody(answer, { message: { role: 'assistant', content: JSON.stringify(answer), reasoning_content: PRIVATE_TEXT } }, { usage: { prompt_tokens: -1, completion_tokens: KEY } });
  const result = await createNvidiaSolver(KEY, { fetch: fixture(body).fetch })(request, signal());
  assert.equal(result.usage, null);
  assert.deepEqual(result.answer, answer);
  assert.ok(!JSON.stringify(result).includes(PRIVATE_TEXT));
});

test('NVIDIA HTTP failures are sanitized and never retried', async () => {
  for (const [status, code] of [
    [401, 'API_AUTH'], [402, 'API_QUOTA'], [403, 'API_ACCESS_DENIED'], [404, 'API_MODEL_UNAVAILABLE'],
    [408, 'API_TIMEOUT'], [429, 'API_RATE_LIMIT'], [400, 'API_REQUEST_REJECTED'], [422, 'API_REQUEST_REJECTED'], [503, 'API_UNAVAILABLE'],
  ] as const) {
    const transport = fixture({ error: { message: `${PRIVATE_TEXT} ${KEY}` } }, status);
    await rejectsCode(createNvidiaSolver(KEY, { fetch: transport.fetch })(request, signal()), code);
    assert.equal(transport.calls(), 1);
  }
  await rejectsCode(createNvidiaSolver(KEY, { fetch: async () => { throw new TypeError(`${KEY} ${PRIVATE_TEXT}`); } })(request, signal()), 'API_NETWORK', 502);
  await rejectsCode(createNvidiaSolver(KEY, { fetch: async () => { throw new Error(`${KEY} ${PRIVATE_TEXT}`); } })(request, signal()), 'API_REQUEST_FAILED', 502);
});

test('NVIDIA deadline covers fetch and stalled response bodies even if abort is ignored', { timeout: 5000 }, async () => {
  const stalledFetch: typeof globalThis.fetch = async () => new Promise(() => {});
  await rejectsCode(createNvidiaSolver(KEY, { fetch: stalledFetch, timeoutMs: 20 })(request, signal()), 'API_TIMEOUT', 504);
  const stalledBody: typeof globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }));
  await rejectsCode(createNvidiaSolver(KEY, { fetch: stalledBody, timeoutMs: 20 })(request, signal()), 'API_TIMEOUT', 504);
});

test('NVIDIA caller cancellation rejects promptly and discards a late successful response', async () => {
  let finish!: (response: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController();
  const pending = createNvidiaSolver(KEY, { fetch: async () => new Promise(resolve => { finish = resolve; entered(); }) })(request, controller.signal);
  await started;
  controller.abort();
  await rejectsCode(pending, 'API_CANCELLED', 499);
  finish(Response.json(responseBody()));
  const transport = fixture(responseBody());
  await rejectsCode(createNvidiaSolver(KEY, { fetch: transport.fetch })(request, controller.signal), 'API_CANCELLED', 499);
  assert.equal(transport.calls(), 0);
});
