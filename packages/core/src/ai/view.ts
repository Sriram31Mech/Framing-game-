/**
 * Read model for AI companies: everything `decideAiActions` may look at, built from committed
 * state with a handful of set-based queries. AI companies see exactly what a player could see
 * through the public API for their own company (no hidden information).
 */
import type {
  AiPersonality,
  AiWorldView,
  CropId,
  CropPlotState,
  CropPlotStatus,
  ItemId,
  MarketDefinition,
  ParcelEnvironment,
  RegionClimate,
} from '@bh/domain';
import { ITEM_IDS, MIN_LOAN_CAP_PAISE } from '@bh/domain';
import type { Queryable } from '../db/pool';
import { notFound } from '../errors';
import { companyDistanceToMarketKm } from '../world/parcels';

interface HeldParcelRow {
  id: string;
  env: ParcelEnvironment;
  leased: boolean;
  plot_id: string | null;
  crop_id: CropId | null;
  plot_status: CropPlotStatus | null;
  state: CropPlotState | null;
}

/** Maximum holdings for sale an AI company evaluates per day. */
const AI_LAND_SHORTLIST = 30;

export async function buildAiWorldView(
  db: Queryable,
  companyId: string,
  gameDay: number,
): Promise<AiWorldView> {
  const { rows: companyRows } = await db.query<{
    id: string;
    region_id: string;
    ai_personality: AiPersonality | null;
    cash_paise: number;
  }>('SELECT id, region_id, ai_personality, cash_paise FROM companies WHERE id = $1', [companyId]);
  const company = companyRows[0];
  if (!company) throw notFound('Company', companyId);
  const regionId = company.region_id;

  const [region, loans, held, forSale, inventory, markets] = await Promise.all([
    db.query<{ climate: RegionClimate }>('SELECT climate FROM regions WHERE id = $1', [regionId]),
    db.query<{ total: number }>(
      `SELECT COALESCE(SUM(outstanding_paise), 0)::bigint AS total
       FROM loans WHERE company_id = $1 AND status = 'active'`,
      [companyId],
    ),
    db.query<HeldParcelRow>(
      `SELECT p.id, p.env, (l.id IS NOT NULL) AS leased,
              cp.id AS plot_id, cp.crop_id, cp.status AS plot_status, cp.state
       FROM land_parcels p
       LEFT JOIN land_leases l ON l.parcel_id = p.id AND l.status = 'active'
       LEFT JOIN crop_plots cp ON cp.parcel_id = p.id AND cp.status IN ('growing', 'ready', 'failed')
       WHERE p.region_id = $1
         AND ((p.owner_company_id = $2 AND l.id IS NULL) OR l.lessee_company_id = $2)
       ORDER BY p.id`,
      [regionId, companyId],
    ),
    db.query<{ id: string; env: ParcelEnvironment; price: number; version: number }>(
      `SELECT p.id, p.env, COALESCE(p.list_price_paise, p.base_price_paise) AS price, p.version
       FROM land_parcels p
       WHERE p.region_id = $1 AND p.status = 'for_sale'
         AND p.owner_company_id IS DISTINCT FROM $2
         AND NOT EXISTS (SELECT 1 FROM land_leases l WHERE l.parcel_id = p.id AND l.status = 'active')
         AND NOT EXISTS (SELECT 1 FROM crop_plots cp WHERE cp.parcel_id = p.id
                         AND cp.status IN ('growing', 'ready', 'failed'))
         AND COALESCE(p.list_price_paise, p.base_price_paise) <= $3
       ORDER BY COALESCE(p.list_price_paise, p.base_price_paise) / p.area_ha, p.id
       LIMIT ${AI_LAND_SHORTLIST}`,
      // Bounded rationality (and bounded cost): an AI only weighs a shortlist of the best-value
      // holdings it could plausibly afford, not every one of ~2,000 holdings in the state.
      [regionId, companyId, Math.max(0, company.cash_paise) + MIN_LOAN_CAP_PAISE],
    ),
    db.query<{ item_id: ItemId; available_kg: number; quality: number; expires_day: number }>(
      `SELECT item_id, SUM(quantity_kg - reserved_kg)::bigint AS available_kg,
              ROUND(SUM(quality * (quantity_kg - reserved_kg))::numeric
                    / NULLIF(SUM(quantity_kg - reserved_kg), 0))::int AS quality,
              MIN(expires_day) AS expires_day
       FROM inventory_lots
       WHERE company_id = $1 AND quantity_kg > reserved_kg AND expires_day >= $2
       GROUP BY item_id ORDER BY item_id`,
      [companyId, gameDay],
    ),
    db.query<{ definition: MarketDefinition; item_id: ItemId; price: number }>(
      `SELECT m.definition, s.item_id, s.price_paise_per_kg AS price
       FROM markets m JOIN market_item_states s ON s.market_id = m.id
       WHERE m.region_id = $1 ORDER BY m.id, s.item_id`,
      [regionId],
    ),
  ]);

  const climate = region.rows[0]?.climate;
  if (!climate) throw notFound('Region', regionId);

  const marketMap = new Map<string, { def: MarketDefinition; prices: Record<ItemId, number> }>();
  for (const row of markets.rows) {
    let entry = marketMap.get(row.definition.id);
    if (!entry) {
      const prices = Object.fromEntries(ITEM_IDS.map((id) => [id, 0])) as Record<ItemId, number>;
      entry = { def: row.definition, prices };
      marketMap.set(row.definition.id, entry);
    }
    entry.prices[row.item_id] = row.price;
  }

  return {
    companyId,
    personality: company.ai_personality ?? 'cautious',
    day: gameDay,
    cashPaise: company.cash_paise,
    loanOutstandingPaise: Number(loans.rows[0]?.total ?? 0),
    ownedParcels: held.rows.map((p) => ({
      parcelId: p.id,
      env: p.env,
      leased: p.leased,
      plot:
        p.plot_id && p.crop_id && p.plot_status
          ? {
              plotId: p.plot_id,
              cropId: p.crop_id,
              status: p.plot_status,
              irrigated: p.state?.irrigated ?? false,
              pestPressure: p.state?.pestPressure,
              pestControlDay: p.state?.pestControlDay ?? null,
            }
          : null,
    })),
    parcelsForSale: forSale.rows.map((p) => ({
      parcelId: p.id,
      env: p.env,
      pricePaise: Number(p.price),
      version: p.version,
    })),
    inventory: inventory.rows
      .filter((i) => Number(i.available_kg) > 0)
      .map((i) => ({
        itemId: i.item_id,
        availableKg: Number(i.available_kg),
        quality: i.quality,
        expiresDay: i.expires_day,
      })),
    markets: await Promise.all(
      [...marketMap.values()].map(async ({ def, prices }) => ({
        marketId: def.id,
        prices,
        // Same distance rule the backend uses to charge transport on a market sale.
        distanceKm: await companyDistanceToMarketKm(db, companyId, def),
      })),
    ),
    climate,
  };
}
