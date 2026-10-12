import { monthOfDay } from './calendar';
import {
  P2P_PRICE_CEILING_MULTIPLIER,
  P2P_PRICE_FLOOR_MULTIPLIER,
  TRANSPORT_PAISE_PER_KG_KM,
} from './constants';
import { getCrop } from './crops';
import { applyBps, assertPaise, roundHalfAwayFromZero } from './money';
import type {
  CropDefinition,
  GameDay,
  ItemId,
  Kg,
  MarketDefinition,
  MarketItemState,
  MarketSaleQuote,
  Paise,
} from './types';

/*
 * Price model. Selling q kg into a market with daily demand D moves the price along
 *   P(q) = P0 / (1 + k·q/D)
 * so the average price realised over a sale of Q kg is P0 · ln(1 + x) / x with x = k·Q/D.
 * Sales add to supply pressure, which decays ~15% a day and depresses the mean-reversion
 * target by the same curve, so a dumped harvest depresses prices for about a week.
 *
 * Tamil Nadu has ONE statewide price per crop: every mandi quotes the same price and a sale at
 * any mandi moves it. Mandis differ only as delivery points (distance → transport, fee).
 * Statewide demand is the sum of every mandi's demand (`statewideDemandScale`).
 */

/** Price sensitivity k: selling one full day of demand at once ends ~26% below the start price. */
export const MARKET_IMPACT_COEFFICIENT = 0.35;
/** Fraction of supply pressure remaining after each day. */
export const SUPPLY_PRESSURE_RETENTION = 0.85;
/** Fraction of the gap to the target price closed each day. */
export const PRICE_MEAN_REVERSION = 0.15;
export const PRICE_FLOOR_MULTIPLIER = 0.4;
export const PRICE_CEILING_MULTIPLIER = 2.5;
/** Quality 0 sells at 0.7× and quality 100 at 1.1× the quoted price (quality 75 ≈ 1.0×). */
const QUALITY_MULTIPLIER_MIN = 0.7;
const QUALITY_MULTIPLIER_MAX = 1.1;

function clampPrice(crop: CropDefinition, price: number): Paise {
  const base = crop.basePricePaisePerKg;
  const clamped = Math.min(
    base * PRICE_CEILING_MULTIPLIER,
    Math.max(base * PRICE_FLOOR_MULTIPLIER, price),
  );
  return Math.max(1, roundHalfAwayFromZero(clamped));
}

/** Statewide seasonal reference price on `day` (base × seasonal factor). */
export function seasonalTargetPricePaise(crop: CropDefinition, day: GameDay): Paise {
  const seasonal = crop.seasonalPriceFactor[monthOfDay(day) - 1] ?? 1;
  return clampPrice(crop, crop.basePricePaisePerKg * seasonal);
}

/** Statewide demand multiplier: the sum of every mandi's share of demand. */
export function statewideDemandScale(markets: readonly MarketDefinition[]): number {
  return markets.reduce((sum, m) => sum + m.demandScale, 0);
}

/** Price multiplier for produce quality 0..100. */
export function qualityPriceMultiplier(quality: number): number {
  const q = Math.min(100, Math.max(0, quality)) / 100;
  return QUALITY_MULTIPLIER_MIN + (QUALITY_MULTIPLIER_MAX - QUALITY_MULTIPLIER_MIN) * q;
}

/** Average-price factor for selling `quantityKg` into `demandKgPerDay` (1 = no impact). */
function averageImpactFactor(quantityKg: Kg, demandKgPerDay: Kg): number {
  const x = (MARKET_IMPACT_COEFFICIENT * quantityKg) / Math.max(1, demandKgPerDay);
  return x < 1e-9 ? 1 : Math.log1p(x) / x;
}

/** Initial statewide state for an item at world start (`demandScale` from `statewideDemandScale`). */
export function initialMarketItemState(
  crop: CropDefinition,
  day: GameDay,
  demandScale: number,
): MarketItemState {
  return {
    itemId: crop.id,
    pricePaisePerKg: seasonalTargetPricePaise(crop, day),
    supplyPressureKg: 0,
    demandKgPerDay: Math.round(crop.baseDemandKgPerDay * demandScale),
  };
}

/**
 * Daily statewide price update: mean-reverts toward base * seasonal factor, pushed down by
 * supply pressure relative to (statewide) demand, small deterministic noise from `random`.
 * Supply pressure decays (~15%/day). Price is clamped to [0.4, 2.5] x base price.
 */
export function nextMarketItemState(
  state: MarketItemState,
  ctx: { crop: CropDefinition; day: GameDay; random: () => number },
): MarketItemState {
  const { crop, day, random } = ctx;
  const demandKgPerDay = state.demandKgPerDay;
  const supplyPressureKg = Math.floor(state.supplyPressureKg * SUPPLY_PRESSURE_RETENTION);
  const supplyFactor =
    1 / (1 + (MARKET_IMPACT_COEFFICIENT * supplyPressureKg) / Math.max(1, demandKgPerDay));
  const target =
    crop.basePricePaisePerKg * (crop.seasonalPriceFactor[monthOfDay(day) - 1] ?? 1) * supplyFactor;
  // Approximately normal noise (Irwin–Hall of three uniforms, unit variance).
  const noise = (random() + random() + random() - 1.5) * 2;
  const volatility = crop.priceVolatility ?? 0.01;
  const price =
    state.pricePaisePerKg +
    PRICE_MEAN_REVERSION * (target - state.pricePaisePerKg) +
    state.pricePaisePerKg * volatility * noise;
  return {
    itemId: state.itemId,
    pricePaisePerKg: clampPrice(crop, price),
    supplyPressureKg,
    demandKgPerDay,
  };
}

/**
 * Quote selling `quantityKg` of `quality` (0..100) produce. Volume impact grows with
 * quantity relative to daily demand (average price over the sale, not just marginal).
 * Quality adjusts price between 0.7x (quality 0) and 1.1x (quality 100). Fee uses market.feeBps.
 * All money results are integers: gross = unit price × quantity exactly.
 */
export function quoteMarketSale(
  state: MarketItemState,
  market: MarketDefinition,
  quantityKg: Kg,
  quality: number,
): MarketSaleQuote {
  if (!Number.isSafeInteger(quantityKg) || quantityKg < 0) {
    throw new RangeError(`quantityKg must be a non-negative integer, got ${quantityKg}`);
  }
  if (quantityKg === 0) {
    return {
      quantityKg: 0,
      unitPricePaise: 0,
      grossPaise: 0,
      feePaise: 0,
      netPaise: 0,
      priceImpactPct: 0,
    };
  }
  const impact = averageImpactFactor(quantityKg, state.demandKgPerDay);
  const unitPricePaise = roundHalfAwayFromZero(
    state.pricePaisePerKg * impact * qualityPriceMultiplier(quality),
  );
  const grossPaise = assertPaise(unitPricePaise * quantityKg, 'gross');
  const feePaise = applyBps(grossPaise, market.feeBps);
  return {
    quantityKg,
    unitPricePaise,
    grossPaise,
    feePaise,
    netPaise: grossPaise - feePaise,
    priceImpactPct: Math.round((1 - impact) * 10_000) / 100,
  };
}

/** Market state after absorbing a sale (adds supply pressure and moves price down accordingly). */
export function applyMarketSale(state: MarketItemState, quantityKg: Kg): MarketItemState {
  if (quantityKg <= 0) return state;
  const marginal =
    1 / (1 + (MARKET_IMPACT_COEFFICIENT * quantityKg) / Math.max(1, state.demandKgPerDay));
  const crop = getCrop(state.itemId);
  return {
    ...state,
    pricePaisePerKg: clampPrice(crop, state.pricePaisePerKg * marginal),
    supplyPressureKg: state.supplyPressureKg + quantityKg,
  };
}

/** Hired transport cost for moving produce to a market. */
export function transportCostPaise(
  quantityKg: Kg,
  distanceKm: number,
  transportCostMultiplier?: number,
): Paise {
  if (quantityKg <= 0 || distanceKm <= 0) return 0;
  return assertPaise(
    roundHalfAwayFromZero(
      quantityKg * distanceKm * TRANSPORT_PAISE_PER_KG_KM * (transportCostMultiplier ?? 1),
    ),
    'transport cost',
  );
}

/** Anti-manipulation band for P2P prices around the statewide price. Returns [floor, ceiling] paise/kg. */
export function p2pPriceBand(statewidePricePaisePerKg: Paise): [Paise, Paise] {
  const reference = Math.max(1, statewidePricePaisePerKg);
  return [
    Math.max(1, Math.floor(reference * P2P_PRICE_FLOOR_MULTIPLIER)),
    Math.ceil(reference * P2P_PRICE_CEILING_MULTIPLIER),
  ];
}

/** Valuation haircut: perishables (short shelf life) are marked down harder. */
const INVENTORY_HAIRCUT = 0.9;
const PERISHABLE_INVENTORY_HAIRCUT = 0.75;
const PERISHABLE_SHELF_LIFE_DAYS = 30;

/** Value inventory at a conservative market price (used for valuation/balance sheet). */
export function inventoryValuePaise(
  itemId: ItemId,
  quantityKg: Kg,
  quality: number,
  pricePaisePerKg: Paise,
): Paise {
  if (quantityKg <= 0) return 0;
  const haircut =
    getCrop(itemId).shelfLifeDays < PERISHABLE_SHELF_LIFE_DAYS
      ? PERISHABLE_INVENTORY_HAIRCUT
      : INVENTORY_HAIRCUT;
  return assertPaise(
    roundHalfAwayFromZero(quantityKg * pricePaisePerKg * qualityPriceMultiplier(quality) * haircut),
    'inventory value',
  );
}
