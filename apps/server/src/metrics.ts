/**
 * Prometheus metrics (prom-client). One registry per app instance so tests can build many apps.
 */
import type { DbPool } from '@bh/core';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpDuration: Histogram<'method' | 'route' | 'status_code'>;
  commandOutcomes: Counter<'type' | 'result'>;
  wsConnections: Gauge;
  wsEventsSent: Counter;
}

export function createMetrics(pool: DbPool, opts: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  if (opts.defaultMetrics) collectDefaultMetrics({ register: registry, prefix: 'bh_server_' });

  const httpDuration = new Histogram({
    name: 'bh_http_request_duration_seconds',
    help: 'HTTP request duration by route and status',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const commandOutcomes = new Counter({
    name: 'bh_command_outcomes_total',
    help: 'Command outcomes by command type and result (ok, replayed or error code)',
    labelNames: ['type', 'result'] as const,
    registers: [registry],
  });
  const wsConnections = new Gauge({
    name: 'bh_ws_connections',
    help: 'Open realtime WebSocket connections',
    registers: [registry],
  });
  const wsEventsSent = new Counter({
    name: 'bh_ws_events_sent_total',
    help: 'Realtime events delivered to sockets',
    registers: [registry],
  });
  new Gauge({
    name: 'bh_db_pool_connections',
    help: 'Database pool connections by state',
    labelNames: ['state'] as const,
    registers: [registry],
    collect() {
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
    },
  });
  return { registry, httpDuration, commandOutcomes, wsConnections, wsEventsSent };
}
