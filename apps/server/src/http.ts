/**
 * HTTP plumbing shared by routes: input validation, bearer auth, idempotency header.
 */
import { createHash } from 'node:crypto';
import { IDEMPOTENCY_HEADER, IdempotencyKey } from '@bh/contracts';
import { authenticate, DomainError, type AuthContext, type CoreDeps } from '@bh/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth`; null on unauthenticated routes. */
    auth: AuthContext | null;
  }
}

/** Parse params/query/body with a contract schema; 400 VALIDATION_FAILED with issue details. */
export function parseInput<S extends z.ZodType>(
  schema: S,
  data: unknown,
  where: 'body' | 'query' | 'params',
): z.infer<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw new DomainError('VALIDATION_FAILED', `Invalid request ${where}`, {
      issues: result.error.issues.map((i) => ({
        path: [where, ...i.path.map(String)].join('.'),
        code: i.code,
        message: i.message,
      })),
    });
  }
  return result.data;
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9_\-.~+/=]{16,256})$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/** Rate-limit key: the session (hashed token) when present, otherwise the client IP. */
export function rateLimitKey(req: FastifyRequest): string {
  const token = bearerToken(req);
  if (token) return `s:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
  return `ip:${req.ip}`;
}

export function requireAuth(deps: CoreDeps) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = bearerToken(req);
    const auth = token ? await authenticate(deps.pool, deps.config, token) : null;
    if (!auth) throw new DomainError('UNAUTHENTICATED', 'Sign in to continue');
    req.auth = auth;
  };
}

export function getAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new DomainError('UNAUTHENTICATED', 'Sign in to continue');
  return req.auth;
}

/** Idempotency-Key header (required on every non-auth POST). */
export function requireIdempotencyKey(req: FastifyRequest): string {
  const raw = req.headers[IDEMPOTENCY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') {
    throw new DomainError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'An Idempotency-Key header (8–128 characters) is required',
    );
  }
  const parsed = IdempotencyKey.safeParse(value);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', 'Malformed Idempotency-Key header', {
      issues: [
        {
          path: 'headers.idempotency-key',
          code: 'invalid',
          message: '8–128 of A-Z a-z 0-9 _ - : .',
        },
      ],
    });
  }
  return parsed.data;
}

export function requireCompanyId(auth: AuthContext): string {
  if (!auth.companyId) throw new DomainError('COMPANY_REQUIRED', 'Create a company first');
  return auth.companyId;
}

/**
 * One shared rate-limit counter per route group (e.g. all command routes), applied as an
 * onRequest hook. @fastify/rate-limit's per-route config would count each route separately.
 */
export function groupRateLimit(
  app: FastifyInstance,
  opts: { name: string; max: number; keyGenerator: (req: FastifyRequest) => string },
): onRequestAsyncHookHandler {
  const check = app.createRateLimit({
    max: opts.max,
    timeWindow: 60_000,
    keyGenerator: (req) => `${opts.name}:${opts.keyGenerator(req)}`,
  });
  return async (req, reply) => {
    const r = await check(req);
    if (r.isAllowed) return;
    void reply.header('x-ratelimit-limit', r.max);
    void reply.header('x-ratelimit-remaining', r.remaining);
    void reply.header('x-ratelimit-reset', r.ttlInSeconds);
    if (r.isExceeded) {
      void reply.header('retry-after', r.ttlInSeconds);
      throw new DomainError('RATE_LIMITED', 'Too many requests; please slow down', {
        retryAfterSeconds: r.ttlInSeconds,
      });
    }
  };
}

type onRequestAsyncHookHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
