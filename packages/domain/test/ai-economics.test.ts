import { describe, expect, it } from 'vitest';
import {
  CROPS,
  CROP_IDS,
  HEMAVATI_CLIMATE,
  ITEM_IDS,
  LAND_TAX_PAISE_PER_HA_PER_MONTH,
  STARTING_CASH_PAISE,
  decideAiActions,
  estimateHarvest,
  generateRegion,
  harvestCostPaise,
  initialMarketItemState,
  isSowingOpen,
  landTaxPaise,
  monthOfDay,
  pestControlCostPaise,
  plantingCostPaise,
  quoteMarketSale,
  rngFor,
  transportCostPaise,
  type AiIntent,
  type AiPersonality,
  type AiWorldView,
  type CropId,
  type ItemId,
} from '../src';
import { ENVS, simulateSeason } from './helpers';

const region = generateRegion();
const PERSONALITIES: AiPersonality[] = ['cautious', 'expansionist', 'trader'];

function basePrices(multiplier = 1): Record<ItemId, number> {
  return Object.fromEntries(
    ITEM_IDS.map((id) => [id, Math.round(CROPS[id].basePricePaisePerKg * multiplier)]),
  ) as Record<ItemId, number>;
}

function makeView(overrides: Partial<AiWorldView> = {}): AiWorldView {
  const owned = region.parcels.slice(0, 2);
  return {
    companyId: 'ai-1',
    personality: 'cautious',
    day: 0,
    cashPaise: STARTING_CASH_PAISE,
    loanOutstandingPaise: 0,
    ownedParcels: owned.map((p) => ({ parcelId: p.id, env: p.env, plot: null, leased: false })),
    parcelsForSale: region.parcels.slice(10, 40).map((p) => ({
      parcelId: p.id,
      env: p.env,
      pricePaise: p.basePricePaise,
      version: 1,
    })),
    inventory: [],
    markets: region.markets.map((m, i) => ({
      marketId: m.id,
      prices: basePrices(),
      distanceKm: 2 + i * 2,
    })),
    climate: HEMAVATI_CLIMATE,
    ...overrides,
  };
}

/** Cash an intent spends immediately (the command layer's charge before machinery discounts). */
function immediateCost(intent: AiIntent, view: AiWorldView): number {
  switch (intent.kind) {
    case 'buy_parcel':
      return intent.maxPricePaise;
    case 'plant': {
      const parcel = view.ownedParcels.find((p) => p.parcelId === intent.parcelId)!;
      return plantingCostPaise(CROPS[intent.cropId], parcel.env.areaHa, {
        fertilize: intent.fertilize,
      });
    }
    case 'harvest':
    case 'pest_control': {
      const parcel = view.ownedParcels.find((p) => p.plot?.plotId === intent.plotId)!;
      const crop = CROPS[parcel.plot!.cropId];
      return intent.kind === 'harvest'
        ? harvestCostPaise(crop, parcel.env.areaHa)
        : pestControlCostPaise(crop, parcel.env.areaHa);
    }
    default:
      return 0;
  }
}

describe('decideAiActions', () => {
  it('never exceeds maxActions or available cash, across many situations', () => {
    for (let trial = 0; trial < 60; trial++) {
      const random = rngFor('ai-trial', trial);
      const personality = PERSONALITIES[trial % 3]!;
      const day = Math.floor(random() * 720);
      const plots = region.parcels.slice(trial % 50, (trial % 50) + 5).map((p, i) => {
        const statuses = ['growing', 'ready', 'failed', null, null] as const;
        const status = statuses[(i + trial) % statuses.length]!;
        const cropId = CROP_IDS[(i + trial) % CROP_IDS.length]!;
        return {
          parcelId: p.id,
          env: p.env,
          leased: i === 4,
          plot:
            status === null
              ? null
              : {
                  plotId: `plot-${p.id}`,
                  cropId,
                  status,
                  irrigated: true,
                  pestPressure: random(),
                  pestControlDay: null,
                },
        };
      });
      const view = makeView({
        personality,
        day,
        cashPaise: Math.floor(random() * 1_500_000_00) - 50_000_00,
        loanOutstandingPaise: Math.floor(random() * 300_000_00),
        ownedParcels: plots,
        inventory: ITEM_IDS.slice(0, 3).map((itemId) => ({
          itemId,
          availableKg: Math.floor(random() * 20_000),
          quality: 80,
        })),
        markets: region.markets.map((m, i) => ({
          marketId: m.id,
          prices: basePrices(0.8 + random() * 0.6),
          distanceKm: 1 + i * 3,
        })),
      });
      const maxActions = trial % 5;
      const intents = decideAiActions(view, rngFor('ai', trial), maxActions);
      expect(intents.length).toBeLessThanOrEqual(maxActions);
      const spent = intents.reduce((sum, intent) => sum + immediateCost(intent, view), 0);
      if (spent > 0) expect(spent).toBeLessThanOrEqual(view.cashPaise);
      for (const intent of intents) {
        if (intent.kind === 'plant')
          expect(isSowingOpen(CROPS[intent.cropId], monthOfDay(day))).toBe(true);
        if (intent.kind === 'sell_market') expect(intent.quantityKg).toBeGreaterThan(0);
        if (intent.kind === 'take_loan') expect(intent.principalPaise).toBeGreaterThan(0);
      }
      expect(decideAiActions(view, rngFor('ai', trial), maxActions)).toEqual(intents);
    }
  });

  it('harvests ready plots and clears failed ones first', () => {
    const [a, b] = region.parcels;
    const view = makeView({
      ownedParcels: [
        {
          parcelId: a!.id,
          env: a!.env,
          leased: false,
          plot: { plotId: 'p1', cropId: 'rice', status: 'ready', irrigated: true },
        },
        {
          parcelId: b!.id,
          env: b!.env,
          leased: false,
          plot: { plotId: 'p2', cropId: 'maize', status: 'failed', irrigated: false },
        },
      ],
    });
    const intents = decideAiActions(view, rngFor('first'), 2);
    expect(intents).toEqual([
      { kind: 'harvest', plotId: 'p1' },
      { kind: 'clear_plot', plotId: 'p2' },
    ]);
  });

  it('plants open, suited crops on idle land, respecting sowing windows', () => {
    for (const day of [0, 30, 120, 150, 240, 300]) {
      const intents = decideAiActions(
        makeView({ personality: 'expansionist', day }),
        rngFor('plant', day),
        4,
      );
      for (const intent of intents.filter((i) => i.kind === 'plant')) {
        if (intent.kind !== 'plant') continue;
        expect(isSowingOpen(CROPS[intent.cropId], monthOfDay(day))).toBe(true);
      }
    }
    const june = decideAiActions(makeView({ day: 0 }), rngFor('june'), 4);
    expect(june.filter((i) => i.kind === 'plant').length).toBeGreaterThan(0);
  });

  it('sprays only unprotected plots under real pest pressure', () => {
    const parcel = region.parcels[0]!;
    const plot = (pestPressure: number, pestControlDay: number | null) => ({
      parcelId: parcel.id,
      env: parcel.env,
      leased: false,
      plot: {
        plotId: 'p1',
        cropId: 'tomato' as CropId,
        status: 'growing' as const,
        irrigated: true,
        pestPressure,
        pestControlDay,
      },
    });
    const spray = (p: ReturnType<typeof plot>) =>
      decideAiActions(makeView({ day: 100, ownedParcels: [p] }), rngFor('pest'), 4).some(
        (i) => i.kind === 'pest_control',
      );
    expect(spray(plot(0.6, null))).toBe(true);
    expect(spray(plot(0.1, null))).toBe(false);
    expect(spray(plot(0.6, 90))).toBe(false);
  });

  it('sells by personality: cautious at base, trader holds out and lists P2P', () => {
    const inventory = [{ itemId: 'rice' as const, availableKg: 5000, quality: 80 }];
    const atBase = (personality: AiPersonality) =>
      decideAiActions(
        makeView({ personality, inventory, ownedParcels: [], parcelsForSale: [] }),
        rngFor('sell'),
        4,
      );
    expect(atBase('cautious').some((i) => i.kind === 'sell_market')).toBe(true);
    const trader = atBase('trader');
    expect(trader.some((i) => i.kind === 'sell_market')).toBe(false);
    const listing = trader.find((i) => i.kind === 'create_listing');
    expect(listing).toMatchObject({ itemId: 'rice', quantityKg: 5000 });
    expect(listing!.kind === 'create_listing' && listing!.unitPricePaise).toBeGreaterThanOrEqual(
      CROPS.rice.basePricePaisePerKg * 1.12,
    );
    const highPrices = region.markets.map((m) => ({
      marketId: m.id,
      prices: basePrices(1.2),
      distanceKm: 2,
    }));
    const traderHigh = decideAiActions(
      makeView({
        personality: 'trader',
        inventory,
        markets: highPrices,
        ownedParcels: [],
        parcelsForSale: [],
      }),
      rngFor('sell'),
      4,
    );
    expect(traderHigh.some((i) => i.kind === 'sell_market')).toBe(true);
  });

  it('dumps perishables close to expiry regardless of price', () => {
    const view = makeView({
      personality: 'trader',
      day: 50,
      inventory: [{ itemId: 'tomato', availableKg: 9000, quality: 70, expiresDay: 51 }],
      markets: region.markets.map((m) => ({
        marketId: m.id,
        prices: basePrices(0.5),
        distanceKm: 2,
      })),
      ownedParcels: [],
      parcelsForSale: [],
    });
    expect(decideAiActions(view, rngFor('expiry'), 1)).toEqual([
      { kind: 'sell_market', marketId: expect.any(String), itemId: 'tomato', quantityKg: 9000 },
    ]);
  });

  it('expands by personality: expansionist buys land and borrows, cautious keeps its buffer', () => {
    const rich = makeView({ personality: 'expansionist', cashPaise: 1_500_000_00, day: 100 });
    expect(decideAiActions(rich, rngFor('land'), 4).some((i) => i.kind === 'buy_parcel')).toBe(
      true,
    );
    const tight = makeView({ personality: 'expansionist', cashPaise: 150_000_00, day: 100 });
    const tightIntents = decideAiActions(tight, rngFor('land'), 4);
    expect(tightIntents.some((i) => i.kind === 'take_loan')).toBe(true);
    const cautious = makeView({ personality: 'cautious', cashPaise: 300_000_00, day: 100 });
    const cautiousIntents = decideAiActions(cautious, rngFor('land'), 4);
    expect(cautiousIntents.some((i) => i.kind === 'take_loan')).toBe(false);
    for (const intent of cautiousIntents) {
      if (intent.kind === 'buy_parcel')
        expect(cautious.cashPaise - intent.maxPricePaise).toBeGreaterThanOrEqual(150_000_00);
    }
    const trader = makeView({ personality: 'trader', cashPaise: 600_000_00, day: 100 });
    expect(decideAiActions(trader, rngFor('land'), 4).some((i) => i.kind === 'buy_parcel')).toBe(
      false,
    );
  });

  it('borrows to escape negative cash', () => {
    const view = makeView({ cashPaise: -30_000_00, ownedParcels: [], parcelsForSale: [] });
    const intents = decideAiActions(view, rngFor('rescue'), 2);
    expect(intents[0]).toEqual({ kind: 'take_loan', principalPaise: 80_000_00, termMonths: 24 });
  });

  it('returns nothing when asked for zero actions', () => {
    expect(decideAiActions(makeView(), rngFor('none'), 0)).toEqual([]);
  });
});

/** Profit of growing one crop on 1 ha and selling the harvest at the local mandi in daily lots. */
function seasonProfit(input: {
  cropId: CropId;
  env: (typeof ENVS)[keyof typeof ENVS];
  sowDay: number;
  seed: number;
  irrigate: boolean;
}): number {
  const season = simulateSeason({ ...input, fertilize: true, pestControl: true });
  const crop = CROPS[input.cropId];
  const harvest = estimateHarvest(season.state, crop);
  const market = region.markets[0]!;
  // Sell at the base price (not the seasonal one) in lots of half a day's demand.
  let remaining = harvest.quantityKg;
  let revenue = 0;
  while (remaining > 0) {
    const lot = Math.min(remaining, Math.round(crop.baseDemandKgPerDay / 2));
    const state = {
      ...initialMarketItemState(market, crop, 0),
      pricePaisePerKg: crop.basePricePaisePerKg,
    };
    revenue += quoteMarketSale(state, market, lot, harvest.quality).netPaise;
    revenue -= transportCostPaise(lot, 2);
    remaining -= lot;
  }
  const costs =
    season.plantingCostPaise +
    season.irrigationCostPaise +
    season.pestControlCostPaise +
    season.harvestCostPaise +
    landTaxPaise(1, Math.ceil(season.days / 30));
  return revenue - costs;
}

describe('economics sanity', () => {
  it('a suited, irrigated 1 ha rice plot is profitable across weather years; an unsuited one is not', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const suited = seasonProfit({
        cropId: 'rice',
        env: ENVS.canalClayLoam,
        sowDay: 0,
        seed,
        irrigate: true,
      });
      const unsuited = seasonProfit({
        cropId: 'rice',
        env: ENVS.dryLaterite,
        sowDay: 0,
        seed,
        irrigate: false,
      });
      expect(suited).toBeGreaterThan(20_000_00);
      expect(suited).toBeLessThan(80_000_00);
      expect(unsuited).toBeLessThan(0);
    }
  });

  it('each crop makes money on land that suits it', () => {
    const cases: [CropId, keyof typeof ENVS, number, boolean][] = [
      ['rice', 'riverClay', 0, true],
      ['ragi', 'dryLaterite', 30, false],
      ['maize', 'canalClayLoam', 0, false],
      ['chickpea', 'canalClayLoam', 150, true],
      ['sugarcane', 'canalClayLoam', 240, true],
      ['tomato', 'canalClayLoam', 150, true],
    ];
    for (const [cropId, envName, sowDay, irrigate] of cases) {
      const profit = seasonProfit({ cropId, env: ENVS[envName], sowDay, seed: 7, irrigate });
      expect(profit, cropId).toBeGreaterThan(0);
    }
  });

  it('a starter farmer grows cash over two years of rice/chickpea rotation', () => {
    let cash = STARTING_CASH_PAISE;
    for (const year of [0, 1]) {
      cash += seasonProfit({
        cropId: 'rice',
        env: ENVS.canalClayLoam,
        sowDay: 360 * year,
        seed: 11 + year,
        irrigate: true,
      });
      cash += seasonProfit({
        cropId: 'chickpea',
        env: ENVS.canalClayLoam,
        sowDay: 360 * year + 150,
        seed: 11 + year,
        irrigate: true,
      });
      cash -= LAND_TAX_PAISE_PER_HA_PER_MONTH * 4; // idle months
    }
    expect(cash).toBeGreaterThan(STARTING_CASH_PAISE + 100_000_00);
    expect(Number.isSafeInteger(cash)).toBe(true);
  });
});
