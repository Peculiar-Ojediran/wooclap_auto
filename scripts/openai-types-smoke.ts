import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createOpenAISolver, SolveError } from '../server/solver';
import { PROTOCOL_VERSION, type Answer, type SolveRequest } from '../src/shared/types';

const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini';
const results: object[] = [];
const base = { source: 'practice' as const, eventKey: 'local-types-verification', questionId: 'verification', choices: [], multiple: false, imageKeys: [] as string[] };
const cases: { name: string; request: SolveRequest; check: (answer: Answer) => boolean }[] = [
  { name: 'numeric-schema', request: { protocolVersion: PROTOCOL_VERSION, model, question: { ...base, kind: 'numeric', text: 'What is 6 multiplied by 7?', constraints: { min: 0, max: 100 } } }, check: a => a.value === '42' },
  { name: 'matching-schema', request: { protocolVersion: PROTOCOL_VERSION, model, question: { ...base, kind: 'matching', text: 'Match each country to its capital.', constraints: { uniqueTargets: true },
    fields: ['France', 'Italy'].map((country, index) => ({ id: `country-${index}`, label: country, kind: 'select' as const, required: true,
      options: [{ id: 'paris', text: 'Paris' }, { id: 'rome', text: 'Rome' }] })) } }, check: a => a.values?.find(v => v.id === 'country-0')?.value === 'paris' && a.values?.find(v => v.id === 'country-1')?.value === 'rome' },
];

try {
  if (!apiKey) throw new Error('API key missing');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 240 } });
    await page.setContent('<body style="margin:0"><svg width="400" height="240"><rect width="400" height="240" fill="white"/><circle cx="300" cy="60" r="30" fill="red"/><rect x="40" y="130" width="80" height="70" fill="blue"/></svg></body>');
    const screenshot = 'data:image/png;base64,' + (await page.screenshot()).toString('base64');
    cases.push({ name: 'image-point-schema', request: { protocolVersion: PROTOCOL_VERSION, model, screenshot, question: { ...base, kind: 'point',
      text: 'Find the center of the red circle. Return normalized coordinates relative to the entire 400 by 240 image, with x from left and y from top.',
      choices: [{ id: 'point-1', text: 'Center of red circle' }], imageKeys: ['test-shapes'], application: 'preview' } },
      check: a => Boolean(a.points?.length === 1 && Math.abs(a.points[0].x - 0.75) < 0.08 && Math.abs(a.points[0].y - 0.25) < 0.08) });
  } finally { await browser.close(); }
  const solve = createOpenAISolver(apiKey);
  // Explicit paid command: at most three calls, never retries.
  for (const fixture of cases) {
    const started = Date.now();
    const response = await solve(fixture.request, AbortSignal.timeout(28_000));
    const passed = !response.demo && !response.answer.needsReview && fixture.check(response.answer);
    const elapsedMs = Date.now() - started;
    results.push({ name: fixture.name, passed, model: response.model, usage: response.usage, elapsedMs });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${fixture.name}, ${elapsedMs} ms, ${response.usage?.inputTokens ?? '?'} input / ${response.usage?.outputTokens ?? '?'} output tokens`);
    assert.ok(passed, fixture.name);
  }
} catch (error) {
  const message = error instanceof SolveError ? error.message : 'The new-type API verification did not complete. Check configuration and the report.';
  results.push({ passed: false, message });
  console.error(message); process.exitCode = 1;
} finally {
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/openai-types.json', JSON.stringify({ timestamp: new Date().toISOString(), maxRequests: 3, model, results }, null, 2));
}
