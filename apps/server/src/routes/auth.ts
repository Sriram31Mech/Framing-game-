/**
 * /api/v1/auth/* — no Idempotency-Key; rate limited per IP.
 */
import {
  AuthConfigResponse,
  DevLoginRequest,
  LoginRequest,
  RegisterRequest,
  SteamLoginRequest,
} from '@bh/contracts';
import { devLogin, login, register, revokeSession, steamLogin } from '@bh/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bearerToken, groupRateLimit, parseInput, requireAuth } from '../http';
import type { RouteEnv } from './env';

const meta = (req: FastifyRequest) => ({
  userAgent: req.headers['user-agent'] ?? null,
  ip: req.ip,
});

export function registerAuthRoutes(app: FastifyInstance, env: RouteEnv): void {
  const { deps } = env;
  // 10/min per IP across all auth endpoints.
  const onRequest = groupRateLimit(app, {
    name: 'auth',
    max: env.rateLimits.auth,
    keyGenerator: (req) => req.ip,
  });
  const config = { onRequest };

  app.get('/api/v1/auth/config', config, async () =>
    AuthConfigResponse.parse({
      devAuth: deps.config.devAuthEnabled,
      passwordAuth: deps.config.passwordAuthEnabled,
      steamAuth: deps.config.steam.enabled,
      appEnv: deps.config.appEnv,
    }),
  );

  app.post('/api/v1/auth/register', config, async (req, reply) => {
    const body = parseInput(RegisterRequest, req.body, 'body');
    return reply.status(201).send(await register(deps, body, meta(req)));
  });

  app.post('/api/v1/auth/login', config, async (req) => {
    const body = parseInput(LoginRequest, req.body, 'body');
    return login(deps, body, meta(req));
  });

  // Dev login exists only when enabled (never in production): otherwise the route 404s.
  if (deps.config.devAuthEnabled && !deps.config.isProduction) {
    app.post('/api/v1/auth/dev-login', config, async (req) => {
      const body = parseInput(DevLoginRequest, req.body, 'body');
      return devLogin(deps, body, meta(req));
    });
  }

  app.post('/api/v1/auth/steam', config, async (req) => {
    const body = parseInput(SteamLoginRequest, req.body, 'body');
    return steamLogin(deps, env.steamValidator, body, meta(req));
  });

  app.post('/api/v1/auth/logout', { onRequest, preHandler: requireAuth(deps) }, async (req) => {
    // requireAuth already validated the bearer token.
    const token = bearerToken(req);
    if (token) await revokeSession(deps.pool, deps.config, token);
    return { ok: true };
  });
}
