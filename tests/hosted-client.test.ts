import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostedSolver, hostedHealth } from '../src/ai/hosted';
import { hostedBaseUrl } from '../src/shared/hosted-config';
import { normalizeSettings } from '../src/shared/core';
import { PROVIDER_MODELS, type SolveRequest } from '../src/shared/types';

const url = 'https://fallback.example';
const request: SolveRequest = { provider: 'nvidia', model: PROVIDER_MODELS.nvidia,
  question: { source: 'wooclap', eventKey: 'private-event-url', questionId: 'private-id', text: 'Which?', multiple: false,
    choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], imageKeys: [] } };
const result = { provider: 'nvidia', model: PROVIDER_MODELS.nvidia, demo: false,
  answer: { selectedChoiceIds: ['a'], explanation: 'A.', needsReview: false }, usage: { inputTokens: 20, outputTokens: 10 } };
const signal = () => new AbortController().signal;

test('NVIDIA default and namespaced model preserve legacy selections and reject URLs as models', () => {
  assert.equal(normalizeSettings({}).provider, 'nvidia');
  assert.equal(normalizeSettings({}).model, PROVIDER_MODELS.nvidia);
  assert.equal(normalizeSettings({ model: 'gpt-4.1-mini' }).provider, 'openai');
  assert.equal(normalizeSettings({ provider: 'anthropic' }).provider, 'anthropic');
  for (const model of ['https://example.com', '../model', 'x/y/z', 'a/'.repeat(30)]) assert.throws(() => normalizeSettings({ model }));
  assert.equal(hostedBaseUrl(url + '/'), url);
  for (const invalid of ['http://fallback.example', 'https://user:secret@fallback.example', url + '/path', url + '?key=secret', 'https://127.0.0.1', 'https://localhost', 'https://test.localhost', url + ':8443']) assert.throws(() => hostedBaseUrl(invalid));
});

test('hosted health never claims a missing endpoint or mismatched service is ready', async () => {
  assert.equal((await hostedHealth({ url: '' })).ready, false);
  const health = { ready: true, demo: false, provider: 'nvidia', model: PROVIDER_MODELS.nvidia, protocolVersion: 2 };
  assert.equal((await hostedHealth({ url, fetch: async () => Response.json(health) })).connectionMode, 'hosted');
  for (const invalid of [{ ...health, provider: 'openai' }, { ...health, protocolVersion: 1 }, { ...health, demo: true }]) {
    await assert.rejects(hostedHealth({ url, fetch: async () => Response.json(invalid) }), /versions do not match/);
  }
});

test('shared requests pin the service and model, omit all credentials, and minimize event identifiers', async () => {
  let calls = 0;
  const solver = createHostedSolver({ url, fetch: async (input, init) => {
    calls++;
    assert.equal(input, url + '/solve'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store'); assert.equal(init?.referrerPolicy, 'no-referrer');
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('authorization'), false); assert.equal(headers.has('cookie'), false);
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, PROVIDER_MODELS.nvidia); assert.equal(payload.provider, 'nvidia');
    assert.equal(payload.question.questionId, null); assert.equal(payload.question.eventKey, 'shared-fallback');
    assert.ok(!String(init?.body).includes('private-'));
    return Response.json({ ...result, ignoredExtra: 'upstream-metadata' });
  } });
  assert.deepEqual(await solver(request, signal()), result);
  await assert.rejects(solver({ ...request, apiKey: 'test-personal-key' } as any, signal()), /format is invalid/);
  assert.equal(calls, 1);
});

test('shared transport rejects provider mismatches, invalid answers, errors and oversized bodies without leaking upstream text', async () => {
  for (const invalid of [{ ...result, provider: 'openai' }, { ...result, model: 'other' }, { ...result, demo: true }, { ...result, answer: { ...result.answer, selectedChoiceIds: ['unknown'] } }]) {
    await assert.rejects(createHostedSolver({ url, fetch: async () => Response.json(invalid) })(request, signal()), /did not match/);
  }
  for (const status of [401, 403, 429, 503]) {
    await assert.rejects(createHostedSolver({ url, fetch: async () => new Response('private-upstream-body', { status }) })(request, signal()), error => {
      assert.ok(error instanceof Error && !error.message.includes('private-upstream-body')); return true;
    });
  }
  await assert.rejects(createHostedSolver({ url, fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) })(request, signal()), /valid response/);
});

test('hosted deadlines cover stalled bodies, and caller cancellation cannot return a late answer', async () => {
  await assert.rejects(createHostedSolver({ url, timeoutMs: 5, fetch: async () => new Response(new ReadableStream({ start() {} })) })(request, signal()), /timed out/);
  const controller = new AbortController();
  const solver = createHostedSolver({ url, fetch: async () => { controller.abort(); return Response.json(result); } });
  await assert.rejects(solver(request, controller.signal), /cancelled/);
});
