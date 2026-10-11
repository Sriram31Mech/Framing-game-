/**
 * AI intent → command mapping through the real command layer, with a scripted policy injected
 * in place of the domain's decideAiActions (so every intent kind is exercised deterministically).
 */
import {
  computeAllSuitability,
  cropDurationDays,
  getCrop,
  type AiIntent,
  type AiWorldView,
} from '@bh/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAiCompanies, type AiRunResult } from '../../src/ai/runner';
import type { CoreDeps } from '../../src/commands/types';
import { assertInvariants, gameDay, REGION, setupWorld, tickDays } from './helpers';

const script =
  (fn: (view: AiWorldView) => AiIntent[]) =>
  (view: AiWorldView, _random: () => number, max: number) =>
    fn(view).slice(0, max);

function sowablePlant(view: AiWorldView, parcelId: string): AiIntent {
  const parcel = view.ownedParcels.find((p) => p.parcelId === parcelId)!;
  const irrigate = parcel.env.waterAccess !== 'none';
  const crops = computeAllSuitability(parcel.env, view.climate, {
    sowingDay: view.day,
    irrigated: irrigate,
  }).filter((s) => s.sowingOpen && s.score > 0);
  crops.sort((a, b) => cropDurationDays(getCrop(a.cropId)) - cropDurationDays(getCrop(b.cropId)));
  return { kind: 'plant', parcelId, cropId: crops[0]!.cropId, irrigate, fertilize: true };
}

describe('AI intents execute through the command layer', () => {
  let deps: CoreDeps;
  let aiId: string;
  const run = async (fn: (view: AiWorldView) => AiIntent[]): Promise<AiRunResult> =>
    runAiCompanies(deps, REGION, await gameDay(deps), { decide: script(fn) });

  beforeAll(async () => {
    deps = await setupWorld({ aiCompanyCount: 1 });
    const { rows } = await deps.pool.query<{ id: string }>(
      `SELECT id FROM companies WHERE region_id = $1 AND kind = 'ai'`,
      [REGION],
    );
    aiId = rows[0]!.id;
  });
  afterAll(async () => {
    await deps.pool.end();
  });

  it('borrows, buys land and plants with server-matching expectations', async () => {
    const res = await run((view) => {
      const cheapest = [...view.parcelsForSale].sort((a, b) => a.pricePaise - b.pricePaise)[0]!;
      const pricey = [...view.parcelsForSale].sort((a, b) => b.pricePaise - a.pricePaise)[0]!;
      return [
        { kind: 'take_loan', principalPaise: 300_000_00, termMonths: 12 },
        {
          kind: 'buy_parcel',
          parcelId: cheapest.parcelId,
          expectedVersion: cheapest.version,
          maxPricePaise: cheapest.pricePaise,
        },
        // Above the AI's own limit: dropped before submission.
        {
          kind: 'buy_parcel',
          parcelId: pricey.parcelId,
          expectedVersion: pricey.version,
          maxPricePaise: pricey.pricePaise - 1,
        },
        sowablePlant(view, view.ownedParcels[0]!.parcelId),
      ];
    });
    expect(res).toMatchObject({ companies: 1, commands: 3, failures: 0, dropped: 1 });
    expect(res.byType).toEqual({ take_loan: 1, purchase_parcel: 1, plant: 1 });

    // Same day again: the company already acted → skipped, nothing re-submitted.
    const again = await run(() => [{ kind: 'take_loan', principalPaise: 1_000_00, termMonths: 1 }]);
    expect(again).toMatchObject({ companies: 0, skipped: 1, commands: 0 });
  });

  it('applies pest control, clears a plot and harvests when ready', async () => {
    await tickDays(deps, 1);
    const res = await run((view) => {
      const growing = view.ownedParcels.find((p) => p.plot?.status === 'growing')!;
      const idle = view.ownedParcels.find((p) => p.plot === null)!;
      return [
        { kind: 'pest_control', plotId: growing.plot!.plotId },
        sowablePlant(view, idle.parcelId),
      ];
    });
    expect(res.failures).toBe(0);
    expect(res.byType).toEqual({ plot_operation: 1, plant: 1 });

    await tickDays(deps, 1);
    const cleared = await run((view) => {
      const second = view.ownedParcels.filter((p) => p.plot?.status === 'growing')[1]!;
      return [{ kind: 'clear_plot', plotId: second.plot!.plotId }];
    });
    expect(cleared.byType).toEqual({ clear_plot: 1 });

    let harvested = 0;
    for (let i = 0; i < 200 && harvested === 0; i++) {
      await tickDays(deps, 1);
      const r = await run((view) =>
        view.ownedParcels
          .filter((p) => p.plot?.status === 'ready')
          .map((p): AiIntent => ({ kind: 'harvest', plotId: p.plot!.plotId })),
      );
      expect(r.failures).toBe(0);
      harvested = r.byType.harvest ?? 0;
    }
    expect(harvested).toBe(1);
  });

  it('sells to the mandi and lists produce for other players', async () => {
    await tickDays(deps, 1);
    const res = await run((view) => {
      const stock = view.inventory[0]!;
      const market = [...view.markets].sort(
        (a, b) => b.prices[stock.itemId] - a.prices[stock.itemId],
      )[0]!;
      const half = Math.floor(stock.availableKg / 2);
      return [
        { kind: 'sell_market', marketId: market.marketId, itemId: stock.itemId, quantityKg: half },
        {
          kind: 'create_listing',
          itemId: stock.itemId,
          quantityKg: Math.min(100, stock.availableKg - half),
          unitPricePaise: market.prices[stock.itemId],
          durationDays: 10,
        },
      ];
    });
    expect(res.failures).toBe(0);
    expect(res.byType).toEqual({ sell_to_market: 1, create_listing: 1 });
    const { rows } = await deps.pool.query(
      `SELECT 1 FROM trades WHERE seller_company_id = $1 AND kind = 'market_sale'`,
      [aiId],
    );
    expect(rows).toHaveLength(1);
    await assertInvariants(deps.pool);
  });
});
