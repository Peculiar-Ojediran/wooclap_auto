import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createOpenAISolver, SolveError } from '../server/solver';
import type { SolveRequest } from '../src/shared/types';

const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini';
if (!apiKey) {
  console.error('OPENAI_API_KEY is missing. Add it to the local .env file; never put it in extension settings.');
  process.exitCode = 1;
} else {
  const base = { source: 'practice' as const, eventKey: 'local-api-verification', questionId: 'verification', multiple: false, imageKeys: [] as string[] };
  const cases: { name: string; request: SolveRequest; expected: string[] }[] = [
    { name: 'single-choice', request: { model, question: { ...base, text: 'What is 6 multiplied by 7?', choices: [{ id: 'a', text: '36' }, { id: 'b', text: '42' }, { id: 'c', text: '48' }] } }, expected: ['b'] },
    { name: 'multiple-answer', request: { model, question: { ...base, text: 'Which numbers are prime? Select every correct answer.', multiple: true, choices: [{ id: 'a', text: '2' }, { id: 'b', text: '4' }, { id: 'c', text: '5' }, { id: 'd', text: '9' }] } }, expected: ['a', 'c'] }
  ];
  const results: object[] = [];
  try {
    // This is an intentionally opt-in paid test: at most three requests, no retries.
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 260 } });
      await page.setContent('<html><body style="margin:0;background:white"><svg width="360" height="260" viewBox="0 0 360 260"><path d="M180 25 L325 230 L35 230 Z" fill="#4285d4"/></svg></body></html>');
      const screenshot = 'data:image/png;base64,' + (await page.screenshot()).toString('base64');
      cases.push({ name: 'image-question', request: { model, screenshot, question: { ...base, text: 'How many sides does the blue polygon in the image have?', imageKeys: ['verification-polygon'], choices: [{ id: 'a', text: '3' }, { id: 'b', text: '4' }, { id: 'c', text: '5' }] } }, expected: ['a'] });
    } finally { await browser.close(); }
    const solve = createOpenAISolver(apiKey);
    for (const fixture of cases) {
      const startedAt = Date.now();
      const result = await solve(fixture.request, AbortSignal.timeout(28_000));
      const elapsedMs = Date.now() - startedAt;
      const passed = !result.demo && !result.answer.needsReview && JSON.stringify([...result.answer.selectedChoiceIds].sort()) === JSON.stringify([...fixture.expected].sort());
      results.push({ name: fixture.name, passed, model: result.model, elapsedMs, usage: result.usage, selectedChoiceIds: result.answer.selectedChoiceIds, needsReview: result.answer.needsReview });
      console.log(`${passed ? 'PASS' : 'FAIL'}: ${fixture.name}, ${result.model}, ${elapsedMs} ms, ${result.usage?.inputTokens ?? '?'} input / ${result.usage?.outputTokens ?? '?'} output tokens`);
      assert.equal(passed, true, `The actual model answer failed the ${fixture.name} fixture.`);
    }
  } catch (error) {
    const message = error instanceof SolveError ? error.message : 'The real API smoke test did not complete. Check the local API configuration and Microsoft Edge installation.';
    const code = error instanceof SolveError ? error.code : 'VERIFICATION_FAILED';
    results.push({ passed: false, code, message });
    console.error(`${code}: ${message}`);
    process.exitCode = 1;
  } finally {
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/openai-smoke.json', JSON.stringify({ timestamp: new Date().toISOString(), model, maxRequests: 3, results }, null, 2) + '\n');
  }
}
