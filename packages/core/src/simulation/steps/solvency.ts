import { evaluateSolvency, type CompanyStatus } from '@bh/domain';
import { tickNotify } from '../effects';
import type { TickContext } from '../types';
import { liquidateCompany } from './liquidation';

/** Grace-period milestones (days remaining) at which a distressed company is warned. */
export const DISTRESS_WARNING_DAYS = [14, 7, 3, 1] as const;

/**
 * Step 11 — solvency for every company in the region via `evaluateSolvency`:
 * negative cash → distressed (grace period starts), positive again → active, still negative
 * after the grace period → bankrupt, which immediately liquidates and restarts the company.
 * Warnings on entering distress and at 14/7/3/1 days remaining are deduplicated per episode.
 */
export async function evaluateCompanies(ctx: TickContext): Promise<void> {
  const { rows } = await ctx.client.query<{
    id: string;
    cash_paise: number;
    status: CompanyStatus;
    distress_since_day: number | null;
  }>(
    `SELECT id, cash_paise, status, distress_since_day FROM companies WHERE region_id = $1 ORDER BY id`,
    [ctx.regionId],
  );
  for (const co of rows) {
    const r = evaluateSolvency({
      cashPaise: co.cash_paise,
      status: co.status,
      distressSinceDay: co.distress_since_day,
      day: ctx.day,
    });

    if (r.status === 'bankrupt') {
      ctx.stats.bankruptcies++;
      await liquidateCompany(ctx, co.id);
      ctx.touchedCompanies.add(co.id);
      continue;
    }

    if (r.status !== co.status || r.distressSinceDay !== co.distress_since_day) {
      await ctx.client.query(
        `UPDATE companies SET status = $2, distress_since_day = $3, version = version + 1 WHERE id = $1`,
        [co.id, r.status, r.distressSinceDay],
      );
      ctx.touchedCompanies.add(co.id);
    }

    if (r.status === 'distressed') {
      const since = r.distressSinceDay ?? ctx.day;
      const remaining = r.graceDaysRemaining;
      if (co.status !== 'distressed') {
        ctx.stats.companiesDistressed++;
        await tickNotify(ctx, {
          companyId: co.id,
          type: 'distress',
          severity: 'danger',
          title: 'Company in financial distress',
          body:
            `Your cash balance is negative. Restore a positive balance within ${remaining ?? 'the grace period'} days ` +
            'by selling produce or assets, or your company will be declared bankrupt and liquidated.',
          entityType: 'company',
          entityId: co.id,
          dedupeKey: `distress:${since}`,
        });
      } else if (
        remaining !== null &&
        (DISTRESS_WARNING_DAYS as readonly number[]).includes(remaining)
      ) {
        await tickNotify(ctx, {
          companyId: co.id,
          type: 'distress_warning',
          severity: 'danger',
          title: `Bankruptcy in ${remaining} day${remaining === 1 ? '' : 's'}`,
          body: `Your cash is still negative. Without a positive balance in ${remaining} day${remaining === 1 ? '' : 's'}, your assets will be liquidated.`,
          entityType: 'company',
          entityId: co.id,
          dedupeKey: `distress:${since}:${remaining}`,
        });
      }
    } else if (co.status === 'distressed' && r.status === 'active') {
      ctx.stats.companiesRecovered++;
      await tickNotify(ctx, {
        companyId: co.id,
        type: 'distress_recovered',
        severity: 'success',
        title: 'Back in the black',
        body: 'Your cash balance is positive again; the bankruptcy countdown has been cancelled.',
        entityType: 'company',
        entityId: co.id,
        dedupeKey: `recovered:${co.distress_since_day ?? ctx.day}`,
      });
    }
  }
}
