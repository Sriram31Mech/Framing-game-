import { dailyIrrigationCostPaise, getCrop } from '@bh/domain';
import { chunk } from '../effects';
import { chargeExpense } from '../postings';
import type { TickContext } from '../types';
import type { IrrigatedPlot } from './crops';
import type { MachineryEffects } from './machinery';

/**
 * Step 3 — irrigation running costs for plots that grew with irrigation on during day D.
 * Charged to the company (Dr expense_irrigation / Cr cash, may go negative) and added to each
 * plot's cost basis so it flows into inventory valuation at harvest.
 */
export async function chargeIrrigation(
  ctx: TickContext,
  plots: IrrigatedPlot[],
  effects: Map<string, MachineryEffects>,
): Promise<void> {
  const perCompany = new Map<string, number>();
  const plotCosts: { id: string; cost: number }[] = [];
  for (const p of plots) {
    const crop = getCrop(p.state.cropId);
    const mult = effects.get(p.companyId)?.irrigationCostMultiplier ?? 1;
    const cost = dailyIrrigationCostPaise(p.state, crop, p.env, mult);
    if (cost <= 0) continue;
    plotCosts.push({ id: p.plotId, cost });
    perCompany.set(p.companyId, (perCompany.get(p.companyId) ?? 0) + cost);
  }

  for (const batch of chunk(plotCosts, 500)) {
    await ctx.client.query(
      `UPDATE crop_plots p SET cost_basis_paise = p.cost_basis_paise + u.cost
       FROM unnest($1::uuid[], $2::bigint[]) AS u(id, cost) WHERE p.id = u.id`,
      [batch.map((b) => b.id), batch.map((b) => b.cost)],
    );
  }

  for (const [companyId, cost] of [...perCompany].sort(([a], [b]) => a.localeCompare(b))) {
    await chargeExpense(ctx, {
      companyId,
      account: 'expense_irrigation',
      amountPaise: cost,
      kind: 'irrigation',
      description: 'Daily irrigation costs',
      refType: 'company',
      refId: companyId,
    });
    ctx.stats.irrigationCharges++;
  }
}
