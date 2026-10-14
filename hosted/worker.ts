import { createNvidiaSolver } from '../src/ai/nvidia.js';
import { SolveError, type Solver } from '../src/ai/solver.js';
import { solveRequestSchema, validAnswer, validScreenshot } from '../src/ai/validation.js';
import { PROTOCOL_VERSION, PROVIDER_MODELS, type SolveResponse } from '../src/shared/types.js';
import { DAY_MS, PersistentBudget, type BudgetStorage, type Limits, type Reservation } from './budget.js';

export const MAX_REQUEST_BYTES = 5_700_000;
export const MAX_RESPONSE_BYTES = 128_000;
export const SERVICE_TIMEOUT_MS = 28_000;
const BODY_TIMEOUT_MS = 10_000;

interface BudgetStub { fetch(request: Request): Promise<Response> }
interface BudgetNamespace { idFromName(name: string): unknown; get(id: unknown): BudgetStub }
export interface Env {
  NVIDIA_API_KEY?: string;
  ALLOWED_EXTENSION_IDS?: string;
  ENABLED?: string;
  DAILY_REQUEST_LIMIT?: string;
  DAILY_INPUT_BYTES?: string;
  IP_REQUESTS_PER_MINUTE?: string;
  IP_REQUESTS_PER_DAY?: string;
  MAX_CONCURRENT_REQUESTS?: string;
  SHARED_BUDGET?: BudgetNamespace;
}
interface Configuration { key: string; origins: Set<string>; limits: Limits }
interface Options {
  solverFactory?: (key: string) => Solver;
  now?: () => number;
  timeoutMs?: number;
  bodyTimeoutMs?: number;
}

function integer(value: string | undefined, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 1 && result <= max ? result : null;
}

export function configuration(env: Env): Configuration | null {
  if (env.ENABLED !== 'true' || !env.SHARED_BUDGET) return null;
  const key = env.NVIDIA_API_KEY?.trim();
  if (!key || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) return null;
  const ids = env.ALLOWED_EXTENSION_IDS?.split(',').map(id => id.trim()).filter(Boolean) ?? [];
  if (!ids.length || ids.length > 30 || ids.some(id => !/^[a-p]{32}$/.test(id))) return null;
  const rawLimits = {
    // Keep the single persisted budget record below the DO value-size limit.
    dailyRequests: integer(env.DAILY_REQUEST_LIMIT, 100, 500),
    dailyInputBytes: integer(env.DAILY_INPUT_BYTES, 20 * 1024 * 1024, 100 * 1024 * 1024),
    ipPerMinute: integer(env.IP_REQUESTS_PER_MINUTE, 6, 30),
    ipPerDay: integer(env.IP_REQUESTS_PER_DAY, 30, 1_000),
    concurrency: integer(env.MAX_CONCURRENT_REQUESTS, 2, 6),
  };
  if (Object.values(rawLimits).some(value => value === null)) return null;
  return { key, origins: new Set(ids.map(id => `chrome-extension://${id}`)), limits: rawLimits as Limits };
}

function headers(origin?: string): Headers {
  const result = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin' });
  if (origin) {
    result.set('access-control-allow-origin', origin);
    result.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    result.set('access-control-allow-headers', 'Content-Type');
    result.set('access-control-max-age', '600');
  }
  return result;
}

function json(status: number, data: unknown, origin?: string, retryAfter?: number): Response {
  const responseHeaders = headers(origin);
  if (retryAfter !== undefined) responseHeaders.set('retry-after', String(retryAfter));
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}
function fail(status: number, code: string, message: string, origin?: string, retryAfter?: number): Response {
  return json(status, { error: { code, message } }, origin, retryAfter);
}

class BodyError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

async function readBody(request: Request, timeoutMs: number): Promise<{ data: unknown; bytes: number }> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) throw new BodyError(413, 'HOSTED_BODY_TOO_LARGE');
  if (!request.body) throw new BodyError(400, 'HOSTED_INVALID_REQUEST');
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new BodyError(408, 'HOSTED_BODY_TIMEOUT')); }, timeoutMs);
    abortListener = () => { void reader.cancel().catch(() => {}); reject(new BodyError(499, 'API_CANCELLED')); };
    request.signal.addEventListener('abort', abortListener, { once: true });
    if (request.signal.aborted) abortListener();
  });
  try {
    return await Promise.race([cancellation, (async () => {
      let bytes = 0;
      let text = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_REQUEST_BYTES) { void reader.cancel().catch(() => {}); throw new BodyError(413, 'HOSTED_BODY_TOO_LARGE'); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return { data: JSON.parse(text) as unknown, bytes };
    })()]);
  } finally {
    clearTimeout(timer);
    if (abortListener) request.signal.removeEventListener('abort', abortListener);
  }
}

/** Only a daily HMAC is persisted; the raw network IP is never logged or stored. */
export async function clientHash(key: string, ip: string, now: number): Promise<string> {
  const encoder = new TextEncoder();
  const secret = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hash = await crypto.subtle.sign('HMAC', secret, encoder.encode(`wooclap-fallback-ip:${Math.floor(now / DAY_MS)}:${ip}`));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function budgetStub(env: Env): BudgetStub {
  return env.SHARED_BUDGET!.get(env.SHARED_BUDGET!.idFromName('shared-nvidia-fallback-v1'));
}
function internalRequest(path: string, data: unknown): Request {
  return new Request(`https://budget.internal/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
}

function safeAnswer(response: SolveResponse, request: ReturnType<typeof solveRequestSchema.parse>): SolveResponse | null {
  if (response.provider !== 'nvidia' || response.model !== PROVIDER_MODELS.nvidia || response.demo !== false || !validAnswer(response.answer, request.question)) return null;
  const { selectedChoiceIds, value, values, points, explanation, needsReview } = response.answer;
  const usage = response.usage && Number.isSafeInteger(response.usage.inputTokens) && response.usage.inputTokens >= 0
    && Number.isSafeInteger(response.usage.outputTokens) && response.usage.outputTokens >= 0
    ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : null;
  // Rebuild the envelope so injected or future upstream metadata cannot leak keys.
  return { provider: 'nvidia', model: PROVIDER_MODELS.nvidia, demo: false, usage,
    answer: { selectedChoiceIds, ...(value !== undefined ? { value } : {}), ...(values !== undefined ? { values } : {}), ...(points !== undefined ? { points } : {}), explanation, needsReview } };
}

export function createHostedHandler(options: Options = {}) {
  const now = options.now ?? Date.now;
  return async (request: Request, env: Env): Promise<Response> => {
    const config = configuration(env);
    const origin = request.headers.get('origin') ?? '';
    const url = new URL(request.url);
    // Edge omits Origin on extension GET fetches. This public health response
    // contains readiness metadata only; every solve still requires an allowed
    // extension Origin and passes through the persisted budget.
    if (!origin && request.method === 'GET' && url.pathname === '/health' && !url.search) {
      return json(200, { ready: Boolean(config), demo: false, provider: 'nvidia', model: PROVIDER_MODELS.nvidia, protocolVersion: PROTOCOL_VERSION });
    }
    // No unauthenticated browser origin is accepted. CORS is not caller authentication.
    const knownOrigin = /^[a-p]{32}$/.test(origin.replace(/^chrome-extension:\/\//, ''))
      && (env.ALLOWED_EXTENSION_IDS?.split(',').map(id => `chrome-extension://${id.trim()}`).includes(origin) ?? false);
    if (!knownOrigin) return fail(403, 'HOSTED_ORIGIN_DENIED', 'This extension is not allowed to use the shared service.');
    if (url.search || !['/health', '/solve'].includes(url.pathname)) return fail(404, 'HOSTED_NOT_FOUND', 'Endpoint not found.', origin);
    if (request.method === 'OPTIONS') {
      const method = request.headers.get('access-control-request-method');
      const requestedHeaders = request.headers.get('access-control-request-headers')?.split(',').map(value => value.trim().toLowerCase()) ?? [];
      if ((method !== 'GET' && method !== 'POST') || requestedHeaders.some(value => value !== 'content-type')) return fail(403, 'HOSTED_PREFLIGHT_DENIED', 'Request is not allowed.', origin);
      return new Response(null, { status: 204, headers: headers(origin) });
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      return json(200, { ready: Boolean(config), demo: false, provider: 'nvidia', model: PROVIDER_MODELS.nvidia, protocolVersion: PROTOCOL_VERSION }, origin);
    }
    if (url.pathname !== '/solve' || request.method !== 'POST') return fail(405, 'HOSTED_METHOD_DENIED', 'Method not allowed.', origin);
    if (!config) return fail(503, 'HOSTED_UNAVAILABLE', 'The shared NVIDIA service is not configured or is paused. Add your own API key or try later.', origin);
    if (request.headers.has('authorization') || request.headers.has('cookie')) return fail(400, 'HOSTED_INVALID_REQUEST', 'Do not send credentials or cookies to the shared service.', origin);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail(415, 'HOSTED_CONTENT_TYPE', 'Send a JSON question request.', origin);
    const ip = request.headers.get('cf-connecting-ip');
    if (!ip || ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip)) return fail(503, 'HOSTED_UNAVAILABLE', 'The shared service could not identify the network request.', origin);
    let lease: string | undefined;
    let stub: BudgetStub | undefined;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      const body = await readBody(request, Math.max(1, Math.min(options.bodyTimeoutMs ?? BODY_TIMEOUT_MS, BODY_TIMEOUT_MS)));
      const parsed = solveRequestSchema.safeParse(body.data);
      if (!parsed.success || parsed.data.provider !== 'nvidia' || parsed.data.model !== PROVIDER_MODELS.nvidia || parsed.data.protocolVersion !== PROTOCOL_VERSION
        || (parsed.data.screenshot !== undefined && !validScreenshot(parsed.data.screenshot))) {
        return fail(400, 'HOSTED_INVALID_REQUEST', 'The shared service accepts only valid questions for its fixed NVIDIA model.', origin);
      }
      if (request.signal.aborted) throw new BodyError(499, 'API_CANCELLED');
      const client = await clientHash(config.key, ip, now());
      stub = budgetStub(env);
      const reservationResponse = await stub.fetch(internalRequest('reserve', { client, inputBytes: body.bytes }));
      if (!reservationResponse.ok) throw new Error('Budget unavailable');
      const reservation = await reservationResponse.json() as Reservation;
      if (!reservation.allowed) return fail(429, reservation.code, 'The shared NVIDIA service has reached its usage limit. Add your own API key or try later.', origin, reservation.retryAfter);
      lease = reservation.lease;
      controller = new AbortController();
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => { controller!.abort(); reject(new BodyError(499, 'API_CANCELLED')); };
        request.signal.addEventListener('abort', abortListener, { once: true });
        timer = setTimeout(() => { controller!.abort(); reject(new BodyError(504, 'API_TIMEOUT')); }, Math.max(1, Math.min(options.timeoutMs ?? SERVICE_TIMEOUT_MS, SERVICE_TIMEOUT_MS)));
        if (request.signal.aborted) abortListener();
      });
      if (request.signal.aborted) throw new BodyError(499, 'API_CANCELLED');
      const solver = options.solverFactory?.(config.key) ?? createNvidiaSolver(config.key, {
        timeoutMs: 25_000,
        fetch: (input, init) => {
          // Workers rejects browser cache and redirect:error options. POST
          // bypasses its cache; manual redirects become errors in the solver
          // without forwarding the server key to another host.
          const { cache: _cache, ...workerInit } = init ?? {};
          return fetch(input, { ...workerInit, redirect: 'manual' });
        },
      });
      const result = safeAnswer(await Promise.race([solver(parsed.data, controller.signal), aborted]), parsed.data);
      if (!result) return fail(502, 'API_INVALID_ANSWER', 'NVIDIA returned an invalid answer. Review this question manually.', origin);
      const response = JSON.stringify(result);
      if (new TextEncoder().encode(response).byteLength > MAX_RESPONSE_BYTES) return fail(502, 'API_INVALID_ANSWER', 'NVIDIA returned an oversized answer. Review this question manually.', origin);
      return new Response(response, { status: 200, headers: headers(origin) });
    } catch (error) {
      if (error instanceof BodyError) return fail(error.status, error.code, error.code === 'HOSTED_BODY_TOO_LARGE' ? 'The question request is too large.' : 'The request was invalid, cancelled, or exceeded its deadline.', origin);
      if (error instanceof SyntaxError || error instanceof TypeError) return fail(400, 'HOSTED_INVALID_REQUEST', 'The question request could not be read.', origin);
      if (error instanceof SolveError) {
        const knownCodes = new Set(['API_AUTH', 'API_ACCESS_DENIED', 'API_QUOTA', 'API_RATE_LIMIT', 'API_MODEL_UNAVAILABLE', 'API_MODEL_UNSUPPORTED', 'API_INVALID_IMAGE', 'API_NETWORK', 'API_TIMEOUT', 'API_CANCELLED', 'API_REFUSAL', 'API_INCOMPLETE', 'API_INVALID_ANSWER', 'API_UNAVAILABLE', 'API_REQUEST_REJECTED', 'API_REQUEST_FAILED']);
        const code = knownCodes.has(error.code) ? error.code : 'API_REQUEST_FAILED';
        const status = ['API_AUTH', 'API_ACCESS_DENIED', 'API_MODEL_UNAVAILABLE'].includes(code) ? 503 : code === 'API_TIMEOUT' ? 504 : code === 'API_CANCELLED' ? 499 : ['API_QUOTA', 'API_RATE_LIMIT'].includes(code) ? 429 : 502;
        return fail(status, code, 'The shared NVIDIA request could not complete. Review this question, use your own API key, or try later.', origin);
      }
      return fail(503, 'HOSTED_UNAVAILABLE', 'The shared NVIDIA service is temporarily unavailable.', origin);
    } finally {
      clearTimeout(timer);
      if (abortListener) request.signal.removeEventListener('abort', abortListener);
      if (stub && lease) {
        // A failed release cannot reset spent allowances. Its lease expires automatically.
        try { await stub.fetch(internalRequest('release', { lease })); } catch { /* no raw error logging */ }
      }
    }
  };
}

/** One stable object coordinates the entire deployment, including all allowed IDs. */
export class SharedBudget {
  constructor(private readonly state: { storage: BudgetStorage }, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const config = configuration(this.env);
    if (!config || request.method !== 'POST') return json(503, { ready: false });
    const path = new URL(request.url).pathname;
    const text = await request.text();
    if (text.length > 512) return json(400, { error: 'invalid' });
    let data: Record<string, unknown>;
    try { data = JSON.parse(text) as Record<string, unknown>; } catch { return json(400, { error: 'invalid' }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json(400, { error: 'invalid' });
    const budget = new PersistentBudget(this.state.storage, config.limits);
    if (path === '/reserve' && typeof data.client === 'string' && /^[a-f0-9]{64}$/.test(data.client)
      && typeof data.inputBytes === 'number' && Number.isSafeInteger(data.inputBytes) && data.inputBytes > 0 && data.inputBytes <= MAX_REQUEST_BYTES) {
      return json(200, await budget.reserve(data.client, data.inputBytes, Date.now()));
    }
    if (path === '/release' && typeof data.lease === 'string' && /^[a-f0-9-]{36}$/.test(data.lease)) {
      await budget.release(data.lease);
      return json(200, { released: true });
    }
    return json(400, { error: 'invalid' });
  }

  async alarm(): Promise<void> {
    // Expiry must continue while disabled or while credentials are being rotated.
    await new PersistentBudget(this.state.storage, { dailyRequests: 1, dailyInputBytes: 1, ipPerMinute: 1, ipPerDay: 1, concurrency: 1 }).expire(Date.now());
  }
}

export default { fetch: createHostedHandler() };
