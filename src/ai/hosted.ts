import { HOSTED_FALLBACK_URL, hostedBaseUrl } from '../shared/hosted-config';
import { PROTOCOL_VERSION, PROVIDER_MODELS, type SolveResponse } from '../shared/types';
import { SolveError, type Solver } from './solver';
import { solveRequestSchema, validAnswer, validScreenshot } from './validation';

export interface HostedOptions { url?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }
const unavailable = 'The shared NVIDIA service is not configured in this build. Add your own API key in Settings, or install a build connected to the hosted service.';

/** No credential parameter: personal keys can never enter the shared service. */
async function call(path: '/health' | '/solve', body: object | undefined, signal: AbortSignal, options: HostedOptions): Promise<any> {
  const configured = options.url ?? HOSTED_FALLBACK_URL;
  if (!configured) throw new SolveError('HOSTED_UNCONFIGURED', 503, unavailable);
  const url = hostedBaseUrl(configured);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.max(1, Math.min(options.timeoutMs ?? (body ? 28_000 : 5_000), 28_000)));
  const combined = AbortSignal.any([signal, deadline.signal]);
  const cancelled = () => new SolveError(signal.aborted ? 'API_CANCELLED' : 'API_TIMEOUT', signal.aborted ? 499 : 504,
    signal.aborted ? 'The shared AI request was cancelled.' : 'The shared NVIDIA service timed out. No answer was submitted.');
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(cancelled());
    if (combined.aborted) onAbort();
    else combined.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const operation = async () => {
      if (combined.aborted) throw cancelled();
      const response = await (options.fetch ?? globalThis.fetch)(url + path, {
        method: body ? 'POST' : 'GET', signal: combined, redirect: 'error', credentials: 'omit',
        referrerPolicy: 'no-referrer', cache: 'no-store',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const message = response.status === 429 ? 'The shared NVIDIA service has reached its request budget. Try later or use your own API key.'
          : response.status === 403 ? 'This extension is not allowed by the shared service. Check its configured extension ID.'
            : response.status === 503 ? 'The shared NVIDIA service is unavailable or not configured. Try later or use your own API key.'
              : 'The shared NVIDIA service could not answer. Review the question or use your own API key.';
        throw new SolveError('HOSTED_REQUEST_FAILED', response.status, message);
      }
      // A hostile/misconfigured service must not allocate an unlimited body.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing response');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 2 * 1024 * 1024) throw new Error('Oversized response');
          chunks.push(chunk.value);
        }
      } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
      finally { reader.releaseLock(); }
      const buffer = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(buffer));
    };
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    if (combined.aborted) throw cancelled();
    if (error instanceof SolveError) throw error;
    throw new SolveError('HOSTED_UNAVAILABLE', 502, 'Could not read a valid response from the shared NVIDIA service. Check the connection or use your own API key.');
  } finally { clearTimeout(timer); combined.removeEventListener('abort', onAbort); }
}

export async function hostedHealth(options: HostedOptions = {}, signal = new AbortController().signal) {
  const base = { ready: false, demo: false, provider: 'nvidia' as const, model: PROVIDER_MODELS.nvidia, connectionMode: 'hosted' as const };
  if (!(options.url ?? HOSTED_FALLBACK_URL)) return { ...base, detail: unavailable };
  const result = await call('/health', undefined, signal, options);
  if (result?.protocolVersion !== PROTOCOL_VERSION || result.provider !== 'nvidia'
    || result.model !== PROVIDER_MODELS.nvidia || result.demo !== false || typeof result.ready !== 'boolean') {
    throw new SolveError('HOSTED_PROTOCOL', 409, 'The shared service and extension versions do not match. Update the extension and service.');
  }
  return { ...base, ready: result.ready, detail: result.ready ? 'Shared NVIDIA fallback available.' : 'The shared NVIDIA service is not ready. Use your own API key or try later.' };
}

export function createHostedSolver(options: HostedOptions = {}): Solver {
  return async (input, signal) => {
    const parsed = solveRequestSchema.safeParse(input);
    if (!parsed.success || (parsed.data.screenshot && !validScreenshot(parsed.data.screenshot))) {
      throw new SolveError('INVALID_QUESTION', 400, 'The question or screenshot format is invalid.');
    }
    const request = parsed.data;
    const result = await call('/solve', {
      ...request, protocolVersion: PROTOCOL_VERSION, provider: 'nvidia', model: PROVIDER_MODELS.nvidia,
      question: { ...request.question, eventKey: 'shared-fallback', questionId: null,
        imageKeys: request.question.imageKeys.map((_, index) => `image-${index}`) },
    }, signal, options);
    if (!result || result.provider !== 'nvidia' || result.model !== PROVIDER_MODELS.nvidia || result.demo !== false
      || !validAnswer(result.answer, request.question)) {
      throw new SolveError('API_INVALID_ANSWER', 422, 'The shared NVIDIA answer did not match this question. Review it manually.');
    }
    const usage = result.usage;
    // Copy only allowed data, never arbitrary upstream metadata.
    return { provider: 'nvidia', model: PROVIDER_MODELS.nvidia, demo: false, answer: result.answer,
      usage: usage && [usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null } as SolveResponse;
  };
}
