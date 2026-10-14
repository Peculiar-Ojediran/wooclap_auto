import { z } from 'zod';
import { answerInstructions, outputBudget, questionPrompt, SolveError, type Solver } from './solver.js';
import { modelAnswerSchema, normalizeModelAnswer, solveRequestSchema, validAnswer, validScreenshot } from './validation.js';

export interface AnthropicSolverOptions {
  /** Enable only inside the trusted extension background worker, never a page. */
  allowBrowser?: boolean;
  /** Fixture transport; production always uses the fixed Anthropic endpoint. */
  fetch?: typeof globalThis.fetch;
  /** May shorten, but never extend, the full 25-second request deadline. */
  timeoutMs?: number;
}

const errors = {
  API_AUTH: [503, 'Claude rejected the API key. Update it in extension settings. If using the optional local bridge, check ANTHROPIC_API_KEY and restart it.'],
  API_ACCESS_DENIED: [403, 'The Claude API key cannot access this model or workspace. Check its permissions and the selected model.'],
  API_QUOTA: [429, 'Claude API credits or spending limits prevent this request. Check the Anthropic account billing before trying again.'],
  API_RATE_LIMIT: [429, 'Claude is rate limiting requests. Wait before trying this question again.'],
  API_MODEL_UNAVAILABLE: [422, 'The selected Claude model is unavailable to this API key. Choose an accessible model in extension settings.'],
  API_NETWORK: [502, 'Could not reach Claude. Check the network connection before trying again.'],
  API_TIMEOUT: [504, 'Claude did not finish within the request deadline. No answer was submitted; review the question before trying again.'],
  API_CANCELLED: [499, 'The AI request was cancelled. No answer from this request will be used.'],
  API_REFUSAL: [422, 'The model declined to answer this question. Review it manually.'],
  API_INCOMPLETE: [422, 'The model did not finish a complete answer. Review this question manually.'],
  API_INVALID_ANSWER: [422, 'The AI answer did not match the required format or current choices. Review this question manually.'],
  API_UNAVAILABLE: [503, 'Claude is temporarily unavailable. Wait before trying this question again.'],
  API_REQUEST_REJECTED: [422, 'Claude rejected the question request. Check API credits, the selected model, its structured-output support, and the question content before trying again.'],
  API_REQUEST_FAILED: [502, 'The AI request failed. Review this question and check the provider settings before trying again.'],
} as const;

function apiError(code: keyof typeof errors): SolveError {
  const [status, message] = errors[code];
  return new SolveError(code, status, message);
}

function upstreamError(status: number): SolveError {
  if (status === 401) return apiError('API_AUTH');
  if (status === 402) return apiError('API_QUOTA');
  if (status === 403) return apiError('API_ACCESS_DENIED');
  if (status === 404) return apiError('API_MODEL_UNAVAILABLE');
  if (status === 408) return apiError('API_TIMEOUT');
  if (status === 429) return apiError('API_RATE_LIMIT');
  if (status >= 500) return apiError('API_UNAVAILABLE');
  return apiError('API_REQUEST_REJECTED');
}

const responseSchema = z.object({
  type: z.literal('message'), role: z.literal('assistant'), stop_reason: z.string().nullable(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.unknown().optional(),
});
const usageSchema = z.object({ input_tokens: z.number().int().nonnegative().safe(), output_tokens: z.number().int().nonnegative().safe() });

/** Messages API with JSON structured outputs; keys never enter the model prompt. */
export function createAnthropicSolver(apiKey: string, options: AnthropicSolverOptions = {}): Solver {
  const transport = options.fetch ?? globalThis.fetch;
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 25_000, 25_000));
  return async (request, signal) => {
    if (signal.aborted) throw apiError('API_CANCELLED');
    const parsed = solveRequestSchema.safeParse(request);
    if (!parsed.success || (parsed.data.screenshot && !validScreenshot(parsed.data.screenshot))) {
      throw new SolveError('INVALID_QUESTION', 400, 'The question, choices, model, or screenshot format is invalid.');
    }
    request = parsed.data;
    if (request.question.imageKeys.length && !request.screenshot) {
      return {
        answer: { selectedChoiceIds: [], explanation: 'This question includes an image. Enable image capture and keep the complete question visible, or answer it manually.', needsReview: true },
        provider: 'anthropic', model: request.model, usage: null, demo: false,
      };
    }
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: questionPrompt(request) }];
    if (request.screenshot) {
      const [header, data] = request.screenshot.split(',');
      content.push({ type: 'image', source: { type: 'base64', media_type: header.slice(5, -7), data } });
    }
    const schema = z.toJSONSchema(modelAnswerSchema(request.question), { target: 'draft-7' });
    delete schema.$schema;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const combined = AbortSignal.any([signal, deadline.signal]);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(apiError(signal.aborted ? 'API_CANCELLED' : 'API_TIMEOUT'));
      combined.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const operation = async () => {
        const response = await transport('https://api.anthropic.com/v1/messages', {
          method: 'POST', redirect: 'error', signal: combined, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
          headers: {
            'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
            ...(options.allowBrowser ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
          },
          body: JSON.stringify({
            model: request.model, max_tokens: outputBudget(request.question), system: answerInstructions(request.question),
            messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema } },
          }),
        });
        if (!response.ok) {
          // Discard arbitrary provider text: it can contain private inputs or keys.
          await response.body?.cancel();
          throw upstreamError(response.status);
        }
        const payload: unknown = await response.json();
        if (signal.aborted) throw apiError('API_CANCELLED');
        if (deadline.signal.aborted) throw apiError('API_TIMEOUT');
        const parsedResponse = responseSchema.safeParse(payload);
        if (!parsedResponse.success) throw apiError('API_INVALID_ANSWER');
        const result = parsedResponse.data;
        if (result.stop_reason === 'refusal' || result.content.some(block => block.type === 'refusal')) throw apiError('API_REFUSAL');
        if (result.stop_reason !== 'end_turn') throw apiError('API_INCOMPLETE');
        const texts = result.content.filter(block => block.type === 'text');
        if (texts.length !== 1 || typeof texts[0].text !== 'string'
          || result.content.some(block => !['text', 'thinking', 'redacted_thinking'].includes(block.type))) throw apiError('API_INVALID_ANSWER');
        const answer = normalizeModelAnswer(request.question, JSON.parse(texts[0].text));
        if (!answer || !validAnswer(answer, request.question)) throw apiError('API_INVALID_ANSWER');
        const usage = usageSchema.safeParse(result.usage);
        return {
          answer, provider: 'anthropic' as const, model: request.model, demo: false,
          usage: usage.success ? { inputTokens: usage.data.input_tokens, outputTokens: usage.data.output_tokens } : null,
        };
      };
      // Cover fetch and body parsing, even if a custom transport ignores abort.
      return await Promise.race([operation(), aborted]);
    } catch (error) {
      if (signal.aborted) throw apiError('API_CANCELLED');
      if (deadline.signal.aborted) throw apiError('API_TIMEOUT');
      if (error instanceof SolveError) throw error;
      if (error instanceof SyntaxError) throw apiError('API_INVALID_ANSWER');
      if (error instanceof TypeError) throw apiError('API_NETWORK');
      throw apiError('API_REQUEST_FAILED');
    } finally {
      clearTimeout(timer);
      combined.removeEventListener('abort', onAbort);
    }
  };
}
