import {
  catchUp,
  getWorldClock,
  runAiCompanies,
  runReconciliation,
  targetGameDay,
  type CoreDeps,
  type ReconciliationReport,
} from '@bh/core';
import type { LeaderLock } from './leader';
import { runCleanup } from './maintenance';
import type { WorkerMetrics } from './metrics';

/** Reconcile whenever the clock crosses a multiple of this many game days (and at startup). */
export const RECONCILE_EVERY_GAME_DAYS = 10;
/** Wall-clock interval between cleanup runs. */
export const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 60_000;

export interface WorkerStatus {
  leader: boolean;
  gameDay: number | null;
  targetDay: number | null;
  lagDays: number | null;
  lastTickAt: string | null;
  lastLoopAt: string | null;
  consecutiveFailures: number;
}

/**
 * The simulation worker loop. Each iteration (every WORKER_POLL_MS):
 *  1. ensure leadership (session advisory lock); followers idle;
 *  2. catch up the world clock in a bounded batch (MAX_CATCHUP_DAYS_PER_BATCH days);
 *  3. AI companies act once for the clock's current day — during a long catch-up that is the
 *     latest day of each batch only, which keeps AI work bounded (AI never replays the days it
 *     "slept" through; humans can't act on past days either);
 *  4. reconciliation at startup and every RECONCILE_EVERY_GAME_DAYS game days;
 *  5. cleanup every CLEANUP_INTERVAL_MS.
 * A failed iteration is logged and retried with exponential backoff; idempotent ticks and AI
 * idempotency keys make retries safe.
 */
export class SimulationWorker {
  private stopping = false;
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> | null = null;
  private lastAiDay: number | null = null;
  private reconciledAtStartup = false;
  private lastCleanupAt = 0;
  private failures = 0;
  readonly status: WorkerStatus = {
    leader: false,
    gameDay: null,
    targetDay: null,
    lagDays: null,
    lastTickAt: null,
    lastLoopAt: null,
    consecutiveFailures: 0,
  };

  constructor(
    private readonly deps: CoreDeps,
    private readonly leader: LeaderLock,
    private readonly metrics: WorkerMetrics,
  ) {}

  private get regionId(): string {
    return this.deps.config.regionId;
  }

  start(): void {
    if (this.loopDone) return;
    this.loopDone = this.loop();
  }

  /** Stop after the current iteration (a running tick always completes or rolls back). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loopDone;
    await this.leader.release();
    this.status.leader = false;
    this.metrics.leader.set(0);
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let delay = this.deps.config.workerPollMs;
      try {
        await this.runOnce();
        this.failures = 0;
      } catch (err) {
        this.failures++;
        this.metrics.loopErrors.inc({ phase: 'iteration' });
        delay = Math.min(MAX_BACKOFF_MS, this.deps.config.workerPollMs * 2 ** this.failures);
        this.deps.logger.error(
          { err, failures: this.failures, retryInMs: delay },
          'worker iteration failed',
        );
      }
      this.status.consecutiveFailures = this.failures;
      this.status.lastLoopAt = new Date().toISOString();
      if (!this.stopping) await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  /** One worker iteration; exposed for tests. */
  async runOnce(): Promise<void> {
    const isLeader = this.leader.isLeader
      ? await this.leader.verify()
      : await this.leader.tryAcquire();
    this.status.leader = isLeader;
    this.metrics.leader.set(isLeader ? 1 : 0);
    if (!isLeader) {
      await this.observeClock();
      return;
    }

    const { deps, regionId } = this;
    const before = await getWorldClock(deps.pool, regionId);
    if (!this.reconciledAtStartup) {
      await this.reconcile();
      this.reconciledAtStartup = true;
    }

    const batchStart = performance.now();
    const result = await catchUp(deps, regionId, {
      onDay: (day) => {
        this.metrics.tickDuration.observe(day.durationMs / 1000);
        this.metrics.daysAdvanced.inc();
        this.metrics.lastTick.set(Date.now() / 1000);
        this.status.lastTickAt = new Date().toISOString();
        deps.logger.info(
          { regionId, day: day.processedDay, durationMs: day.durationMs, stats: day.stats },
          'game day processed',
        );
      },
    });
    this.updateLag(result.gameDay, result.targetDay);
    if (result.daysAdvanced > 0) {
      deps.logger.info(
        {
          regionId,
          from: before.gameDay,
          to: result.gameDay,
          days: result.daysAdvanced,
          backlog: result.targetDay - result.gameDay,
          durationMs: Math.round(performance.now() - batchStart),
        },
        'catch-up batch committed',
      );
    }

    if (!result.paused && this.lastAiDay !== result.gameDay) {
      await this.runAi(result.gameDay);
    }

    const crossed =
      Math.floor(result.gameDay / RECONCILE_EVERY_GAME_DAYS) !==
      Math.floor(before.gameDay / RECONCILE_EVERY_GAME_DAYS);
    if (crossed) await this.reconcile();

    if (Date.now() - this.lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      await this.cleanup();
    }
  }

  private async observeClock(): Promise<void> {
    try {
      const clock = await getWorldClock(this.deps.pool, this.regionId);
      this.updateLag(clock.gameDay, targetGameDay(clock, new Date()));
    } catch {
      // Followers only report; the leader is responsible for the world.
    }
  }

  private updateLag(gameDay: number, targetDay: number): void {
    this.status.gameDay = gameDay;
    this.status.targetDay = targetDay;
    this.status.lagDays = Math.max(0, targetDay - gameDay);
    this.metrics.gameDay.set(gameDay);
    this.metrics.backlog.set(this.status.lagDays);
  }

  private async runAi(gameDay: number): Promise<void> {
    const t0 = performance.now();
    try {
      const ai = await runAiCompanies(this.deps, this.regionId, gameDay);
      this.lastAiDay = gameDay;
      const ok = Object.values(ai.byType).reduce((sum, n) => sum + n, 0);
      this.metrics.aiCommands.inc({ outcome: 'ok' }, ok);
      this.metrics.aiCommands.inc({ outcome: 'failed' }, ai.failures);
      this.metrics.aiCommands.inc({ outcome: 'dropped' }, ai.dropped);
      if (ai.companies > 0 || ai.failures > 0) {
        this.deps.logger.info(
          { gameDay, ...ai, durationMs: Math.round(performance.now() - t0) },
          'AI companies acted',
        );
      }
    } catch (err) {
      this.metrics.loopErrors.inc({ phase: 'ai' });
      this.deps.logger.error({ err, gameDay }, 'AI run failed');
    }
  }

  async reconcile(): Promise<ReconciliationReport | null> {
    try {
      const report = await runReconciliation(this.deps, this.regionId);
      for (const [kind, n] of Object.entries(report.counts)) {
        this.metrics.reconciliationIssues.set({ kind }, n);
      }
      this.metrics.ledgerMismatches.set(report.ledgerMismatches.length);
      return report;
    } catch (err) {
      this.metrics.loopErrors.inc({ phase: 'reconciliation' });
      this.deps.logger.error({ err }, 'reconciliation failed');
      return null;
    }
  }

  private async cleanup(): Promise<void> {
    this.lastCleanupAt = Date.now();
    try {
      const res = await runCleanup(this.deps.pool);
      this.metrics.cleanupRows.inc({ table: 'idempotency_keys' }, res.idempotencyKeys);
      this.metrics.cleanupRows.inc({ table: 'sessions' }, res.sessions);
      this.metrics.cleanupRows.inc({ table: 'domain_events' }, res.domainEvents);
      if (res.idempotencyKeys + res.sessions + res.domainEvents > 0) {
        this.deps.logger.info(res, 'cleanup removed old rows');
      }
    } catch (err) {
      this.metrics.loopErrors.inc({ phase: 'cleanup' });
      this.deps.logger.error({ err }, 'cleanup failed');
    }
  }
}
