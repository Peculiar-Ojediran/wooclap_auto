import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { Solver } from '../src/ai/solver.js';
import type { Answer, SolveRequest } from '../src/shared/types.js';

const key = 'fixture-browser-api-key-never-sent-over-network';
const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4i8AAAAASUVORK5CYII=';
const answer: Answer = { selectedChoiceIds: ['yes'], explanation: 'Fixture answer.', needsReview: false };
const request: SolveRequest = {
  model: 'gpt-4.1-mini', question: {
    source: 'wooclap', eventKey: 'event-fixture', questionId: 'question-fixture',
    text: 'Is 6 times 7 equal to 42?', choices: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }],
    multiple: false, imageKeys: ['image-fixture'],
  }, screenshot,
};

type BrowserOptions = { allowBrowser?: boolean; timeoutMs?: number };
interface BrowserAI {
  createOpenAISolver: (key: string, options?: BrowserOptions) => Solver;
  createAnthropicSolver: (key: string, options?: BrowserOptions) => Solver;
  demoSolver: Solver;
  validScreenshot: (screenshot: string) => boolean;
}

// Execute the actual browser bundle without Node globals. Every HTTP response is
// injected, so these tests cannot incur charges or access local .env credentials.
let bundle: Promise<string> | undefined;
async function browserRuntime(transport: typeof globalThis.fetch): Promise<BrowserAI> {
  bundle ??= build({
    stdin: {
      contents: "export {createOpenAISolver, demoSolver} from './src/ai/solver.ts'; export {createAnthropicSolver} from './src/ai/anthropic.ts'; export {validScreenshot} from './src/ai/validation.ts';",
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'BrowserAI', target: 'chrome118',
  }).then(result => result.outputFiles[0].text);
  const context = vm.createContext({
    Headers, Request, Response, AbortController, AbortSignal, DOMException,
    URL, URLSearchParams, FormData, Blob, File, ReadableStream, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, atob, btoa, structuredClone, crypto: globalThis.crypto, fetch: transport,
    // Force the SDK's browser detection as well as the browser build conditions.
    window: { document: {} }, document: {}, navigator: { userAgent: 'Edge extension fixture' },
  });
  vm.runInContext(await bundle, context);
  assert.equal(vm.runInContext('typeof Buffer', context), 'undefined');
  assert.equal(vm.runInContext('typeof process', context), 'undefined');
  return context.BrowserAI as BrowserAI;
}

function openAIResponse() {
  return Response.json({
    id: 'fixture', object: 'response', model: request.model, status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(answer), annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

test('OpenAI browser bundle requires explicit browser opt-in and pins authenticated requests', async () => {
  let calls = 0;
  const browser = await browserRuntime(async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.referrerPolicy, 'no-referrer');
    assert.ok(!String(init?.body).includes(key));
    assert.equal(JSON.parse(String(init?.body)).input[0].content[1].image_url, screenshot);
    return openAIResponse();
  });
  assert.throws(() => browser.createOpenAISolver(key), /dangerouslyAllowBrowser/);
  const result = await browser.createOpenAISolver(key, { allowBrowser: true })(request, new AbortController().signal);
  assert.deepEqual(JSON.parse(JSON.stringify(result.answer)), answer);
  assert.equal(calls, 1);
});

test('Claude browser bundle opts into browser access without sending cookies or credentials in prompts', async () => {
  const browser = await browserRuntime(async (url, init) => {
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), key);
    assert.equal(headers.get('anthropic-dangerous-direct-browser-access'), 'true');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.referrerPolicy, 'no-referrer');
    assert.ok(!String(init?.body).includes(key));
    return Response.json({
      type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 10, output_tokens: 5 },
    });
  });
  const result = await browser.createAnthropicSolver(key, { allowBrowser: true })({ ...request, provider: 'anthropic', model: 'claude-sonnet-5-5' }, new AbortController().signal);
  assert.deepEqual(JSON.parse(JSON.stringify(result.answer)), answer);
  assert.equal(result.provider, 'anthropic');
});

test('browser image validation checks canonical base64, signatures, and decoded size without Node Buffer', async () => {
  const browser = await browserRuntime(async () => { throw new Error('No network expected.'); });
  assert.equal(browser.validScreenshot(screenshot), true);
  assert.equal(browser.validScreenshot('data:image/jpeg;base64,/9j/AA=='), true);
  for (const invalid of [
    'data:image/jpeg;base64,/9j/AB==', // Noncanonical padding bits.
    'data:image/png;base64,/9j/AA==', 'data:image/png;base64,aGVsbG8=',
    'data:image/jpeg;base64,/9j/', 'data:image/jpeg;base64,/9j/===',
    'data:image/jpeg;base64,/9j/AA==\n', 'https://example.test/image.png',
    `data:image/png;base64,${btoa('a'.repeat(4 * 1024 * 1024 + 1))}`,
  ]) assert.equal(browser.validScreenshot(invalid), false);
});

test('browser OpenAI deadline and cancellation settle even when fetch ignores abort', async () => {
  const browser = await browserRuntime(async () => new Promise(() => {}));
  await assert.rejects(browser.createOpenAISolver(key, { allowBrowser: true, timeoutMs: 20 })(request, new AbortController().signal), { code: 'API_TIMEOUT' });
  const controller = new AbortController();
  const pending = browser.createOpenAISolver(key, { allowBrowser: true })(request, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'API_CANCELLED' });
});

test('bundled practice solver works offline and refuses real Wooclap input', async () => {
  const browser = await browserRuntime(async () => { throw new Error('No network expected.'); });
  const practice: SolveRequest = {
    model: 'local-demo', question: {
      ...request.question, source: 'practice', questionId: 'math-1', imageKeys: [],
      choices: [{ id: 'math-36', text: '36' }, { id: 'math-42', text: '42' }],
    },
  };
  const result = await browser.demoSolver(practice, new AbortController().signal);
  assert.equal(result.demo, true);
  assert.equal(result.answer.selectedChoiceIds[0], 'math-42');
  await assert.rejects(browser.demoSolver(request, new AbortController().signal), { code: 'DEMO_PRACTICE_ONLY' });
});
