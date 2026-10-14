import assert from 'node:assert/strict';
import test from 'node:test';
import { PersistentBudget, DAY_MS, LEASE_MS, type BudgetState, type BudgetStorage, type Limits } from '../hosted/budget';
import { createHostedHandler, SharedBudget, clientHash, MAX_REQUEST_BYTES, type Env } from '../hosted/worker';
import { PROVIDER_MODELS, type SolveRequest, type SolveResponse } from '../src/shared/types';

const origin = `chrome-extension://${'a'.repeat(32)}`;
const key = 'synthetic-hosted-secret';
const question: SolveRequest = { protocolVersion: 2, provider: 'nvidia', model: PROVIDER_MODELS.nvidia,
  question: { source: 'wooclap', eventKey: 'test', questionId: null, text: '2 + 2?', multiple: false, imageKeys: [], choices: [{ id: 'a', text: '4' }, { id: 'b', text: '5' }] } };
const answer: SolveResponse = { provider: 'nvidia', model: PROVIDER_MODELS.nvidia, demo: false, usage: null,
  answer: { selectedChoiceIds: ['a'], explanation: 'Four.', needsReview: false } };
const limits: Limits = { dailyRequests: 5, dailyInputBytes: 10000, ipPerMinute: 2, ipPerDay: 3, concurrency: 2 };

function storage(): BudgetStorage & { data: Map<string, unknown>; alarm?: number } {
  const data = new Map<string, unknown>();
  let queue = Promise.resolve();
  const result: BudgetStorage & { data: Map<string, unknown>; alarm?: number } = {
    data, get: async <T>(name: string) => structuredClone(data.get(name)) as T | undefined,
    put: async (name, value) => { data.set(name, structuredClone(value)); },
    delete: async name => data.delete(name), setAlarm: async time => { result.alarm = time; },
    transaction: callback => {
      const next = queue.then(() => callback(result));
      queue = next.then(() => undefined, () => undefined);
      return next;
    },
  };
  return result;
}
function fixture(overrides: Partial<Env> = {}) {
  const store = storage();
  const env: Env = { NVIDIA_API_KEY: key, ALLOWED_EXTENSION_IDS: 'a'.repeat(32), ENABLED: 'true', ...overrides };
  const object = new SharedBudget({ storage: store }, env);
  env.SHARED_BUDGET = { idFromName: () => 'one', get: () => ({ fetch: request => object.fetch(request) }) };
  return { env, store };
}
function req(body: unknown = question, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request('https://fallback.example/solve', { method: 'POST', headers: { origin, 'cf-connecting-ip': '192.0.2.1', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
}

test('hosted health reveals readiness but never secrets and fails closed without deployment configuration', async () => {
  const handler = createHostedHandler();
  const publicHealth = await handler(new Request('https://fallback.example/health'), fixture().env);
  assert.equal((await publicHealth.json()).ready, true, 'Edge extension GET requests omit Origin.');
  for (const overrides of [{}, { NVIDIA_API_KEY: '' }, { ENABLED: 'false' }, { DAILY_REQUEST_LIMIT: '501' }]) {
    const { env } = fixture(overrides);
    const result = await handler(new Request('https://fallback.example/health', { headers: { origin } }), env);
    const body = await result.text();
    assert.equal(JSON.parse(body).ready, !Object.keys(overrides).length);
    assert.ok(!body.includes(key));
    assert.equal(result.headers.get('set-cookie'), null);
  }
});

test('hosted service uses only its server secret, strips metadata, and enforces fixed provider/model', async () => {
  const { env, store } = fixture(); let calls = 0;
  const handler = createHostedHandler({ solverFactory: credential => {
    assert.equal(credential, key);
    return async input => { calls++; assert.equal('apiKey' in input, false); return { ...answer, injectedSecret: key } as any; };
  } });
  const result = await handler(req(), env);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('access-control-allow-origin'), origin);
  assert.ok(!(await result.text()).includes(key));
  assert.equal((store.data.get('budget') as BudgetState).requests, 1);
  assert.equal(Object.keys((store.data.get('budget') as BudgetState).leases).length, 0);
  for (const invalid of [{ ...question, apiKey: 'private-user-key' }, { ...question, provider: 'openai' }, { ...question, model: 'other-model' }, { ...question, protocolVersion: 1 }, { ...question, screenshot: 'invalid' }]) {
    assert.equal((await handler(req(invalid), env)).status, 400);
  }
  assert.equal(calls, 1);
});

test('hosted API rejects websites, credentials, cookies, malformed bodies, and oversized uploads before solving', async () => {
  const { env } = fixture(); let calls = 0;
  const handler = createHostedHandler({ solverFactory: () => async () => { calls++; return answer; } });
  for (const headers of [{ origin: 'https://app.wooclap.com' }, { origin: '' }, { authorization: 'Bearer private' }, { cookie: 'session=private' }, { 'content-length': String(MAX_REQUEST_BYTES + 1) }, { 'content-type': 'text/plain' }] as Record<string, string>[]) {
    assert.ok((await handler(req(question, headers), env)).status >= 400);
  }
  const large = new Request(req().url, { method: 'POST', headers: req().headers, body: 'x'.repeat(MAX_REQUEST_BYTES + 1) });
  assert.equal((await handler(large, env)).status, 413);
  const preflight = await handler(new Request(req().url, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type' } }), env);
  assert.equal(preflight.status, 204);
  assert.equal(calls, 0);
});

test('hosted image payloads retain validated inline images and malformed answers never return success', async () => {
  const { env } = fixture(); let screenshot = '';
  const image = { ...question, question: { ...question.question, imageKeys: ['image-1'] }, screenshot: 'data:image/png;base64,iVBORw0KGgo=' };
  const handler = createHostedHandler({ solverFactory: () => async request => { screenshot = request.screenshot!; return answer; } });
  assert.equal((await handler(req(image), env)).status, 200);
  assert.equal(screenshot, image.screenshot);
  for (const invalid of [{ ...answer, provider: 'openai' }, { ...answer, answer: { ...answer.answer, selectedChoiceIds: ['missing'] } }]) {
    const handler = createHostedHandler({ solverFactory: () => async () => invalid as SolveResponse });
    assert.equal((await handler(req(), env)).status, 502);
  }
});

test('hosted errors and deadline never leak server credentials or refund spent allowance', async () => {
  const { env, store } = fixture();
  const handler = createHostedHandler({ solverFactory: () => async () => { throw new Error(key); } });
  const failed = await handler(req(), env);
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes(key));
  let aborted = false;
  const delayed = createHostedHandler({ timeoutMs: 5, solverFactory: () => async (_, signal) => {
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } });
  assert.equal((await delayed(req(), env)).status, 504);
  assert.equal(aborted, true);
  assert.equal((store.data.get('budget') as BudgetState).requests, 2);
  assert.equal(Object.keys((store.data.get('budget') as BudgetState).leases).length, 0);
});

test('hosted client disconnect cancels upstream and daily service quota prevents extra calls', async () => {
  const { env } = fixture({ DAILY_REQUEST_LIMIT: '1' }); let calls = 0;
  const controller = new AbortController();
  const handler = createHostedHandler({ solverFactory: () => async (_, signal) => {
    calls++; controller.abort(); assert.equal(signal.aborted, true); return new Promise(() => {});
  } });
  assert.equal((await handler(req(question, {}, controller.signal), env)).status, 499);
  assert.equal((await handler(req(), env)).status, 429);
  assert.equal(calls, 1);
});

test('persistent budgets atomically cap concurrency, IP windows, bytes, and daily calls across recreation', async () => {
  const store = storage(); const now = DAY_MS + 1000;
  let budget = new PersistentBudget(store, limits);
  const reservations = await Promise.all(Array.from({ length: 5 }, (_, i) => budget.reserve(`client-${i}`, 100, now)));
  assert.equal(reservations.filter(result => result.allowed).length, 2);
  for (const item of reservations) if (item.allowed) await budget.release(item.lease);
  const result = await budget.reserve('client-0', 100, now + 1000);
  assert.equal(result.allowed, true); if (result.allowed) await budget.release(result.lease);
  assert.equal((await budget.reserve('client-0', 100, now + 2000)).allowed, false);
  budget = new PersistentBudget(store, limits);
  const later = await budget.reserve('client-0', 100, now + 61_000);
  assert.equal(later.allowed, true); if (later.allowed) await budget.release(later.lease);
  assert.equal((await budget.reserve('client-0', 100, now + 122_000)).allowed, false);
  assert.equal((await budget.reserve('client-x', 10_000, now + 122_000)).allowed, false);
  const last = await budget.reserve('client-y', 100, now + 122_000);
  assert.equal(last.allowed, true);
  assert.equal((await budget.reserve('client-z', 100, now + 123_000)).allowed, false);
  assert.equal((await budget.reserve('new-day', 100, now + DAY_MS)).allowed, true);
});

test('leases expire without refunding budgets, daily hashes rotate, and alarms remove stale client metadata', async () => {
  const store = storage(); const now = DAY_MS + 1000;
  const budget = new PersistentBudget(store, { ...limits, concurrency: 1 });
  assert.equal((await budget.reserve('first', 100, now)).allowed, true);
  assert.equal((await budget.reserve('second', 100, now + LEASE_MS + 1)).allowed, true);
  assert.equal((store.data.get('budget') as BudgetState).requests, 2);
  await budget.expire(3 * DAY_MS);
  assert.equal(store.data.has('budget'), false);
  const first = await clientHash(key, '192.0.2.1', now);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, await clientHash(key, '192.0.2.1', now + 1));
  assert.notEqual(first, await clientHash(key, '192.0.2.1', now + DAY_MS));
});
