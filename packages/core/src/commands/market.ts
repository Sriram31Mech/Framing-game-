/**
 * Mandi (market) sales. docs/IMPLEMENTATION.md §4 "Mandi sale".
 * Price, fee and transport are always computed server-side; the client only sends a slippage
 * guard (minNetUnitPricePaise).
 */
import {
  applyMarketSale,
  quoteMarketSale,
  transportCostPaise,
  type MarketDefinition,
  type MarketItemState,
} from '@bh/domain';
import { companyDistanceToMarketKm } from '../world/parcels';
import { getMarket, getMarketItemState } from '../world/region';
import { machineryEffectsFor } from '../companies/company';
import type { Queryable } from '../db/pool';
import { DomainError, ruleViolation } from '../errors';
import { emitEvent } from '../events/events';
import { postLedger } from '../ledger/ledger';
import { lockParties, weightedQuality, type CommandContext } from './context';
import { applyTakes, lockAvailableLots, planTakes, type LotTake } from './inventory';
import type { GameCommand } from './types';

type Cmd<T extends GameCommand['type']> = Extract<GameCommand, { type: T }>;

export interface MarketSaleCalc {
  quantityKg: number;
  quality: number;
  unitPricePaise: number;
  grossPaise: number;
  feePaise: number;
  transportPaise: number;
  netPaise: number;
  priceImpactPct: number;
  distanceKm: number;
}

/** Full quote for selling `quantityKg` of produce of `quality` into a market. */
export async function computeMarketSale(
  db: Queryable,
  companyId: string,
  market: MarketDefinition,
  state: MarketItemState,
  quantityKg: number,
  quality: number,
): Promise<MarketSaleCalc> {
  const quote = quoteMarketSale(state, market, quantityKg, quality);
  const distanceKm = await companyDistanceToMarketKm(db, companyId, market);
  const effects = await machineryEffectsFor(db, companyId);
  const transport = transportCostPaise(quantityKg, distanceKm, effects.transportCostMultiplier);
  return {
    quantityKg,
    quality,
    unitPricePaise: quote.unitPricePaise,
    grossPaise: quote.grossPaise,
    feePaise: quote.feePaise,
    transportPaise: transport,
    netPaise: quote.netPaise - transport,
    priceImpactPct: quote.priceImpactPct,
    distanceKm,
  };
}

/** Quality of the stock a sale of `quantityKg` would consume (lowest quality first). */
export function qualityOfTakes(takes: LotTake[]): number {
  return weightedQuality(takes.map((t) => ({ quality: t.lot.quality, kg: t.kg })));
}

export async function sellToMarket(ctx: CommandContext, cmd: Cmd<'sell_to_market'>) {
  const me = ctx.actor.companyId;
  const market = await getMarket(ctx.client, ctx.regionId, cmd.marketId);
  // Sales into one market item are serialised so each sees the price impact of the previous one.
  const state = await getMarketItemState(ctx.client, market.id, cmd.itemId, {
    forUpdate: true,
  });
  await lockParties(ctx);
  const lots = await lockAvailableLots(ctx, me, cmd.itemId, 'market');
  const takes = planTakes(lots, cmd.quantityKg);
  const quality = qualityOfTakes(takes);

  const sale = await computeMarketSale(ctx.client, me, market, state, cmd.quantityKg, quality);
  if (sale.netPaise <= 0) {
    throw ruleViolation('After fees and transport this sale would earn nothing', { sale });
  }
  const netUnit = Math.floor(sale.netPaise / sale.quantityKg);
  if (netUnit < cmd.minNetUnitPricePaise) {
    throw new DomainError('PRICE_CHANGED', 'The price moved below your minimum; review and retry', {
      minNetUnitPricePaise: cmd.minNetUnitPricePaise,
      netUnitPricePaise: netUnit,
      quote: sale,
    });
  }

  await applyTakes(ctx, takes);
  const costRelieved = takes.reduce((s, t) => s + t.costPaise, 0);

  const next = applyMarketSale(state, cmd.quantityKg);
  await ctx.client.query(
    `UPDATE market_item_states SET price_paise_per_kg = $3, supply_pressure_kg = $4, demand_kg_per_day = $5,
       version = version + 1
     WHERE market_id = $1 AND item_id = $2`,
    [
      market.id,
      cmd.itemId,
      Math.max(1, Math.round(next.pricePaisePerKg)),
      Math.max(0, Math.round(next.supplyPressureKg)),
      Math.max(0, Math.round(next.demandKgPerDay)),
    ],
  );

  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO trades (region_id, kind, market_id, buyer_company_id, seller_company_id, item_id,
       quantity_kg, quality, unit_price_paise, gross_paise, fee_paise, transport_paise, game_day)
     VALUES ($1, 'market_sale', $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      ctx.regionId,
      market.id,
      me,
      cmd.itemId,
      sale.quantityKg,
      sale.quality,
      Math.max(1, sale.unitPricePaise),
      sale.grossPaise,
      sale.feePaise,
      sale.transportPaise,
      ctx.day,
    ],
  );
  const tradeId = rows[0]!.id;

  await postLedger(ctx.client, {
    regionId: ctx.regionId,
    kind: 'market_sale',
    description: `Sold ${sale.quantityKg} kg ${cmd.itemId} at ${market.name}`,
    gameDay: ctx.day,
    refType: 'trade',
    refId: tradeId,
    entries: [
      { companyId: me, account: 'cash', amountPaise: sale.netPaise },
      { companyId: me, account: 'expense_fees', amountPaise: sale.feePaise },
      { companyId: me, account: 'expense_transport', amountPaise: sale.transportPaise },
      { companyId: me, account: 'revenue_sales', amountPaise: -sale.grossPaise },
      { companyId: me, account: 'cogs', amountPaise: costRelieved },
      { companyId: me, account: 'inventory', amountPaise: -costRelieved },
    ],
  });

  await emitEvent(ctx.client, {
    regionId: ctx.regionId,
    type: 'market.price_updated',
    gameDay: ctx.day,
    companyId: null,
    actorCompanyId: me,
    entityType: 'market',
    entityId: market.id,
    payload: {
      marketId: market.id,
      prices: [
        { itemId: cmd.itemId, pricePaisePerKg: Math.max(1, Math.round(next.pricePaisePerKg)) },
      ],
    },
  });
  await emitEvent(ctx.client, {
    regionId: ctx.regionId,
    type: 'trade.completed',
    gameDay: ctx.day,
    companyId: me,
    actorCompanyId: me,
    entityType: 'trade',
    entityId: tradeId,
    payload: {
      tradeId,
      itemId: cmd.itemId,
      quantityKg: sale.quantityKg,
      totalPaise: sale.netPaise,
      role: 'seller',
      marketId: market.id,
    },
  });
  return { tradeId, marketId: market.id, itemId: cmd.itemId, ...sale };
}
