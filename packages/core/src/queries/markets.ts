/**
 * Market, trade and leaderboard queries (public region data, except the sale quote which uses
 * the caller's own stock).
 */
import type {
  ContractsResponse,
  LeaderboardResponse,
  ListingsResponse,
  MarketsResponse,
  PriceHistoryResponse,
  SaleQuoteResponse,
} from '@bh/contracts';
import { getCrop, mulPaise, type ItemId } from '@bh/domain';
import type { AuthContext } from '../auth/sessions';
import { computeMarketSale } from '../commands/market';
import type { CoreDeps } from '../commands/types';
import { computeBalanceSheets } from '../companies/valuation';
import { insufficientStock } from '../errors';
import { getCurrentGameDay } from '../world/clock';
import { getMarket, getMarketItemState, listMarketItemStates, listMarkets } from '../world/region';
import { requireCompany } from './common';

/** Percentage change, one decimal. */
const pctChange = (from: number, to: number) =>
  from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : 0;

export async function getMarkets(deps: CoreDeps, auth: AuthContext): Promise<MarketsResponse> {
  const day = await getCurrentGameDay(deps.pool, auth.regionId);
  const [markets, states, past] = await Promise.all([
    listMarkets(deps.pool, auth.regionId),
    listMarketItemStates(deps.pool, auth.regionId),
    // Price ~7 days ago: the latest snapshot at or before day − 7 (or the oldest available).
    deps.pool.query<{ market_id: string; item_id: ItemId; price: number }>(
      `SELECT DISTINCT ON (s.market_id, s.item_id) s.market_id, s.item_id, s.price_paise_per_kg AS price
       FROM market_price_snapshots s JOIN markets m ON m.id = s.market_id
       WHERE m.region_id = $1 AND s.game_day >= $2 - 7
       ORDER BY s.market_id, s.item_id, s.game_day ASC`,
      [auth.regionId, day],
    ),
  ]);
  const pastBy = new Map(past.rows.map((r) => [`${r.market_id}/${r.item_id}`, Number(r.price)]));
  return {
    markets: markets.map((m) => ({
      id: m.id,
      name: m.name,
      x: m.x,
      y: m.y,
      feeBps: m.feeBps,
      demandScale: m.demandScale,
      priceScale: m.priceScale,
      prices: states
        .filter((s) => s.marketId === m.id)
        .map((s) => ({
          itemId: s.itemId,
          pricePaisePerKg: s.pricePaisePerKg,
          basePricePaisePerKg: mulPaise(getCrop(s.itemId).basePricePaisePerKg, m.priceScale),
          demandKgPerDay: Math.max(0, Math.round(s.demandKgPerDay)),
          changePct7d: pctChange(
            pastBy.get(`${m.id}/${s.itemId}`) ?? s.pricePaisePerKg,
            s.pricePaisePerKg,
          ),
        })),
    })),
  };
}

export async function getPriceHistory(
  deps: CoreDeps,
  auth: AuthContext,
  marketId: string,
  q: { itemId?: ItemId; days: number },
): Promise<PriceHistoryResponse> {
  await getMarket(deps.pool, auth.regionId, marketId);
  const day = await getCurrentGameDay(deps.pool, auth.regionId);
  const { rows } = await deps.pool.query<{
    item_id: ItemId;
    game_day: number;
    price_paise_per_kg: number;
    volume_kg: number;
  }>(
    `SELECT item_id, game_day, price_paise_per_kg, volume_kg FROM market_price_snapshots
     WHERE market_id = $1 AND ($2::text IS NULL OR item_id = $2) AND game_day > $3
     ORDER BY item_id, game_day`,
    [marketId, q.itemId ?? null, day - q.days],
  );
  const series = new Map<ItemId, PriceHistoryResponse['series'][number]['points']>();
  for (const r of rows) {
    const points = series.get(r.item_id) ?? [];
    points.push({ day: r.game_day, pricePaisePerKg: r.price_paise_per_kg, volumeKg: r.volume_kg });
    series.set(r.item_id, points);
  }
  return { marketId, series: [...series].map(([itemId, points]) => ({ itemId, points })) };
}

/** What selling `quantityKg` of the caller's available stock into this market would yield now. */
export async function getSaleQuote(
  deps: CoreDeps,
  auth: AuthContext,
  marketId: string,
  q: { itemId: ItemId; quantityKg: number },
): Promise<SaleQuoteResponse> {
  const companyId = requireCompany(auth);
  const day = await getCurrentGameDay(deps.pool, auth.regionId);
  const market = await getMarket(deps.pool, auth.regionId, marketId);
  const state = await getMarketItemState(deps.pool, marketId, q.itemId);
  // Same consumption order as the sale itself: lowest quality first, then oldest.
  const { rows } = await deps.pool.query<{ quality: number; available: number }>(
    `SELECT quality, (quantity_kg - reserved_kg) AS available FROM inventory_lots
     WHERE company_id = $1 AND item_id = $2 AND quantity_kg > reserved_kg AND expires_day >= $3
     ORDER BY quality ASC, produced_day ASC, id ASC`,
    [companyId, q.itemId, day],
  );
  let remaining = q.quantityKg;
  let weighted = 0;
  for (const r of rows) {
    if (remaining === 0) break;
    const take = Math.min(remaining, Number(r.available));
    weighted += take * r.quality;
    remaining -= take;
  }
  if (remaining > 0) throw insufficientStock(q.quantityKg, q.quantityKg - remaining);
  const quality = Math.round(weighted / q.quantityKg);
  const sale = await computeMarketSale(deps.pool, companyId, market, state, q.quantityKg, quality);
  return {
    marketId,
    itemId: q.itemId,
    quantityKg: sale.quantityKg,
    quality: sale.quality,
    unitPricePaise: sale.unitPricePaise,
    grossPaise: sale.grossPaise,
    feePaise: sale.feePaise,
    transportPaise: sale.transportPaise,
    netPaise: sale.netPaise,
    priceImpactPct: sale.priceImpactPct,
  };
}

export async function getListings(
  deps: CoreDeps,
  auth: AuthContext,
  q: {
    itemId?: ItemId;
    mine: boolean;
    status: 'open' | 'filled' | 'cancelled' | 'expired';
    limit: number;
  },
): Promise<ListingsResponse> {
  const seller = q.mine ? requireCompany(auth) : null;
  const { rows } = await deps.pool.query<{
    id: string;
    seller_company_id: string;
    seller_name: string;
    item_id: ItemId;
    quality: number;
    quantity_kg: number;
    remaining_kg: number;
    unit_price_paise: number;
    status: 'open' | 'filled' | 'cancelled' | 'expired';
    created_day: number;
    expires_day: number;
    version: number;
  }>(
    `SELECT l.id, l.seller_company_id, c.name AS seller_name, l.item_id, l.quality, l.quantity_kg,
            l.remaining_kg, l.unit_price_paise, l.status, l.created_day, l.expires_day, l.version
     FROM market_listings l JOIN companies c ON c.id = l.seller_company_id
     WHERE l.region_id = $1 AND l.status = $2
       AND ($3::text IS NULL OR l.item_id = $3) AND ($4::uuid IS NULL OR l.seller_company_id = $4)
     ORDER BY ${q.status === 'open' ? 'l.item_id, l.unit_price_paise ASC, l.created_at ASC' : 'l.created_at DESC'}
     LIMIT $5`,
    [auth.regionId, q.status, q.itemId ?? null, seller, q.limit],
  );
  return {
    listings: rows.map((r) => ({
      id: r.id,
      sellerCompanyId: r.seller_company_id,
      sellerName: r.seller_name,
      itemId: r.item_id,
      quality: r.quality,
      quantityKg: r.quantity_kg,
      remainingKg: r.remaining_kg,
      unitPricePaise: r.unit_price_paise,
      status: r.status,
      createdDay: r.created_day,
      expiresDay: r.expires_day,
      version: r.version,
    })),
  };
}

export async function getContracts(
  deps: CoreDeps,
  auth: AuthContext,
  q: { scope: 'open' | 'mine'; limit: number },
): Promise<ContractsResponse> {
  const me = q.scope === 'mine' ? requireCompany(auth) : null;
  const { rows } = await deps.pool.query<{
    id: string;
    buyer_company_id: string;
    buyer_name: string;
    seller_company_id: string | null;
    seller_name: string | null;
    item_id: ItemId;
    quantity_kg: number;
    min_quality: number;
    unit_price_paise: number;
    total_paise: number;
    delivery_by_day: number;
    created_day: number;
    accepted_day: number | null;
    settled_day: number | null;
    status: ContractsResponse['contracts'][number]['status'];
    terms_hash: string;
    version: number;
  }>(
    `SELECT k.id, k.buyer_company_id, b.name AS buyer_name, k.seller_company_id, s.name AS seller_name,
            k.item_id, k.quantity_kg, k.min_quality, k.unit_price_paise, k.total_paise, k.delivery_by_day,
            k.created_day, k.accepted_day, k.settled_day, k.status, k.terms_hash, k.version
     FROM contracts k
     JOIN companies b ON b.id = k.buyer_company_id
     LEFT JOIN companies s ON s.id = k.seller_company_id
     WHERE k.region_id = $1
       AND (CASE WHEN $2::uuid IS NULL THEN k.status = 'open'
                 ELSE (k.buyer_company_id = $2 OR k.seller_company_id = $2) END)
     ORDER BY ${me ? 'k.updated_at DESC' : 'k.delivery_by_day ASC, k.created_at ASC'}
     LIMIT $3`,
    [auth.regionId, me, q.limit],
  );
  return {
    contracts: rows.map((r) => ({
      id: r.id,
      buyerCompanyId: r.buyer_company_id,
      buyerName: r.buyer_name,
      sellerCompanyId: r.seller_company_id,
      sellerName: r.seller_name,
      itemId: r.item_id,
      quantityKg: r.quantity_kg,
      minQuality: r.min_quality,
      unitPricePaise: r.unit_price_paise,
      totalPaise: r.total_paise,
      deliveryByDay: r.delivery_by_day,
      createdDay: r.created_day,
      acceptedDay: r.accepted_day,
      settledDay: r.settled_day,
      status: r.status,
      termsHash: r.terms_hash,
      version: r.version,
    })),
  };
}

export async function getLeaderboard(
  deps: CoreDeps,
  auth: AuthContext,
): Promise<LeaderboardResponse> {
  const [sheets, companies] = await Promise.all([
    computeBalanceSheets(deps.pool, auth.regionId),
    deps.pool.query<{ id: string; name: string; kind: 'human' | 'ai' }>(
      'SELECT id, name, kind FROM companies WHERE region_id = $1',
      [auth.regionId],
    ),
  ]);
  const entries = companies.rows
    .map((c) => {
      const s = sheets.get(c.id);
      return {
        companyId: c.id,
        name: c.name,
        kind: c.kind,
        valuationPaise: s?.valuationPaise ?? 0,
        landHa: s?.landHa ?? 0,
      };
    })
    .sort((a, b) => b.valuationPaise - a.valuationPaise || a.name.localeCompare(b.name));
  return { entries: entries.map((e, i) => ({ rank: i + 1, ...e })) };
}
