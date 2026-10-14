import { z } from 'zod';
import { answerInstructions, outputBudget, questionPrompt, SolveError, type Solver } from './solver.js';
import { modelAnswerSchema, normalizeModelAnswer, solveRequestSchema, validAnswer, validScreenshot } from './validation.js';

export interface NvidiaSolverOptions {
  /** Fixture transport; production always uses the fixed NVIDIA endpoint. */
  fetch?: typeof globalThis.fetch;
  /** May shorten, but never extend, the full 25-second request deadline. */
  timeoutMs?: number;
}

const errors = {
  API_AUTH: [503, 'NVIDIA rejected the API key. Update the NVIDIA key in extension settings or the hosted service configuration.'],
  API_ACCESS_DENIED: [403, 'The NVIDIA API key cannot access this model. Check its permissions and the selected model.'],
  API_QUOTA: [429, 'NVIDIA API credits or spending limits prevent this request. Check the NVIDIA account before trying again.'],
  API_RATE_LIMIT: [429, 'NVIDIA is rate limiting requests. Wait before trying this question again.'],
  API_MODEL_UNAVAILABLE: [422, 'The selected NVIDIA model is unavailable to this API key. Check the selected model.'],
  API_NETWORK: [502, 'Could not reach NVIDIA. Check the network connection before trying again.'],
  API_TIMEOUT: [504, 'NVIDIA did not finish within the request deadline. No answer was submitted; review the question before trying again.'],
  API_CANCELLED: [499, 'The AI request was cancelled. No answer from this request will be used.'],
  API_REFUSAL: [422, 'The model declined to answer this question. Review it manually.'],
  API_INCOMPLETE: [422, 'The model did not finish a complete answer. Review this question manually.'],
  API_INVALID_ANSWER: [422, 'The AI answer did not match the required format or current choices. Review this question manually.'],
  API_UNAVAILABLE: [503, 'NVIDIA is temporarily unavailable. Wait before trying this question again.'],
  API_REQUEST_REJECTED: [422, 'NVIDIA rejected the question request. Check the selected model and question content before trying again.'],
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
  choices: z.array(z.object({
    finish_reason: z.string().nullable(),
    message: z.object({
      role: z.literal('assistant'), content: z.string().nullable(),
      refusal: z.unknown().optional(), tool_calls: z.unknown().optional(), function_call: z.unknown().optional(),
    }),
  })).length(1),
  usage: z.unknown().optional(),
});
const usageSchema = z.object({ prompt_tokens: z.number().int().nonnegative().safe(), completion_tokens: z.number().int().nonnegative().safe() });

/**
 * NVIDIA's model-specific API documents Chat Completions with text/image parts,
 * but no response_format or reasoning controls. Request JSON through the prompt
 * and enforce the same strict answer schema locally before accepting any result.
 */
export function createNvidiaSolver(apiKey: string, options: NvidiaSolverOptions = {}): Solver {
  const transport = options.fetch ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.min(options.timeoutMs!, 25_000)) : 25_000;
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
        provider: 'nvidia', model: request.model, usage: null, demo: false,
      };
    }
    if (!apiKey.trim()) throw apiError('API_AUTH');
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: questionPrompt(request) }];
    if (request.screenshot) content.push({ type: 'image_url', image_url: { url: request.screenshot } });
    const schema = z.toJSONSchema(modelAnswerSchema(request.question), { target: 'draft-7' });
    delete schema.$schema;
    const system = `${answerInstructions(request.question)} Return exactly one JSON object conforming to this JSON Schema. Do not add markdown fences, reasoning, or text outside the JSON object. JSON Schema: ${JSON.stringify(schema)}`;
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
        const response = await transport('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST', redirect: 'error', signal: combined, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: request.model,
            // Leave room for reasoning without adopting the playground's 262K
            // default. Truncated answers still fail closed below.
            max_tokens: Math.max(4_096, outputBudget(request.question)),
            temperature: 1, top_p: 0.95, stream: false,
            messages: [{ role: 'system', content: system }, { role: 'user', content }],
          }),
        });
        if (!response.ok) {
          // Provider errors can reflect private inputs or credentials.
          await response.body?.cancel();
          throw upstreamError(response.status);
        }
        const payload: unknown = await response.json();
        if (signal.aborted) throw apiError('API_CANCELLED');
        if (deadline.signal.aborted) throw apiError('API_TIMEOUT');
        const parsedResponse = responseSchema.safeParse(payload);
        if (!parsedResponse.success) throw apiError('API_INVALID_ANSWER');
        const choice = parsedResponse.data.choices[0];
        const message = choice.message;
        if (choice.finish_reason === 'content_filter' || choice.finish_reason === 'refusal'
          || (message.refusal !== undefined && message.refusal !== null && message.refusal !== '')) throw apiError('API_REFUSAL');
        if (choice.finish_reason !== 'stop') throw apiError('API_INCOMPLETE');
        if (typeof message.content !== 'string'
          || (message.tool_calls !== undefined && message.tool_calls !== null)
          || (message.function_call !== undefined && message.function_call !== null)) throw apiError('API_INVALID_ANSWER');
        // Only final content is interpreted. Separate reasoning_content is never
        // exposed as an answer, and fences or partial JSON are not repaired.
        const answer = normalizeModelAnswer(request.question, JSON.parse(message.content));
        if (!answer || !validAnswer(answer, request.question)) throw apiError('API_INVALID_ANSWER');
        const usage = usageSchema.safeParse(parsedResponse.data.usage);
        return {
          answer, provider: 'nvidia' as const, model: request.model, demo: false,
          usage: usage.success ? { inputTokens: usage.data.prompt_tokens, outputTokens: usage.data.completion_tokens } : null,
        };
      };
      // Cover fetch and body parsing even when a fixture transport ignores abort.
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
