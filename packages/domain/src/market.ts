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

/** Initial state for an item at a market at world start. */
export function initialMarketItemState(
  market: MarketDefinition,
  crop: CropDefinition,
  day: GameDay,
): MarketItemState {
  void market;
  void crop;
  void day;
  throw new Error('not implemented');
}

/**
 * Daily price update: mean-reverts toward base * seasonal factor * market.priceScale,
 * pushed down by supply pressure relative to demand, small deterministic noise from `random`.
 * Supply pressure decays (~15%/day). Price is clamped to [0.4, 2.5] x base price.
 */
export function nextMarketItemState(
  state: MarketItemState,
  ctx: { market: MarketDefinition; crop: CropDefinition; day: GameDay; random: () => number },
): MarketItemState {
  void state;
  void ctx;
  throw new Error('not implemented');
}

/**
 * Quote selling `quantityKg` of `quality` (0..100) produce. Volume impact grows with
 * quantity relative to daily demand (average price over the sale, not just marginal).
 * Quality adjusts price between 0.7x (quality 0) and 1.1x (quality 100). Fee uses market.feeBps.
 * All money results are integers.
 */
export function quoteMarketSale(
  state: MarketItemState,
  market: MarketDefinition,
  quantityKg: Kg,
  quality: number,
): MarketSaleQuote {
  void state;
  void market;
  void quantityKg;
  void quality;
  throw new Error('not implemented');
}

/** Market state after absorbing a sale (adds supply pressure and moves price down accordingly). */
export function applyMarketSale(state: MarketItemState, quantityKg: Kg): MarketItemState {
  void state;
  void quantityKg;
  throw new Error('not implemented');
}

/** Hired transport cost for moving produce to a market. */
export function transportCostPaise(
  quantityKg: Kg,
  distanceKm: number,
  transportCostMultiplier?: number,
): Paise {
  void quantityKg;
  void distanceKm;
  void transportCostMultiplier;
  throw new Error('not implemented');
}

/** Anti-manipulation band for P2P prices. Returns [floor, ceiling] paise/kg. */
export function p2pPriceBand(bestMandiPricePaisePerKg: Paise): [Paise, Paise] {
  void bestMandiPricePaisePerKg;
  throw new Error('not implemented');
}

/** Value inventory at a conservative market price (used for valuation/balance sheet). */
export function inventoryValuePaise(
  itemId: ItemId,
  quantityKg: Kg,
  quality: number,
  pricePaisePerKg: Paise,
): Paise {
  void itemId;
  void quantityKg;
  void quality;
  void pricePaisePerKg;
  throw new Error('not implemented');
}
