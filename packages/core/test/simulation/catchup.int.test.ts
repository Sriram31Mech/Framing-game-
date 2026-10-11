/**
 * Offline catch-up correctness: from one saved starting state (same UUIDs, so the same RNG
 * streams), advancing 120 days one tick at a time, via batched catch-up, and via a catch-up that
 * crashes twice and resumes must all produce the identical world.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreDeps } from '../../src/commands/types';
import { computeBalanceSheet, loanOfferFor } from '../../src/companies/valuation';
import { catchUp } from '../../src/simulation/catchup';
import { advanceDay } from '../../src/simulation/tick';
import {
  assertInvariants,
  createHuman,
  execOk,
  gameDay,
  plantBest,
  REGION,
  restoreForkPoint,
  saveForkPoint,
  setupWorld,
  tickDays,
  worldSnapshot,
} from './helpers';

const DAYS = 120;
const FAR_FUTURE = new Date(Date.now() + 10 * 365 * 86_400_000);

describe('offline catch-up determinism and restart safety', () => {
  let deps: CoreDeps;
  let reference: Record<string, unknown>;

  beforeAll(async () => {
    deps = await setupWorld();
    const a = await createHuman(deps, 'Catchup Farms');
    const b = await createHuman(deps, 'Offline Agro');
    for (const companyId of [a, b]) {
      const { rows } = await deps.pool.query<{ id: string }>(
        'SELECT id FROM land_parcels WHERE owner_company_id = $1 ORDER BY id LIMIT 1',
        [companyId],
      );
      await plantBest(deps, companyId, rows[0]!.id);
    }
    // A loan exercises the EMI schedule; a lease adds leased hectares to land tax.
    const offer = loanOfferFor(await computeBalanceSheet(deps.pool, REGION, a));
    await execOk(deps, a, {
      type: 'take_loan',
      principalPaise: Math.min(100_000_00, offer.maxPrincipalPaise),
      termMonths: 6,
      expectedRateBps: offer.annualRateBps,
    });
    const { rows: forSale } = await deps.pool.query<{
      id: string;
      version: number;
      lease_rent_paise: number;
    }>(
      `SELECT id, version, lease_rent_paise FROM land_parcels
       WHERE region_id = $1 AND status = 'for_sale' AND owner_company_id IS NULL
       ORDER BY lease_rent_paise, id LIMIT 1`,
      [REGION],
    );
    const parcel = forSale[0]!;
    await execOk(deps, b, {
      type: 'lease_parcel',
      parcelId: parcel.id,
      expectedVersion: parcel.version,
      seasons: 1,
      expectedRentPaise: parcel.lease_rent_paise,
    });
    await saveForkPoint(deps.pool);
  });

  afterAll(async () => {
    await deps.pool.query('DROP SCHEMA IF EXISTS sim_fork CASCADE');
    await deps.pool.end();
  });

  it('world A: 120 single ticks', async () => {
    const start = await gameDay(deps);
    await tickDays(deps, DAYS);
    expect(await gameDay(deps)).toBe(start + DAYS);
    await assertInvariants(deps.pool);
    reference = await worldSnapshot(deps.pool);
    // The run must have exercised growth, loans and markets for the comparison to mean much.
    const plots = reference.plots as { status: string }[];
    expect(plots.length).toBeGreaterThan(0);
    const loans = reference.loans as { instalments_paid: number }[];
    expect(loans[0]!.instalments_paid).toBeGreaterThan(0);
  });

  it('world B: same start, batched offline catch-up → identical world', async () => {
    await restoreForkPoint(deps.pool);
    const start = await gameDay(deps);
    let done = 0;
    while (done < DAYS) {
      const r = await catchUp(deps, REGION, {
        now: FAR_FUTURE,
        maxDays: Math.min(25, DAYS - done),
      });
      expect(r.daysAdvanced).toBeGreaterThan(0);
      done += r.daysAdvanced;
    }
    expect(await gameDay(deps)).toBe(start + DAYS);
    expect(await worldSnapshot(deps.pool)).toEqual(reference);
  });

  it('world C: catch-up that crashes twice and resumes → identical world', async () => {
    await restoreForkPoint(deps.pool);
    const start = await gameDay(deps);
    // Crash 1: the process dies right after day 37 committed (between ticks).
    let seen = 0;
    await expect(
      catchUp(deps, REGION, {
        now: FAR_FUTURE,
        maxDays: DAYS,
        onDay: () => {
          seen++;
          if (seen === 37) throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow('simulated crash');
    expect(await gameDay(deps)).toBe(start + 37);
    // Crash 2: the process dies inside the next tick's transaction (before COMMIT).
    await expect(advanceDay(deps, REGION, { failBeforeCommit: true })).rejects.toThrow();
    expect(await gameDay(deps)).toBe(start + 37);
    // Resume.
    let done = 37;
    while (done < DAYS) {
      const r = await catchUp(deps, REGION, { now: FAR_FUTURE, maxDays: DAYS - done });
      done += r.daysAdvanced;
    }
    expect(await worldSnapshot(deps.pool)).toEqual(reference);
    await assertInvariants(deps.pool);
  });
});
