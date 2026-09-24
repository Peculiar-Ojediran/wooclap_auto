import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createBridgeServer, type BridgeOptions } from '../server/http.js';
import type { Solver } from '../server/solver.js';
import type { SolveRequest, SolveResponse } from '../src/shared/types.js';

const TOKEN = 'test-token-used-only-in-this-test-suite-123456';
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const question: SolveRequest = {
  question: {
    source: 'practice', eventKey: 'http://127.0.0.1:4318/practice', questionId: 'math-1',
    text: 'What is 6 × 7?', choices: [{ id: 'math-36', text: '36' }, { id: 'math-42', text: '42' }, { id: 'math-48', text: '48' }],
    multiple: false, imageKeys: [],
  },
  model: 'gpt-4.1-mini',
};
const answer: SolveResponse = {
  answer: { selectedChoiceIds: ['math-42'], explanation: '6 × 7 = 42.', needsReview: false },
  model: 'test-model', usage: null, demo: false,
};
const solver: Solver = async () => structuredClone(answer);

async function bridge(t: TestContext, options: Partial<BridgeOptions> = {}) {
  const server = createBridgeServer({ token: TOKEN, solver, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    get: (path: string, headers: Record<string, string> = {}) => fetch(url + path, { headers: { Authorization: `Bearer ${TOKEN}`, ...headers } }),
    post: (body: unknown = question, headers: Record<string, string> = {}) => fetch(url + '/solve', {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    }),
  };
}

test('health and solve require the pairing token, including when no Origin is sent', async t => {
  const app = await bridge(t);
  assert.equal((await app.get('/health', { Authorization: '' })).status, 401);
  assert.equal((await app.post(question, { Authorization: 'Bearer wrong-token' })).status, 401);
  const response = await app.get('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true, demo: false, model: 'gpt-4.1-mini', protocolVersion: 2 });
});

test('rejects remote origins and DNS-rebinding Host values', async t => {
  let called = 0;
  const app = await bridge(t, { solver: async () => { called++; return answer; } });
  for (const origin of ['https://www.wooclap.com', 'http://127.0.0.1:4318', 'null', 'chrome-extension://not-an-id']) {
    const response = await app.post(question, { Origin: origin });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const raw = request(app.url + '/health', { headers: { Host: 'attacker.example', Authorization: `Bearer ${TOKEN}` } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    raw.on('error', reject);
    raw.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal(called, 0);
});

test('permits authenticated extension requests with explicit CORS and bounded preflight headers', async t => {
  const app = await bridge(t);
  const response = await app.post(question, { Origin: ORIGIN });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.deepEqual(await response.json(), answer);
  const preflight = await fetch(app.url + '/solve', {
    method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' },
  });
  assert.equal(preflight.status, 204);
  const invalid = await fetch(app.url + '/solve', {
    method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'x-unexpected' },
  });
  assert.equal(invalid.status, 403);
});

test('validates JSON, content type, unique choice IDs, and model before calling the solver', async t => {
  let called = 0;
  const app = await bridge(t, { solver: async () => { called++; return answer; } });
  assert.equal((await app.post(question, { 'Content-Type': 'text/plain' })).status, 415);
  const malformed = await fetch(app.url + '/solve', {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{broken',
  });
  assert.equal(malformed.status, 400);
  const duplicated = structuredClone(question);
  duplicated.question.choices[1].id = duplicated.question.choices[0].id;
  assert.equal((await app.post(duplicated)).status, 400);
  assert.equal((await app.post({ ...question, model: 'https://untrusted.example' })).status, 400);
  assert.equal((await app.post({ ...question, screenshot: 'data:image/png;base64,bm90LWFuLWltYWdl' })).status, 400);
  assert.equal(called, 0);
});

test('rejects oversized bodies before making AI calls', async t => {
  let called = 0;
  const app = await bridge(t, { solver: async () => { called++; return answer; } });
  const response = await app.post({ ...question, screenshot: 'x'.repeat(6 * 1024 * 1024 + 1) });
  assert.equal(response.status, 413);
  assert.equal(called, 0);
});

test('unknown or duplicate selected IDs and invalid single-choice cardinality cannot reach the extension', async t => {
  let selected = ['unknown'];
  const app = await bridge(t, { solver: async () => ({ ...answer, answer: { ...answer.answer, selectedChoiceIds: selected } }) });
  for (const ids of [['unknown'], ['math-42', 'math-42'], ['math-36', 'math-42'], []]) {
    selected = ids;
    const response = await app.post();
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'INVALID_ANSWER');
  }
});

test('an explicitly unresolved answer can be returned for manual review', async t => {
  const app = await bridge(t, { solver: async () => ({ ...answer, answer: { selectedChoiceIds: [], explanation: 'Missing diagram.', needsReview: true } }) });
  const response = await app.post();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).answer.needsReview, true);
});

test('allows only one active question and enforces the local request budget', async t => {
  let unblock!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { unblock = resolve; });
  const app = await bridge(t, { rateLimit: 1, solver: async () => { entered(); await waiting; return answer; } });
  const first = app.post();
  await started;
  assert.equal((await app.post()).status, 409);
  unblock();
  assert.equal((await first).status, 200);
  assert.equal((await app.post()).status, 429);
});

test('sanitizes upstream failures without returning secrets or falling back to demo answers', async t => {
  const secret = 'sk-secret-upstream-key';
  const app = await bridge(t, { solver: async () => { throw new Error(`${secret}: request body and private question`); } });
  const response = await app.post();
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.ok(!body.includes(secret));
  assert.ok(!body.includes('private question'));
  assert.ok(!body.includes('selectedChoiceIds'));
});

test('a disconnected extension cancels its upstream AI request', { timeout: 5_000 }, async t => {
  let entered!: () => void;
  let cancelled!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const aborted = new Promise<void>(resolve => { cancelled = resolve; });
  const app = await bridge(t, { solver: async (_request, signal) => {
    signal.addEventListener('abort', cancelled, { once: true });
    entered();
    await aborted;
    throw new Error('Aborted upstream work');
  } });
  const controller = new AbortController();
  const pending = fetch(app.url + '/solve', {
    method: 'POST', signal: controller.signal,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(question),
  });
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await aborted;
});

test('demo returns bundled practice answers and refuses live or unknown questions', async t => {
  const app = await bridge(t, { demo: true, solver: undefined });
  const response = await app.post();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.answer.selectedChoiceIds, ['math-42']);
  assert.equal(result.demo, true);
  assert.equal(result.model, 'local-demo');
  const live = structuredClone(question);
  live.question.source = 'wooclap';
  assert.equal((await app.post(live)).status, 422);
  const unknown = structuredClone(question);
  unknown.question.questionId = 'unrecognized-1';
  assert.equal((await app.post(unknown)).status, 422);
});

test('missing API credentials keep health readable but prevent solving', async t => {
  const app = await bridge(t, { solver: undefined });
  assert.equal((await (await app.get('/health')).json()).ready, false);
  const response = await app.post();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'API_KEY_REQUIRED');
});
