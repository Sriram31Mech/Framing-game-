import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** Prometheus metrics exported by the simulation worker. */
export function createWorkerMetrics() {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'bh-worker' });
  collectDefaultMetrics({ register: registry });

  return {
    registry,
    tickDuration: new Histogram({
      name: 'bh_worker_tick_duration_seconds',
      help: 'Duration of one simulated game day (advanceDay transaction)',
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    daysAdvanced: new Counter({
      name: 'bh_worker_days_advanced_total',
      help: 'Game days processed by this worker',
      registers: [registry],
    }),
    backlog: new Gauge({
      name: 'bh_worker_tick_backlog_days',
      help: 'Game days the world is behind the wall clock (target - current)',
      registers: [registry],
    }),
    gameDay: new Gauge({
      name: 'bh_worker_game_day',
      help: 'Current game day of the region',
      registers: [registry],
    }),
    lastTick: new Gauge({
      name: 'bh_worker_last_tick_timestamp_seconds',
      help: 'Unix time of the last committed game day',
      registers: [registry],
    }),
    leader: new Gauge({
      name: 'bh_worker_is_leader',
      help: '1 when this worker holds the simulation leadership lock',
      registers: [registry],
    }),
    loopErrors: new Counter({
      name: 'bh_worker_loop_errors_total',
      help: 'Failed worker iterations (retried with backoff)',
      labelNames: ['phase'] as const,
      registers: [registry],
    }),
    reconciliationIssues: new Gauge({
      name: 'bh_worker_reconciliation_issues',
      help: 'Problems found by the last reconciliation run, by kind (should be 0)',
      labelNames: ['kind'] as const,
      registers: [registry],
    }),
    ledgerMismatches: new Gauge({
      name: 'bh_worker_ledger_mismatches',
      help: 'Companies whose denormalised cash/escrow differ from the ledger (should be 0)',
      registers: [registry],
    }),
    aiCommands: new Counter({
      name: 'bh_worker_ai_commands_total',
      help: 'Commands submitted by AI companies',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    cleanupRows: new Counter({
      name: 'bh_worker_cleanup_rows_total',
      help: 'Rows removed by periodic cleanup',
      labelNames: ['table'] as const,
      registers: [registry],
    }),
  };
}

export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>;
