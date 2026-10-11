/**
 * Typed HTTP client for /api/v1.
 *
 * - Bearer token from the auth store on every authenticated request; 401 clears the session.
 * - Commands get an `Idempotency-Key` generated ONCE per invocation of `request()`. Automatic
 *   retries of that same invocation (network error / 5xx, max 2, exponential backoff) reuse the
 *   key, so the server deduplicates. A new user action always calls `request()` again and so
 *   always gets a fresh key.
 * - Responses are validated with the contracts zod schemas. A mismatch is reported (dev warning)
 *   but does not crash the UI; the raw payload is returned.
 */
import { ApiError as ApiErrorBody, IDEMPOTENCY_HEADER, type ErrorCode } from '@bh/contracts';
import type { z } from 'zod';

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'BAD_RESPONSE' | 'ABORTED';

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ClientErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** Transient failures that are safe to retry with the same idempotency key. */
  get retryable(): boolean {
    return this.code === 'NETWORK_ERROR' || this.status >= 500;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface RequestSpec<T> {
  method: 'GET' | 'POST';
  path: string;
  query?: QueryParams;
  body?: unknown;
  schema: z.ZodType<T>;
  /** Send the bearer token (default true). */
  auth?: boolean;
  /** State-changing command: attach an Idempotency-Key (default false). */
  command?: boolean;
  signal?: AbortSignal;
}

export interface HttpDeps {
  baseUrl?: string;
  fetch?: typeof fetch;
  getToken: () => string | null;
  onUnauthorized: () => void;
  sleep?: (ms: number) => Promise<void>;
  newIdempotencyKey?: () => string;
  onSchemaMismatch?: (path: string, error: unknown) => void;
  maxRetries?: number;
  /** Base backoff delay in ms (doubles each retry). */
  backoffMs?: number;
}

export interface HttpClient {
  request<T>(spec: RequestSpec<T>): Promise<T>;
}

const STATUS_FALLBACK: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'RULE_VIOLATION',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

export function buildUrl(baseUrl: string, path: string, query?: QueryParams): string {
  let url = `${baseUrl}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

function defaultKey(): string {
  return crypto.randomUUID();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseErrorBody(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const parsed = ApiErrorBody.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(code, message, res.status, details);
  }
  const code: ErrorCode = STATUS_FALLBACK[res.status] ?? 'INTERNAL';
  return new ApiError(code, res.statusText || `Request failed (${res.status})`, res.status, body);
}

export function createHttpClient(deps: HttpDeps): HttpClient {
  const baseUrl = deps.baseUrl ?? '';
  const doFetch =
    deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const sleep = deps.sleep ?? defaultSleep;
  const newKey = deps.newIdempotencyKey ?? defaultKey;
  const maxRetries = deps.maxRetries ?? 2;
  const backoffMs = deps.backoffMs ?? 400;

  async function request<T>(spec: RequestSpec<T>): Promise<T> {
    const useAuth = spec.auth ?? true;
    // One key per invocation; reused by every retry below.
    const idempotencyKey = spec.command ? newKey() : undefined;
    const url = buildUrl(baseUrl, spec.path, spec.query);

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (spec.body !== undefined) headers['content-type'] = 'application/json';
      if (idempotencyKey) headers[IDEMPOTENCY_HEADER] = idempotencyKey;
      if (useAuth) {
        const token = deps.getToken();
        if (token) headers.authorization = `Bearer ${token}`;
      }

      let res: Response;
      try {
        res = await doFetch(url, {
          method: spec.method,
          headers,
          body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          signal: spec.signal,
        });
      } catch (e) {
        if (spec.signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
          throw new ApiError('ABORTED', 'Request was cancelled', 0);
        }
        if (attempt < maxRetries) {
          await sleep(backoffMs * 2 ** attempt + Math.floor(Math.random() * backoffMs));
          continue;
        }
        throw new ApiError(
          'NETWORK_ERROR',
          'Could not reach the server. Check your connection and try again.',
          0,
        );
      }

      if (!res.ok) {
        const err = await parseErrorBody(res);
        if (err.status >= 500 && attempt < maxRetries) {
          await sleep(backoffMs * 2 ** attempt + Math.floor(Math.random() * backoffMs));
          continue;
        }
        if (res.status === 401 && useAuth) deps.onUnauthorized();
        throw err;
      }

      if (res.status === 204) return undefined as T;
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new ApiError('BAD_RESPONSE', 'The server sent an unreadable response.', res.status);
      }
      const parsed = spec.schema.safeParse(json);
      if (parsed.success) return parsed.data;
      deps.onSchemaMismatch?.(spec.path, parsed.error);
      return json as T;
    }
  }

  return { request };
}
