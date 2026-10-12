import { monthOfDay } from './calendar';
import {
  MIN_LOAN_CAP_PAISE,
  PEST_CONTROL_PROTECTION_DAYS,
  TRANSPORT_PAISE_PER_KG_KM,
} from './constants';
import {
  CROPS,
  cropDurationDays,
  estimateCropEconomics,
  harvestCostPaise,
  isSowingOpen,
  pestControlCostPaise,
} from './crops';
import { canIrrigate, irrigationSourceCostFactor, unfertilizedYieldPenalty } from './growth';
import { p2pPriceBand, qualityPriceMultiplier } from './market';
import { computeAllSuitability, computeSuitability } from './suitability';
import { climateForEnv } from './tamilnadu';
import {
  CROP_IDS,
  type AiIntent,
  type AiPersonality,
  type AiWorldView,
  type CropDefinition,
  type CropId,
  type ParcelEnvironment,
  type Paise,
} from './types';

interface PersonalityProfile {
  /** Cash kept back from discretionary spending (planting, land). */
  cashBufferPaise: Paise;
  /** Sell at the mandi when the best price is at least this multiple of the crop's base price. */
  sellAtBaseRatio: number;
  /** Minimum suitability score to plant a crop or buy land for it. */
  minPlantScore: number;
  /** Minimum expected profit / cost for a planting. */
  minPlantMargin: number;
  /** Pest pressure that triggers a spray. */
  pestThreshold: number;
  /** Land buying: maximum parcels held, and the cash needed before considering a purchase. */
  maxParcels: number;
  minCashToBuyLandPaise: Paise;
  minLandScore: number;
  /** Borrow to fund expansion (everyone borrows to escape negative cash). */
  borrowsForGrowth: boolean;
  /** List stock on the P2P market instead of dumping it at a weak mandi price. */
  listsP2P: boolean;
}

const PROFILES: Record<AiPersonality, PersonalityProfile> = {
  cautious: {
    cashBufferPaise: 150_000_00,
    sellAtBaseRatio: 1,
    minPlantScore: 65,
    minPlantMargin: 0.25,
    pestThreshold: 0.35,
    maxParcels: 4,
    minCashToBuyLandPaise: 0,
    minLandScore: 70,
    borrowsForGrowth: false,
    listsP2P: false,
  },
  expansionist: {
    cashBufferPaise: 40_000_00,
    sellAtBaseRatio: 0.95,
    minPlantScore: 50,
    minPlantMargin: 0.1,
    pestThreshold: 0.45,
    maxParcels: 24,
    minCashToBuyLandPaise: 0,
    minLandScore: 55,
    borrowsForGrowth: true,
    listsP2P: false,
  },
  trader: {
    cashBufferPaise: 80_000_00,
    sellAtBaseRatio: 1.15,
    minPlantScore: 60,
    minPlantMargin: 0.15,
    pestThreshold: 0.4,
    maxParcels: 3,
    minCashToBuyLandPaise: 1_200_000_00,
    minLandScore: 65,
    borrowsForGrowth: false,
    listsP2P: true,
  },
};

/** Working capital reserved per hectare of land bought (first planting and harvest). */
const LAND_WORKING_CAPITAL_PER_HA: Paise = 60_000_00;
/** Fraction of the crop's daily mandi demand the AI sells in one go (limits price impact). */
const SELL_CHUNK_OF_DEMAND = 0.5;
/** Produce this close to expiry is sold whatever the price. */
const URGENT_EXPIRY_DAYS = 2;
const PERISHABLE_SHELF_LIFE_DAYS = 30;
const LOAN_TERM_MONTHS = 24;
const P2P_LISTING_DAYS = 10;
const P2P_MIN_LISTING_KG = 200;

interface Candidate {
  intent: AiIntent;
  utility: number;
  /** Cash the action spends now. */
  costPaise: Paise;
  /** Whether the personality's cash buffer must be preserved (discretionary spending). */
  discretionary: boolean;
  /** Only one action per key (plot, parcel or item) per day. */
  key: string;
}

function roundToThousandRupees(paise: Paise): Paise {
  return Math.ceil(paise / 1000_00) * 1000_00;
}

/** Expected farm-gate price when a crop sown now is harvested (seasonal, slightly conservative). */
function expectedHarvestPrice(crop: CropDefinition, day: number): Paise {
  const harvestMonth = monthOfDay(day + cropDurationDays(crop));
  return Math.round(
    crop.basePricePaisePerKg * (crop.seasonalPriceFactor[harvestMonth - 1] ?? 1) * 0.92,
  );
}

interface PlantingPlan {
  cropId: CropId;
  irrigate: boolean;
  fertilize: boolean;
  /** Planting now plus the harvest and irrigation it commits to. */
  committedCostPaise: Paise;
  margin: number;
  score: number;
}

/** Best crop to sow on a parcel today, or null if nothing is open, suitable and profitable. */
function bestPlanting(
  env: ParcelEnvironment,
  view: AiWorldView,
  profile: PersonalityProfile,
  personality: AiPersonality,
): PlantingPlan | null {
  const month = monthOfDay(view.day);
  let best: PlantingPlan | null = null;
  let bestUtility = Number.NEGATIVE_INFINITY;
  for (const cropId of CROP_IDS) {
    const crop = CROPS[cropId];
    if (!isSowingOpen(crop, month)) continue;
    const price = expectedHarvestPrice(crop, view.day);
    const irrigationOptions = canIrrigate(env, false) ? [true, false] : [false];
    for (const irrigate of irrigationOptions) {
      const suitability = computeSuitability(crop, env, climateForEnv(env, view.climate), {
        sowingDay: view.day,
        irrigated: irrigate,
      });
      if (suitability.score < profile.minPlantScore) continue;
      const expected = suitability.yieldKgPerHa.expected;
      const fertilizerGain = unfertilizedYieldPenalty(crop, env.fertility) * expected * price;
      const fertilize =
        personality === 'cautious' || fertilizerGain > crop.costs.fertilizerPaisePerHa;
      const yieldKgPerHa = fertilize
        ? expected
        : expected * (1 - unfertilizedYieldPenalty(crop, env.fertility));
      const economics = estimateCropEconomics(crop, {
        areaHa: env.areaHa,
        yieldKgPerHa,
        pricePaisePerKg: price,
        fertilize,
        irrigate,
        irrigationCostFactor: irrigationSourceCostFactor(env.waterAccess),
      });
      const margin = economics.profitPaise / Math.max(1, economics.totalCostPaise);
      if (margin < profile.minPlantMargin) continue;
      const storable = crop.shelfLifeDays >= 180;
      const preference =
        personality === 'trader'
          ? storable
            ? 1.2
            : crop.shelfLifeDays < PERISHABLE_SHELF_LIFE_DAYS
              ? 0.6
              : 1
          : 1;
      const utility = economics.profitPaise * preference;
      if (utility > bestUtility) {
        bestUtility = utility;
        best = {
          cropId,
          irrigate,
          fertilize,
          committedCostPaise: economics.totalCostPaise - economics.pestControlCostPaise,
          margin,
          score: suitability.score,
        };
      }
    }
  }
  return best;
}

/** Rough per-season profit of a parcel's best crop at base prices (for land valuation). */
function parcelSeasonProfit(
  env: ParcelEnvironment,
  view: AiWorldView,
): { profit: Paise; score: number } {
  const best = computeAllSuitability(env, climateForEnv(env, view.climate))[0];
  if (!best) return { profit: 0, score: 0 };
  const crop = CROPS[best.cropId];
  const economics = estimateCropEconomics(crop, {
    areaHa: env.areaHa,
    yieldKgPerHa: best.yieldKgPerHa.expected,
    pricePaisePerKg: crop.basePricePaisePerKg,
    fertilize: true,
    irrigate: best.irrigationAssumed,
    irrigationCostFactor: irrigationSourceCostFactor(env.waterAccess),
  });
  // Normalise long crops (sugarcane) to a 120-day season.
  const seasons = Math.max(1, cropDurationDays(crop) / 120);
  return { profit: Math.round(economics.profitPaise / seasons), score: best.score };
}

/**
 * Rule-based utility AI. Scores candidate actions (harvest ready plots, clear failed plots,
 * plant best-suited crop on idle owned land when sowing is open and cash allows,
 * apply pest control on high pressure, sell inventory when price >= personality threshold
 * vs base or produce near expiry, buy affordable well-suited land, borrow conservatively).
 * Returns at most `maxActions` intents, highest utility first. Deterministic for a given `random`.
 *
 * Cash is tracked across the chosen intents: every intent that spends money is affordable
 * from current cash (not counting proceeds of sales or loans proposed the same day), and
 * discretionary spending (planting, land) also preserves the personality's cash buffer.
 */
export function decideAiActions(
  view: AiWorldView,
  random: () => number,
  maxActions: number,
): AiIntent[] {
  if (maxActions <= 0) return [];
  const profile = PROFILES[view.personality];
  const candidates: Candidate[] = [];
  const day = view.day;

  // --- Plots: harvest, clear, protect, plant ----------------------------------
  for (const owned of view.ownedParcels) {
    const { plot, env } = owned;
    if (plot && plot.status === 'ready') {
      candidates.push({
        intent: { kind: 'harvest', plotId: plot.plotId },
        utility: 100,
        costPaise: harvestCostPaise(CROPS[plot.cropId], env.areaHa),
        discretionary: false,
        key: `plot:${plot.plotId}`,
      });
    } else if (plot && plot.status === 'failed') {
      candidates.push({
        intent: { kind: 'clear_plot', plotId: plot.plotId },
        utility: 90,
        costPaise: 0,
        discretionary: false,
        key: `plot:${plot.plotId}`,
      });
    } else if (plot && plot.status === 'growing') {
      const pressure = plot.pestPressure ?? 0;
      const protectedUntil =
        plot.pestControlDay == null ? -1 : plot.pestControlDay + PEST_CONTROL_PROTECTION_DAYS;
      if (pressure >= profile.pestThreshold && day >= protectedUntil) {
        candidates.push({
          intent: { kind: 'pest_control', plotId: plot.plotId },
          utility: 70 + 20 * pressure,
          costPaise: pestControlCostPaise(CROPS[plot.cropId], env.areaHa),
          discretionary: false,
          key: `plot:${plot.plotId}`,
        });
      }
    } else if (!plot || plot.status === 'harvested') {
      const plan = bestPlanting(env, view, profile, view.personality);
      if (plan) {
        candidates.push({
          intent: {
            kind: 'plant',
            parcelId: owned.parcelId,
            cropId: plan.cropId,
            irrigate: plan.irrigate,
            fertilize: plan.fertilize,
          },
          utility: 50 + 30 * Math.min(1, plan.margin) + plan.score / 20,
          // Planting must leave enough for the harvest and irrigation it commits to.
          costPaise: plan.committedCostPaise,
          discretionary: true,
          key: `parcel:${owned.parcelId}`,
        });
      }
    }
  }

  // --- Inventory: sell or list -------------------------------------------------
  for (const stock of view.inventory) {
    if (stock.availableKg <= 0) continue;
    const crop = CROPS[stock.itemId];
    let bestMarket: { marketId: string; price: Paise; netPerKg: number } | null = null;
    for (const market of view.markets) {
      const price = market.prices[stock.itemId];
      if (!(price > 0)) continue;
      const netPerKg =
        price * qualityPriceMultiplier(stock.quality) -
        TRANSPORT_PAISE_PER_KG_KM * market.distanceKm;
      if (!bestMarket || netPerKg > bestMarket.netPerKg)
        bestMarket = { marketId: market.marketId, price, netPerKg };
    }
    if (!bestMarket) continue;
    const ratio = bestMarket.price / crop.basePricePaisePerKg;
    const perishable = crop.shelfLifeDays < PERISHABLE_SHELF_LIFE_DAYS;
    const urgent =
      stock.expiresDay !== undefined ? stock.expiresDay - day <= URGENT_EXPIRY_DAYS : perishable;
    const needCash = view.cashPaise < profile.cashBufferPaise / 2;
    const chunk = Math.max(1, Math.round(crop.baseDemandKgPerDay * SELL_CHUNK_OF_DEMAND));
    if (urgent || ratio >= profile.sellAtBaseRatio || needCash) {
      candidates.push({
        intent: {
          kind: 'sell_market',
          marketId: bestMarket.marketId,
          itemId: stock.itemId,
          quantityKg: urgent ? stock.availableKg : Math.min(stock.availableKg, chunk),
        },
        utility: urgent ? 95 : needCash ? 85 : 60 + 20 * (ratio - profile.sellAtBaseRatio),
        costPaise: 0,
        discretionary: false,
        key: `item:${stock.itemId}`,
      });
    } else if (profile.listsP2P && !perishable && stock.availableKg >= P2P_MIN_LISTING_KG) {
      const [floor, ceiling] = p2pPriceBand(bestMarket.price);
      const ask = Math.max(
        bestMarket.price * 1.12,
        crop.basePricePaisePerKg * profile.sellAtBaseRatio,
      );
      candidates.push({
        intent: {
          kind: 'create_listing',
          itemId: stock.itemId,
          quantityKg: stock.availableKg,
          unitPricePaise: Math.min(ceiling, Math.max(floor, Math.round(ask))),
          durationDays: P2P_LISTING_DAYS,
        },
        utility: 40,
        costPaise: 0,
        discretionary: false,
        key: `item:${stock.itemId}`,
      });
    }
  }

  // --- Land ---------------------------------------------------------------------
  const spendable = view.cashPaise - profile.cashBufferPaise;
  let bestUnaffordableLand: Paise | null = null;
  if (
    view.ownedParcels.length < profile.maxParcels &&
    view.cashPaise >= profile.minCashToBuyLandPaise
  ) {
    for (const parcel of view.parcelsForSale) {
      const { profit, score } = parcelSeasonProfit(parcel.env, view);
      if (score < profile.minLandScore || profit <= 0) continue;
      const totalNeeded =
        parcel.pricePaise + Math.round(LAND_WORKING_CAPITAL_PER_HA * parcel.env.areaHa);
      const returnPerSeason = profit / parcel.pricePaise;
      if (totalNeeded > spendable) {
        if (bestUnaffordableLand === null || totalNeeded < bestUnaffordableLand)
          bestUnaffordableLand = totalNeeded;
        continue;
      }
      candidates.push({
        intent: {
          kind: 'buy_parcel',
          parcelId: parcel.parcelId,
          expectedVersion: parcel.version,
          maxPricePaise: parcel.pricePaise,
        },
        utility: 45 + Math.min(30, 150 * returnPerSeason),
        // Reserve working capital for the first crop alongside the price.
        costPaise: totalNeeded,
        discretionary: true,
        key: 'land',
      });
    }
  }

  // --- Borrowing -------------------------------------------------------------------
  const borrowHeadroom = MIN_LOAN_CAP_PAISE - view.loanOutstandingPaise;
  if (view.cashPaise < 0 && borrowHeadroom > 0) {
    candidates.push({
      intent: {
        kind: 'take_loan',
        principalPaise: Math.min(
          borrowHeadroom,
          roundToThousandRupees(-view.cashPaise + 50_000_00),
        ),
        termMonths: LOAN_TERM_MONTHS,
      },
      utility: 99,
      costPaise: 0,
      discretionary: false,
      key: 'loan',
    });
  } else if (
    profile.borrowsForGrowth &&
    bestUnaffordableLand !== null &&
    borrowHeadroom >= 50_000_00 &&
    bestUnaffordableLand <= spendable + borrowHeadroom
  ) {
    candidates.push({
      intent: {
        kind: 'take_loan',
        principalPaise: Math.floor(borrowHeadroom / 1000_00) * 1000_00,
        termMonths: LOAN_TERM_MONTHS,
      },
      utility: 55,
      costPaise: 0,
      discretionary: false,
      key: 'loan',
    });
  }

  // --- Choose: highest utility first, within cash, one action per key ---------------
  const ranked = candidates
    .map((candidate, index) => ({ candidate, index, jitter: random() * 0.5 }))
    .sort(
      (a, b) =>
        b.candidate.utility + b.jitter - (a.candidate.utility + a.jitter) || a.index - b.index,
    );
  const chosen: AiIntent[] = [];
  const usedKeys = new Set<string>();
  let cash = view.cashPaise;
  for (const { candidate } of ranked) {
    if (chosen.length >= maxActions) break;
    if (usedKeys.has(candidate.key)) continue;
    const floor = candidate.discretionary ? profile.cashBufferPaise : 0;
    if (candidate.costPaise > 0 && cash - candidate.costPaise < floor) continue;
    chosen.push(candidate.intent);
    usedKeys.add(candidate.key);
    cash -= candidate.costPaise;
  }
  return chosen;
}
