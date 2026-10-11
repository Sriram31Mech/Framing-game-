import { describe, expect, it } from 'vitest';
import { parseKg, parseRupees, plantingQuote, machineryEffects } from '../src/lib/economics';
import {
  formatCountdown,
  formatFraction,
  formatKg,
  formatSignedPct,
  humanize,
  money,
  moneyCompact,
  moneySigned,
  monthName,
  relativeDay,
} from '../src/lib/format';
import { minNetUnitPrice } from '../src/features/market/MarketPanel';
import { expiryTone } from '../src/features/inventory/InventoryPanel';

describe('formatting', () => {
  it('formats INR via the domain formatter (Indian grouping)', () => {
    expect(money(12_345_678)).toBe('₹1,23,456.78');
    expect(moneyCompact(12_345_678)).toBe('₹1.23 L');
    expect(money(Number.NaN)).toBe('—');
    expect(moneySigned(-50_000)).toBe('−₹500.00');
    expect(moneySigned(50_000, true)).toMatch(/^\+₹/);
  });
  it('formats quantities, percentages and time', () => {
    expect(formatKg(850)).toBe('850 kg');
    expect(formatKg(12_400)).toBe('12.4 t');
    expect(formatKg(1_234_000)).toBe('1,234 t');
    expect(formatFraction(0.425)).toBe('43%');
    expect(formatSignedPct(3.21)).toBe('+3.2%');
    expect(formatSignedPct(-0.04)).toBe('0.0%');
    expect(formatSignedPct(-2.5)).toBe('−2.5%');
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(-5)).toBe('0:00');
    expect(monthName(1)).toBe('Jan');
    expect(monthName(13)).toBe('Jan');
    expect(monthName(6, true)).toBe('June');
    expect(humanize('sandy_loam')).toBe('Sandy loam');
    expect(relativeDay(12, 10)).toBe('in 2 days');
    expect(relativeDay(9, 10)).toBe('yesterday');
  });
  it('parses money and quantity inputs strictly', () => {
    expect(parseRupees('1,250.5')).toBe(125_050);
    expect(parseRupees('₹ 40')).toBe(4000);
    expect(parseRupees('12.345')).toBeNull();
    expect(parseRupees('abc')).toBeNull();
    expect(parseKg('1,000')).toBe(1000);
    expect(parseKg('1.5')).toBeNull();
  });
  it('slippage guard floors 98% of the quoted net unit price', () => {
    expect(minNetUnitPrice(100_000, 1000)).toBe(98);
    expect(minNetUnitPrice(99_999, 1000)).toBe(97);
    expect(minNetUnitPrice(5, 0)).toBe(0);
  });
  it('colours expiry by urgency', () => {
    expect(expiryTone(2)).toBe('danger');
    expect(expiryTone(7)).toBe('warning');
    expect(expiryTone(30)).toBe('success');
  });
  it('planting quote matches the domain cost rule used as the server guard', () => {
    const info = {
      id: 'rice' as const,
      name: 'Rice',
      localName: 'Bhatta',
      sowingMonths: [6, 7],
      durationDays: 120,
      harvestWindowDays: 15,
      baseYieldKgPerHa: 4000,
      basePricePaisePerKg: 2500,
      shelfLifeDays: 180,
      waterNeed: 'high' as const,
      costs: {
        seedPaisePerHa: 300_000,
        sowingLaborPaisePerHa: 500_000,
        fertilizerPaisePerHa: 400_000,
        pestControlPaisePerHa: 200_000,
        harvestLaborPaisePerHa: 600_000,
        irrigationPaisePerHaPerDay: 5_000,
      },
    };
    const q = plantingQuote(info, 1.5, {
      fertilize: true,
      irrigate: true,
      effects: machineryEffects([]),
    });
    expect(q.seedPaise + q.sowingLaborPaise + q.fertilizerPaise).toBe(1_800_000);
    expect(Number.isSafeInteger(q.totalPaise)).toBe(true);
    expect(q.dailyIrrigationPaise).toBe(7_500);
  });
});
