import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, buildUrl, createHttpClient } from '../src/api/http';

type Call = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(responses: (Response | Error)[], token: string | null = 'tok_1234567890abcdef') {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const onUnauthorized = vi.fn();
  const onSchemaMismatch = vi.fn();
  let n = 0;
  const http = createHttpClient({
    fetch: fetchFn as unknown as typeof fetch,
    getToken: () => token,
    onUnauthorized,
    onSchemaMismatch,
    sleep: async () => undefined,
    newIdempotencyKey: () => `key-${++n}-abcdef`,
  });
  const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];
  return { http, calls, onUnauthorized, onSchemaMismatch, header };
}

const Ok = z.object({ ok: z.literal(true), gameDay: z.number(), result: z.unknown() });
const okBody = { ok: true, gameDay: 3, result: null };

describe('http client', () => {
  it('reuses the same Idempotency-Key when retrying one command after 5xx / network errors', async () => {
    const { http, calls, header } = setup([
      jsonResponse(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'busy' } }),
      new TypeError('Failed to fetch'),
      jsonResponse(200, okBody),
    ]);
    const res = await http.request({
      method: 'POST',
      path: '/api/v1/crop-plots',
      body: { a: 1 },
      schema: Ok,
      command: true,
    });
    expect(res.gameDay).toBe(3);
    expect(calls).toHaveLength(3);
    const keys = calls.map((c) => header(c, 'idempotency-key'));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('key-1-abcdef');
  });

  it('uses a fresh key for every separate invocation (user action)', async () => {
    const { http, calls, header } = setup([jsonResponse(200, okBody), jsonResponse(200, okBody)]);
    await http.request({ method: 'POST', path: '/x', body: {}, schema: Ok, command: true });
    await http.request({ method: 'POST', path: '/x', body: {}, schema: Ok, command: true });
    expect(header(calls[0]!, 'idempotency-key')).not.toBe(header(calls[1]!, 'idempotency-key'));
  });

  it('does not attach an Idempotency-Key to queries and sends the bearer token', async () => {
    const { http, calls, header } = setup([jsonResponse(200, okBody)]);
    await http.request({ method: 'GET', path: '/api/v1/me', schema: Ok });
    expect(header(calls[0]!, 'idempotency-key')).toBeUndefined();
    expect(header(calls[0]!, 'authorization')).toBe('Bearer tok_1234567890abcdef');
  });

  it('omits the bearer token for auth endpoints', async () => {
    const { http, calls, header } = setup([jsonResponse(200, okBody)]);
    await http.request({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: {},
      schema: Ok,
      auth: false,
    });
    expect(header(calls[0]!, 'authorization')).toBeUndefined();
  });

  it('gives up after 2 retries and throws NETWORK_ERROR', async () => {
    const { http, calls } = setup([new TypeError('x'), new TypeError('x'), new TypeError('x')]);
    await expect(http.request({ method: 'GET', path: '/a', schema: Ok })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(calls).toHaveLength(3);
  });

  it('does not retry 4xx and parses the error envelope', async () => {
    const { http, calls } = setup([
      jsonResponse(409, {
        error: { code: 'PRICE_CHANGED', message: 'Price is now ₹2', details: { pricePaise: 200 } },
      }),
    ]);
    const err = await http
      .request({ method: 'POST', path: '/p', body: {}, schema: Ok, command: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.code).toBe('PRICE_CHANGED');
    expect(e.status).toBe(409);
    expect(e.message).toBe('Price is now ₹2');
    expect(e.details).toEqual({ pricePaise: 200 });
    expect(e.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('falls back to a status-derived code for non-JSON errors', async () => {
    const { http } = setup([new Response('nope', { status: 404, statusText: 'Not Found' })]);
    await expect(http.request({ method: 'GET', path: '/a', schema: Ok })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('calls onUnauthorized on 401 for authenticated requests only', async () => {
    const a = setup([
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }),
    ]);
    await expect(
      a.http.request({ method: 'GET', path: '/api/v1/me', schema: Ok }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(a.onUnauthorized).toHaveBeenCalledTimes(1);
    const b = setup([
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'bad password' } }),
    ]);
    await expect(
      b.http.request({
        method: 'POST',
        path: '/api/v1/auth/login',
        body: {},
        schema: Ok,
        auth: false,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(b.onUnauthorized).not.toHaveBeenCalled();
  });

  it('reports a contract mismatch but still returns the payload', async () => {
    const { http, onSchemaMismatch } = setup([jsonResponse(200, { ok: true, gameDay: 'three' })]);
    const res = await http.request({ method: 'GET', path: '/m', schema: Ok });
    expect(res).toEqual({ ok: true, gameDay: 'three' });
    expect(onSchemaMismatch).toHaveBeenCalledTimes(1);
  });

  it('builds query strings, skipping empty values', () => {
    expect(buildUrl('', '/a', { x: 1, y: undefined, z: '', w: true })).toBe('/a?x=1&w=true');
    expect(buildUrl('', '/a')).toBe('/a');
  });
});
