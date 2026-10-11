/**
 * Operational endpoints (no auth): liveness, readiness, version, metrics; plus the dev-only
 * time fast-forward.
 */
import { timingSafeEqual } from 'node:crypto';
import { DevAdvanceRequest } from '@bh/contracts';
import { advanceDay, DomainError, getWorldClock } from '@bh/core';
import { RULESET_VERSION } from '@bh/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  getAuth,
  groupRateLimit,
  parseInput,
  rateLimitKey,
  requireAuth,
  requireIdempotencyKey,
} from '../http';
import type { RouteEnv } from './env';

export const APP_VERSION = process.env.APP_VERSION ?? '0.1.0';

function bearerMatches(req: FastifyRequest, expected: string): boolean {
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function registerOpsRoutes(
  app: FastifyInstance,
  env: RouteEnv,
  opts: { metricsToken?: string },
): void {
  const { deps } = env;

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      const clock = await getWorldClock(deps.pool, deps.config.regionId);
      return { status: 'ready', regionId: clock.regionId, gameDay: clock.gameDay };
    } catch {
      return reply.status(503).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Database or world not ready' },
      });
    }
  });

  app.get('/api/v1/version', async () => ({
    version: APP_VERSION,
    rulesetVersion: RULESET_VERSION,
    gitSha: process.env.GIT_SHA ?? 'unknown',
  }));

  app.get('/metrics', async (req, reply) => {
    if (opts.metricsToken && !bearerMatches(req, opts.metricsToken)) {
      throw new DomainError('UNAUTHENTICATED', 'Metrics token required');
    }
    void reply.header('content-type', env.metrics.registry.contentType);
    return env.metrics.registry.metrics();
  });

  // Dev/test only: run N daily ticks now, then move the epoch back so the worker's wall-clock
  // target matches the advanced day instead of idling until real time catches up.
  if (deps.config.devAdminEnabled && !deps.config.isProduction) {
    app.post(
      '/api/v1/dev/advance',
      {
        onRequest: groupRateLimit(app, {
          name: 'commands',
          max: env.rateLimits.commands,
          keyGenerator: rateLimitKey,
        }),
        preHandler: requireAuth(deps),
      },
      async (req) => {
        const auth = getAuth(req);
        requireIdempotencyKey(req);
        const { days } = parseInput(DevAdvanceRequest, req.body, 'body');
        let advanced = 0;
        let gameDay = (await getWorldClock(deps.pool, auth.regionId)).gameDay;
        for (let i = 0; i < days; i++) {
          const res = await advanceDay(deps, auth.regionId);
          gameDay = res.gameDay;
          if (!res.skipped) advanced++;
        }
        if (advanced > 0) {
          await deps.pool.query(
            `UPDATE world_clock
             SET epoch_at = epoch_at - make_interval(secs => $2::double precision * real_seconds_per_game_day),
                 updated_at = now()
             WHERE region_id = $1`,
            [auth.regionId, advanced],
          );
        }
        req.log.info({ days, advanced, gameDay }, 'dev advance');
        return { ok: true, gameDay, result: { daysAdvanced: advanced } };
      },
    );
  }
}
