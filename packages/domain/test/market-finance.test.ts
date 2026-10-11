import { describe, expect, it } from 'vitest';
import {
  BASE_LOAN_RATE_BPS,
  CROPS,
  DISTRESS_GRACE_DAYS,
  MACHINERY,
  MACHINERY_TYPES,
  MAX_LOAN_RATE_BPS,
  MIN_LOAN_CAP_PAISE,
  applyMarketSale,
  combinedMachineryEffects,
  companyValuationPaise,
  computeLoanTerms,
  dailyDepreciationPaise,
  evaluateSolvency,
  getMachinery,
  incomeTaxPaise,
  initialMarketItemState,
  inventoryValuePaise,
  landTaxPaise,
  loanRateBps,
  maxBorrowablePaise,
  nextDueDay,
  nextMarketItemState,
  p2pPriceBand,
  quoteMarketSale,
  rngFor,
  splitInstalment,
  transportCostPaise,
  type CompanyStatus,
  type MarketDefinition,
  type MarketItemState,
} from '../src';

const APMC: MarketDefinition = {
  id: 'hemavati-apmc',
  name: 'Hemavati APMC Mandi',
  x: 0,
  y: 0,
  feeBps: 100,
  demandScale: 1,
  priceScale: 1,
};
const DISTRICT: MarketDefinition = {
  ...APMC,
  id: 'district-market',
  feeBps: 150,
  demandScale: 1.5,
  priceScale: 1.08,
};
const rice = CROPS.rice;
const noNoise = () => 0.5;

describe('market prices', () => {
  it('starts at the seasonal reference price scaled by the market', () => {
    const june = initialMarketItemState(APMC, rice, 0);
    expect(june).toEqual({
      itemId: 'rice',
      pricePaisePerKg: Math.round(rice.basePricePaisePerKg * rice.seasonalPriceFactor[5]!),
      supplyPressureKg: 0,
      demandKgPerDay: rice.baseDemandKgPerDay,
    });
    const district = initialMarketItemState(DISTRICT, rice, 0);
    expect(district.pricePaisePerKg).toBeGreaterThan(june.pricePaisePerKg);
    expect(district.demandKgPerDay).toBe(rice.baseDemandKgPerDay * 1.5);
  });

  it('mean-reverts toward the seasonal target', () => {
    const target = initialMarketItemState(APMC, rice, 0).pricePaisePerKg;
    let state: MarketItemState = {
      ...initialMarketItemState(APMC, rice, 0),
      pricePaisePerKg: target * 2,
    };
    const gaps: number[] = [];
    for (let day = 0; day < 25; day++) {
      state = nextMarketItemState(state, { market: APMC, crop: rice, day, random: noNoise });
      gaps.push(Math.abs(state.pricePaisePerKg - target));
    }
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeLessThanOrEqual(gaps[i - 1]!);
    expect(gaps.at(-1)!).toBeLessThan(target * 0.03);
  });

  it('clamps prices to [0.4, 2.5] x base and keeps them integer', () => {
    const base = CROPS.tomato.basePricePaisePerKg;
    const high = nextMarketItemState(
      { itemId: 'tomato', pricePaisePerKg: base * 10, supplyPressureKg: 0, demandKgPerDay: 5000 },
      { market: APMC, crop: CROPS.tomato, day: 0, random: () => 0.99 },
    );
    expect(high.pricePaisePerKg).toBe(base * 2.5);
    let glut: MarketItemState = {
      itemId: 'tomato',
      pricePaisePerKg: base,
      supplyPressureKg: 5_000_000,
      demandKgPerDay: 5000,
    };
    for (let day = 0; day < 60; day++) {
      glut = nextMarketItemState(glut, {
        market: APMC,
        crop: CROPS.tomato,
        day,
        random: rngFor('glut', day),
      });
      expect(Number.isSafeInteger(glut.pricePaisePerKg)).toBe(true);
      expect(glut.pricePaisePerKg).toBeGreaterThanOrEqual(base * 0.4);
      expect(glut.pricePaisePerKg).toBeLessThanOrEqual(base * 2.5);
    }
  });

  it('decays supply pressure about 15% a day and recovers after a dump', () => {
    const start = initialMarketItemState(APMC, rice, 0);
    const dumped = applyMarketSale(start, 16_000);
    expect(dumped.supplyPressureKg).toBe(16_000);
    expect(dumped.pricePaisePerKg).toBeLessThan(start.pricePaisePerKg);
    const next = nextMarketItemState(dumped, { market: APMC, crop: rice, day: 1, random: noNoise });
    expect(next.supplyPressureKg).toBe(13_600);
    let state = next;
    for (let day = 2; day < 40; day++)
      state = nextMarketItemState(state, { market: APMC, crop: rice, day, random: noNoise });
    expect(state.pricePaisePerKg).toBeGreaterThan(dumped.pricePaisePerKg);
    expect(Math.abs(state.pricePaisePerKg - start.pricePaisePerKg)).toBeLessThan(
      start.pricePaisePerKg * 0.05,
    );
  });

  it('stays bounded and near the seasonal average under random noise', () => {
    let state = initialMarketItemState(APMC, CROPS.tomato, 0);
    let sum = 0;
    for (let day = 0; day < 720; day++) {
      state = nextMarketItemState(state, {
        market: APMC,
        crop: CROPS.tomato,
        day,
        random: rngFor('noise', day),
      });
      sum += state.pricePaisePerKg;
    }
    const mean = sum / 720 / CROPS.tomato.basePricePaisePerKg;
    expect(mean).toBeGreaterThan(0.8);
    expect(mean).toBeLessThan(1.25);
  });
});

describe('market sales', () => {
  const state: MarketItemState = {
    itemId: 'rice',
    pricePaisePerKg: 2200,
    supplyPressureKg: 0,
    demandKgPerDay: 8000,
  };

  it('quotes with exact integer arithmetic', () => {
    for (const [quantity, quality] of [
      [1, 50],
      [777, 63],
      [4_651, 98],
      [123_457, 12],
    ] as const) {
      const quote = quoteMarketSale(state, APMC, quantity, quality);
      expect(quote.quantityKg).toBe(quantity);
      for (const value of [
        quote.unitPricePaise,
        quote.grossPaise,
        quote.feePaise,
        quote.netPaise,
      ]) {
        expect(Number.isSafeInteger(value)).toBe(true);
      }
      expect(quote.grossPaise).toBe(quote.unitPricePaise * quantity);
      expect(quote.feePaise).toBe(Math.round(quote.grossPaise / 100));
      expect(quote.netPaise).toBe(quote.grossPaise - quote.feePaise);
    }
    expect(quoteMarketSale(state, APMC, 0, 80)).toMatchObject({ grossPaise: 0, netPaise: 0 });
    expect(() => quoteMarketSale(state, APMC, 1.5, 80)).toThrow(RangeError);
    expect(() => quoteMarketSale(state, APMC, -1, 80)).toThrow(RangeError);
  });

  it('adjusts for quality between 0.7x and 1.1x', () => {
    expect(quoteMarketSale(state, APMC, 1, 0).unitPricePaise).toBe(1540);
    expect(quoteMarketSale(state, APMC, 1, 100).unitPricePaise).toBe(2420);
    expect(quoteMarketSale(state, APMC, 1, 75).unitPricePaise).toBe(2200);
  });

  it('averages volume impact over the sale: small sales barely move, big ones hurt', () => {
    const small = quoteMarketSale(state, APMC, 10, 75);
    expect(small.priceImpactPct).toBeLessThan(0.1);
    const oneDay = quoteMarketSale(state, APMC, 8000, 75);
    expect(oneDay.priceImpactPct).toBeGreaterThan(10);
    expect(oneDay.priceImpactPct).toBeLessThan(20);
    const huge = quoteMarketSale(state, APMC, 80_000, 75);
    expect(huge.priceImpactPct).toBeGreaterThan(55);
    // Average realised price exceeds the marginal price the market is left at.
    expect(huge.unitPricePaise).toBeGreaterThan(applyMarketSale(state, 80_000).pricePaisePerKg);
    // Splitting a sale across days (with recovery) earns more than dumping it at once.
    expect(quoteMarketSale(state, APMC, 4000, 75).grossPaise * 2).toBeGreaterThan(
      oneDay.grossPaise,
    );
  });

  it('charges the market fee, a higher one at the district market', () => {
    const local = quoteMarketSale(state, APMC, 1000, 75);
    const district = quoteMarketSale(state, DISTRICT, 1000, 75);
    expect(district.feePaise / district.grossPaise).toBeCloseTo(0.015, 4);
    expect(local.feePaise / local.grossPaise).toBeCloseTo(0.01, 4);
  });

  it('prices transport, P2P bands and inventory valuation in integer paise', () => {
    expect(transportCostPaise(1000, 2.5)).toBe(10_000);
    expect(transportCostPaise(1000, 2.5, 0.45)).toBe(4500);
    expect(transportCostPaise(333, 1.37)).toBe(Math.round(333 * 1.37 * 4));
    expect(transportCostPaise(0, 5)).toBe(0);
    expect(p2pPriceBand(2200)).toEqual([550, 8800]);
    expect(p2pPriceBand(3)).toEqual([1, 12]);
    expect(inventoryValuePaise('rice', 1000, 75, 2200)).toBe(1_980_000);
    // Perishables take a bigger haircut.
    expect(inventoryValuePaise('tomato', 1000, 75, 2200)).toBe(1_650_000);
    expect(inventoryValuePaise('rice', 0, 75, 2200)).toBe(0);
  });
});

describe('loans and finance', () => {
  it('computes the EMI for a known loan (₹1 lakh, 12%, 12 months)', () => {
    const terms = computeLoanTerms(100_000_00, 1200, 12);
    expect(terms.emiPaise).toBe(888_488);
    expect(terms.totalRepayablePaise).toBe(888_488 * 12);
    expect(computeLoanTerms(100_000, 0, 3).emiPaise).toBe(33_334);
    expect(() => computeLoanTerms(0, 1200, 12)).toThrow(RangeError);
    expect(() => computeLoanTerms(100, 1200, 0)).toThrow(RangeError);
    expect(() => computeLoanTerms(100, 1200, 37)).toThrow(RangeError);
  });

  it('amortises fully with splitInstalment over the term', () => {
    const terms = computeLoanTerms(350_000_00, 1450, 24);
    let outstanding = terms.principalPaise;
    let interestTotal = 0;
    for (let month = 0; month < terms.termMonths; month++) {
      const due = month === terms.termMonths - 1 ? terms.emiPaise + 10_000 : terms.emiPaise;
      const { interestPaise, principalPaise } = splitInstalment(
        outstanding,
        terms.annualRateBps,
        due,
      );
      expect(Number.isSafeInteger(interestPaise) && Number.isSafeInteger(principalPaise)).toBe(
        true,
      );
      outstanding -= principalPaise;
      interestTotal += interestPaise;
    }
    expect(outstanding).toBe(0);
    expect(Math.abs(terms.principalPaise + interestTotal - terms.totalRepayablePaise)).toBeLessThan(
      100,
    );
  });

  it('splits an instalment that does not cover interest as all interest', () => {
    expect(splitInstalment(1_000_000, 1200, 5_000)).toEqual({
      interestPaise: 5_000,
      principalPaise: 0,
    });
    expect(splitInstalment(1_000_000, 1200, 20_000)).toEqual({
      interestPaise: 10_000,
      principalPaise: 10_000,
    });
    expect(splitInstalment(5_000, 1200, 20_000)).toEqual({
      interestPaise: 50,
      principalPaise: 5_000,
    });
    expect(splitInstalment(0, 1200, 20_000)).toEqual({ interestPaise: 0, principalPaise: 0 });
  });

  it('prices risk into the loan rate, capped', () => {
    expect(loanRateBps({ leverage: 0, bankruptcies: 0 })).toBe(BASE_LOAN_RATE_BPS);
    const levered = loanRateBps({ leverage: 0.6, bankruptcies: 0 });
    expect(levered).toBeGreaterThan(BASE_LOAN_RATE_BPS);
    expect(loanRateBps({ leverage: 0.6, bankruptcies: 1 })).toBeGreaterThan(levered);
    expect(loanRateBps({ leverage: 5, bankruptcies: 4 })).toBe(MAX_LOAN_RATE_BPS);
    expect(loanRateBps({ leverage: Number.NaN, bankruptcies: 0 })).toBe(BASE_LOAN_RATE_BPS);
  });

  it('limits borrowing to a share of net assets with a floor', () => {
    expect(maxBorrowablePaise({ netAssetsPaise: 100_000_00, loanOutstandingPaise: 0 })).toBe(
      MIN_LOAN_CAP_PAISE,
    );
    expect(
      maxBorrowablePaise({ netAssetsPaise: 1_000_000_00, loanOutstandingPaise: 100_000_00 }),
    ).toBe(500_000_00);
    expect(
      maxBorrowablePaise({ netAssetsPaise: 1_000_000_00, loanOutstandingPaise: 900_000_00 }),
    ).toBe(0);
    expect(maxBorrowablePaise({ netAssetsPaise: -5, loanOutstandingPaise: 0 })).toBe(0);
  });

  it('walks solvency through distress, recovery and bankruptcy', () => {
    const step = (
      cashPaise: number,
      status: CompanyStatus,
      distressSinceDay: number | null,
      day: number,
    ) => evaluateSolvency({ cashPaise, status, distressSinceDay, day });
    expect(step(10, 'active', null, 5)).toEqual({
      status: 'active',
      distressSinceDay: null,
      graceDaysRemaining: null,
      changed: false,
    });
    expect(step(-1, 'active', null, 5)).toEqual({
      status: 'distressed',
      distressSinceDay: 5,
      graceDaysRemaining: DISTRESS_GRACE_DAYS,
      changed: true,
    });
    expect(step(-1, 'distressed', 5, 20)).toEqual({
      status: 'distressed',
      distressSinceDay: 5,
      graceDaysRemaining: 15,
      changed: false,
    });
    expect(step(0, 'distressed', 5, 20)).toEqual({
      status: 'active',
      distressSinceDay: null,
      graceDaysRemaining: null,
      changed: true,
    });
    expect(step(-1, 'distressed', 5, 5 + DISTRESS_GRACE_DAYS - 1).graceDaysRemaining).toBe(1);
    expect(step(-1, 'distressed', 5, 5 + DISTRESS_GRACE_DAYS)).toEqual({
      status: 'bankrupt',
      distressSinceDay: 5,
      graceDaysRemaining: 0,
      changed: true,
    });
    expect(step(100, 'bankrupt', 5, 50).status).toBe('bankrupt');
  });

  it('values the company as assets minus liabilities and computes taxes and depreciation', () => {
    expect(
      companyValuationPaise({
        cashPaise: 100,
        inventoryValuePaise: 20,
        landValuePaise: 300,
        machineryBookValuePaise: 40,
        escrowPaise: 5,
        loanOutstandingPaise: 150,
      }),
    ).toBe(315);
    expect(landTaxPaise(2.5)).toBe(375_00);
    expect(landTaxPaise(2.5, 4)).toBe(1500_00);
    expect(landTaxPaise(0)).toBe(0);
    expect(incomeTaxPaise(1_000_001)).toBe(100_000);
    expect(incomeTaxPaise(-5)).toBe(0);
    expect(dailyDepreciationPaise(650_000_00, 0.2, 3600)).toBe(14_444);
    expect(nextDueDay(10, 0)).toBe(40);
    expect(nextDueDay(10, 3)).toBe(130);
  });
});

describe('machinery', () => {
  it.each(MACHINERY_TYPES)('%s has a sensible definition', (type) => {
    const machine = getMachinery(type);
    expect(machine.type).toBe(type);
    expect(machine.pricePaise).toBeGreaterThanOrEqual(150_000_00);
    expect(machine.pricePaise).toBeLessThanOrEqual(800_000_00);
    expect(machine.usefulLifeDays).toBeGreaterThan(360);
    expect(machine.salvageFraction > 0 && machine.salvageFraction < 1).toBe(true);
    expect(Number.isSafeInteger(machine.maintenancePaisePerDay)).toBe(true);
    expect(Object.keys(machine.effects).length).toBeGreaterThan(0);
    expect(
      dailyDepreciationPaise(machine.pricePaise, machine.salvageFraction, machine.usefulLifeDays),
    ).toBeGreaterThan(0);
  });

  it('combines effects multiplicatively, once per type, with storage per unit', () => {
    expect(combinedMachineryEffects([])).toEqual({
      sowingLaborMultiplier: 1,
      harvestLaborMultiplier: 1,
      transportCostMultiplier: 1,
      irrigationCostMultiplier: 1,
      enablesDryIrrigation: false,
      shelfLifeMultiplier: 1,
      storageCapacityKg: 0,
    });
    const fleet = combinedMachineryEffects([
      'tractor',
      'harvester',
      'truck',
      'pump_set',
      'warehouse',
    ]);
    expect(fleet.harvestLaborMultiplier).toBeCloseTo(0.85 * 0.45, 10);
    expect(fleet.transportCostMultiplier).toBeCloseTo(0.85 * 0.45, 10);
    expect(fleet.enablesDryIrrigation).toBe(true);
    expect(fleet.irrigationCostMultiplier).toBe(0.75);
    expect(fleet.shelfLifeMultiplier).toBe(MACHINERY.warehouse.effects.shelfLifeMultiplier);
    const twoTractors = combinedMachineryEffects(['tractor', 'tractor', 'warehouse', 'warehouse']);
    expect(twoTractors.sowingLaborMultiplier).toBe(0.6);
    expect(twoTractors.storageCapacityKg).toBe(200_000);
    expect(twoTractors.shelfLifeMultiplier).toBe(1.6);
  });
});
