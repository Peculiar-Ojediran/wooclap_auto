import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const directory = await mkdtemp(join(tmpdir(), 'wooclap-hosted-runtime-'));
const model = 'deepseek-ai/deepseek-v4.1-flash';
const origin = `chrome-extension://${'a'.repeat(32)}`;
const key = 'test-only-server-key';
let calls = 0;
let runtime;
const options = {
  modules: true, scriptPath: fileURLToPath(new URL('./build/index.js', import.meta.url)),
  compatibilityDate: '2026-10-01',
  durableObjects: { SHARED_BUDGET: { className: 'SharedBudget', useSQLite: true } },
  bindings: { NVIDIA_API_KEY: key, ALLOWED_EXTENSION_IDS: 'a'.repeat(32), ENABLED: 'true', DAILY_REQUEST_LIMIT: '2' },
  outboundService: async request => {
    calls++;
    assert.equal(request.url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(request.headers.get('authorization') === `Bearer ${key}`, true);
    const body = await request.json();
    assert.equal(body.model, model);
    assert.ok(!JSON.stringify(body).includes(key));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ selectedChoiceIds: ['a'], explanation: 'Four.', needsReview: false }) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  },
};
const payload = { protocolVersion: 2, provider: 'nvidia', model, question: {
  source: 'wooclap', eventKey: 'shared-fallback', questionId: null, text: '2 + 2?', multiple: false, imageKeys: [],
  choices: [{ id: 'a', text: '4' }, { id: 'b', text: '5' }],
} };
const solve = () => runtime.dispatchFetch('https://fallback.example/solve', { method: 'POST',
  headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify(payload) });
try {
  const converted = { ...convertV4MiniflareOptions({ workers: [{ name: 'hosted-test', ...options }] }), resourcePersistencePath: directory, telemetry: { enabled: false } };
  runtime = new Miniflare(converted);
  const health = await runtime.dispatchFetch('https://fallback.example/health', { headers: { origin } });
  assert.equal((await health.json()).ready, true);
  const first = await solve();
  assert.equal(first.status, 200, JSON.stringify({body:await first.clone().text(),mockCalls:calls}));
  assert.deepEqual((await first.json()).answer.selectedChoiceIds, ['a']);
  await runtime.dispose();
  runtime = new Miniflare(converted);
  assert.equal((await solve()).status, 200);
  assert.equal((await solve()).status, 429);
  assert.equal(calls, 2);
  console.log('PASS: Workers runtime routes NVIDIA answers; Durable Object quota survives restart; two mocked upstream calls, zero real calls.');
} finally {
  await runtime?.dispose();
  const absolute = resolve(directory);
  if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('wooclap-hosted-runtime-')) await rm(absolute, { recursive: true, force: true });
}
