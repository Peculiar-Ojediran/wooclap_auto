import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAISolver, demoSolver, SolveError, type Solver } from './solver.js';
import { createAnthropicSolver } from './anthropic.js';
import { createNvidiaSolver } from '../src/ai/nvidia.js';
import { bridgeSolveRequestSchema, validAnswer, validScreenshot } from './validation.js';
import { PROTOCOL_VERSION, PROVIDER_LABELS, PROVIDER_MODELS, type Provider } from '../src/shared/types.js';

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export interface BridgeOptions {
  token: string;
  apiKey?: string;
  model?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  nvidiaApiKey?: string;
  demo?: boolean;
  solver?: Solver;
  /** Test seam for verifying credential routing without paid provider calls. */
  solverFactory?: (provider: Provider, apiKey: string) => Solver;
  /** Defaults to 30 accepted solves per minute; used independently of the extension limit. */
  rateLimit?: number;
  rateWindowMs?: number;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function fail(response: ServerResponse, status: number, code: string, message: string): void {
  json(response, status, { error: { code, message } });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    request.resume();
    throw new SolveError('BODY_TOO_LARGE', 413, 'The request is too large.');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Explicit events let us return 413 without destroying the socket as a broken
  // for-await iterator would. Resume/discard any unread bytes after the limit.
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        cleanup();
        request.resume();
        reject(new SolveError('BODY_TOO_LARGE', 413, 'The request is too large.'));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new SolveError('INVALID_JSON', 400, 'The request must contain valid JSON.')); }
    };
    const onError = () => { cleanup(); reject(new SolveError('INVALID_REQUEST', 400, 'The request could not be read.')); };
    const onAborted = () => { cleanup(); reject(new SolveError('INVALID_REQUEST', 400, 'The request was interrupted.')); };
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
  });
}

export function createBridgeServer(options: BridgeOptions) {
  if (options.token.length < 32) throw new Error('The bridge token must contain at least 32 characters.');
  const tokenHash = createHash('sha256').update(options.token).digest();
  const model = options.model || PROVIDER_MODELS.openai;
  const anthropicModel = options.anthropicModel || PROVIDER_MODELS.anthropic;
  const demo = Boolean(options.demo);
  const serverKey = (provider: Provider) => provider === 'nvidia' ? options.nvidiaApiKey : provider === 'anthropic' ? options.anthropicApiKey : options.apiKey;
  const providerReady = (provider: Provider) => Boolean(options.solver || serverKey(provider));
  const solverFactory = options.solverFactory ?? ((provider: Provider, apiKey: string) => provider === 'nvidia' ? createNvidiaSolver(apiKey) : provider === 'anthropic' ? createAnthropicSolver(apiKey) : createOpenAISolver(apiKey));
  const rateLimit = options.rateLimit ?? 30;
  const rateWindowMs = options.rateWindowMs ?? 60_000;
  let active = false;
  let acceptedAt: number[] = [];

  const server = createServer(async (request, response) => {
    const port = (server.address() as AddressInfo | null)?.port;
    if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) {
      fail(response, 403, 'INVALID_HOST', 'Only the local bridge hostname is accepted.');
      return;
    }
    const pathname = request.url?.split('?')[0];
    if (request.method === 'GET' && pathname === '/practice') {
      try {
        const html = await readFile(new URL('./practice.html', import.meta.url));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        response.end(html);
      } catch { fail(response, 503, 'PRACTICE_UNAVAILABLE', 'The bundled practice page is unavailable.'); }
      return;
    }
    if (pathname !== '/health' && pathname !== '/solve') {
      fail(response, 404, 'NOT_FOUND', 'This bridge route does not exist.');
      return;
    }
    const origin = request.headers.origin;
    if (origin && !EXTENSION_ORIGIN.test(origin)) {
      fail(response, 403, 'INVALID_ORIGIN', 'API access is limited to the paired browser extension.');
      return;
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      const headers = (request.headers['access-control-request-headers'] ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      const requestedMethod = request.headers['access-control-request-method'];
      if (!origin || (requestedMethod !== 'GET' && requestedMethod !== 'POST') || headers.some(value => !['authorization', 'content-type'].includes(value))) {
        fail(response, 403, 'INVALID_PREFLIGHT', 'This cross-origin request is not allowed.');
        return;
      }
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
      response.end();
      return;
    }
    const authorization = request.headers.authorization ?? '';
    const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!timingSafeEqual(tokenHash, createHash('sha256').update(candidate).digest())) {
      fail(response, 401, 'UNAUTHORIZED', 'Enter the local bridge pairing token in the extension settings.');
      return;
    }
    if (pathname === '/health' && request.method === 'GET') {
      json(response, 200, {
        ready: demo || providerReady('openai'), demo, model, protocolVersion: PROTOCOL_VERSION, acceptsClientKeys: true,
        providers: { openai: { ready: providerReady('openai'), model }, anthropic: { ready: providerReady('anthropic'), model: anthropicModel }, nvidia: { ready: providerReady('nvidia'), model: PROVIDER_MODELS.nvidia } },
      });
      return;
    }
    if (pathname !== '/solve' || request.method !== 'POST') {
      fail(response, 405, 'METHOD_NOT_ALLOWED', 'This method is not supported for this route.');
      return;
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
      fail(response, 415, 'JSON_REQUIRED', 'Use application/json for solve requests.');
      return;
    }
    if (active) {
      fail(response, 409, 'BRIDGE_BUSY', 'The bridge is already processing a question.');
      return;
    }
    const now = Date.now();
    acceptedAt = acceptedAt.filter(time => now - time < rateWindowMs);
    if (acceptedAt.length >= rateLimit) {
      fail(response, 429, 'RATE_LIMITED', 'The local request budget is exhausted. Wait a minute before trying again.');
      return;
    }
    active = true;
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', cancel);
    try {
      const payload = await readJson(request);
      if (payload && typeof payload === 'object' && 'protocolVersion' in payload && payload.protocolVersion !== PROTOCOL_VERSION) {
        throw new SolveError('PROTOCOL_MISMATCH', 409, 'The extension and local bridge versions do not match. Rebuild and reload the extension, then restart the bridge.');
      }
      const parsed = bridgeSolveRequestSchema.safeParse(payload);
      if (!parsed.success || (parsed.data.screenshot && !validScreenshot(parsed.data.screenshot))) {
        throw new SolveError('INVALID_QUESTION', 400, 'The question, choices, model, or screenshot format is invalid.');
      }
      if (demo && parsed.data.question.source !== 'practice') {
        throw new SolveError('DEMO_PRACTICE_ONLY', 422, 'Demo mode only answers the bundled practice questions.');
      }
      const { apiKey: requestApiKey, ...solveRequest } = parsed.data;
      const provider = solveRequest.provider ?? 'openai';
      const apiKey = requestApiKey ?? serverKey(provider);
      // Request keys live only for this solve and never enter the solver payload.
      const solver = options.solver ?? (demo ? demoSolver : apiKey ? solverFactory(provider, apiKey) : null);
      if (!solver) {
        throw new SolveError('API_KEY_REQUIRED', 503, `Enter a ${PROVIDER_LABELS[provider]} API key in extension settings, or configure ${provider.toUpperCase()}_API_KEY on the local bridge.`);
      }
      acceptedAt.push(now);
      const result = await solver(solveRequest, controller.signal);
      if (!result || !validAnswer(result.answer, solveRequest.question)) {
        throw new SolveError('INVALID_ANSWER', 422, 'The answer did not match the current choices. Review this question manually.');
      }
      json(response, 200, demo || result.demo ? result : { ...result, provider });
    } catch (error) {
      if (error instanceof SolveError) fail(response, error.status, error.code, error.message);
      else fail(response, 502, 'AI_REQUEST_FAILED', 'The AI request failed or timed out. Check the bridge API key, selected model, and network, then try again.');
    } finally {
      response.off('close', cancel);
      active = false;
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  return server;
}
