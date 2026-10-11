/**
 * Fastify application factory. `buildApp` is used by main.ts and by tests (fastify.inject /
 * injectWS); it never listens or touches process signals itself.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { createSteamValidator, type CoreDeps, type SteamTicketValidator } from '@bh/core';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { installErrorHandler, notFoundBody } from './errors';
import { createMetrics, type Metrics } from './metrics';
import { DEFAULT_GATEWAY_OPTIONS, RealtimeGateway, type GatewayOptions } from './realtime/gateway';
import { registerAuthRoutes } from './routes/auth';
import { registerCommandRoutes } from './routes/commands';
import { DEFAULT_RATE_LIMITS, type RateLimits, type RouteEnv } from './routes/env';
import { registerOpsRoutes } from './routes/ops';
import { registerQueryRoutes } from './routes/queries';

export const BODY_LIMIT_BYTES = 64 * 1024;
const WS_MAX_PAYLOAD_BYTES = 4 * 1024;

export interface BuildAppOptions {
  rateLimits?: Partial<RateLimits>;
  /** Injectable Steam ticket validation (tests); defaults to the Steam Web API. */
  steamValidator?: SteamTicketValidator;
  /** Bearer token required for /metrics when set (defaults to env METRICS_TOKEN). */
  metricsToken?: string;
  gateway?: Partial<GatewayOptions>;
  /** Collect Node process metrics (main.ts enables it; tests leave it off). */
  defaultMetrics?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  metrics: Metrics;
  gateway: RealtimeGateway;
}

/** Allowed browser origins: PUBLIC_CLIENT_URL, plus the Vite dev server in development. */
export function allowedOrigins(deps: CoreDeps): string[] {
  const origins = new Set([deps.config.publicClientUrl.replace(/\/$/, '')]);
  if (deps.config.appEnv === 'development' || deps.config.appEnv === 'test') {
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
  }
  return [...origins];
}

export async function buildApp(deps: CoreDeps, opts: BuildAppOptions = {}): Promise<BuiltApp> {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: deps.config.trustProxy,
    genReqId: () => randomUUID(),
    requestIdLogLabel: 'reqId',
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 128 },
  });
  const metrics = createMetrics(deps.pool, { defaultMetrics: opts.defaultMetrics ?? false });
  const gateway = new RealtimeGateway(deps, metrics, {
    ...DEFAULT_GATEWAY_OPTIONS,
    ...opts.gateway,
  });
  const env: RouteEnv = {
    deps,
    metrics,
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...opts.rateLimits },
    steamValidator: opts.steamValidator ?? createSteamValidator(deps.config),
  };

  app.decorateRequest('auth', null);
  installErrorHandler(app);

  // Accept an empty body with a JSON content type (body-less commands such as /harvest).
  const defaultJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    defaultJson(req, text, done);
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        workerSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(cors, {
    origin: allowedOrigins(deps),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['Idempotent-Replayed', 'Retry-After', 'X-Request-Id'],
    maxAge: 600,
  });
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });

  app.addHook('onSend', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    metrics.httpDuration.observe(
      {
        method: req.method,
        route: req.routeOptions.url ?? 'unmatched',
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  registerOpsRoutes(app, env, { metricsToken: opts.metricsToken ?? process.env.METRICS_TOKEN });
  registerAuthRoutes(app, env);
  registerQueryRoutes(app, env);
  registerCommandRoutes(app, env);

  app.get('/api/v1/ws', { websocket: true }, (socket) => {
    gateway.handleConnection(socket);
  });
  app.addHook('onReady', async () => {
    await gateway.start();
  });
  app.addHook('onClose', async () => {
    await gateway.stop();
  });

  const clientDir = deps.config.serveClientDir ? path.resolve(deps.config.serveClientDir) : null;
  if (clientDir) {
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: '/',
      wildcard: true,
      index: false,
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const apiLike =
      req.url.startsWith('/api/') || req.url === '/metrics' || req.url.startsWith('/healthz');
    // SPA fallback: unknown GET pages render the client app.
    if (clientDir && req.method === 'GET' && !apiLike) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.status(404).send(notFoundBody(req.url.split('?')[0] ?? ''));
  });

  return { app, metrics, gateway };
}
