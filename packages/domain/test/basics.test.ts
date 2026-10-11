import { describe, expect, it } from 'vitest';
import {
  applyBps,
  assertPaise,
  createRng,
  firstDayOfMonthFrom,
  formatInr,
  hashSeed,
  monthOfDay,
  monthsUntil,
  mulPaise,
  randomInt,
  rngFor,
  roundHalfAwayFromZero,
  rupeesToPaise,
  seasonOfMonth,
  toGameDate,
} from '../src';

describe('rng', () => {
  it('hashSeed is a deterministic unsigned 32-bit hash that respects part boundaries', () => {
    expect(hashSeed('region', 1, 'plot')).toBe(hashSeed('region', 1, 'plot'));
    expect(hashSeed('a', 1)).not.toBe(hashSeed('a1'));
    expect(hashSeed('a', 1)).not.toBe(hashSeed(1, 'a'));
    expect(hashSeed(1)).not.toBe(hashSeed('1'));
    for (const parts of [[0], ['x'], [2 ** 40, 'y', -3]] as (string | number)[][]) {
      const h = hashSeed(...parts);
      expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
    }
  });

  it('createRng replays the same sequence for the same seed and differs across seeds', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 20 }, a);
    expect(Array.from({ length: 20 }, b)).toEqual(seqA);
    expect(Array.from({ length: 20 }, c)).not.toEqual(seqA);
  });

  it('produces floats in [0,1) with a roughly uniform mean', () => {
    const random = rngFor('uniformity');
    let sum = 0;
    for (let i = 0; i < 10_000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      sum += value;
    }
    expect(sum / 10_000).toBeCloseTo(0.5, 1);
  });

  it('rngFor equals createRng(hashSeed(...)) and randomInt stays in range', () => {
    expect(rngFor('w', 7)()).toBe(createRng(hashSeed('w', 7))());
    const random = rngFor('ints');
    for (let i = 0; i < 1000; i++) {
      const n = randomInt(random, 3, 6);
      expect(n >= 3 && n <= 6 && Number.isInteger(n)).toBe(true);
    }
  });
});

describe('money', () => {
  it('assertPaise accepts safe integers only', () => {
    expect(assertPaise(150)).toBe(150);
    expect(assertPaise(-150)).toBe(-150);
    expect(() => assertPaise(1.5)).toThrow(RangeError);
    expect(() => assertPaise(Number.NaN)).toThrow(RangeError);
    expect(() => assertPaise(2 ** 53)).toThrow(/safe integer/);
  });

  it('rounds half away from zero, absorbing binary floating-point error', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(2.4999)).toBe(2);
    expect(rupeesToPaise(1.005)).toBe(101);
    expect(rupeesToPaise(19.99)).toBe(1999);
    expect(rupeesToPaise(-0.015)).toBe(-2);
  });

  it('mulPaise and applyBps round half away from zero', () => {
    expect(mulPaise(5, 0.5)).toBe(3);
    expect(mulPaise(-5, 0.5)).toBe(-3);
    expect(mulPaise(1000, 1.0825)).toBe(1083);
    expect(applyBps(12345, 100)).toBe(123);
    expect(applyBps(50, 100)).toBe(1);
    expect(applyBps(-50, 100)).toBe(-1);
    expect(applyBps(49, 100)).toBe(0);
    expect(applyBps(10_000, 12.5)).toBe(13);
  });

  it('applyBps stays exact for very large amounts', () => {
    expect(applyBps(9_000_000_000_000_000, 200)).toBe(180_000_000_000_000);
    expect(applyBps(9_007_199_254_740_991, 10_000)).toBe(9_007_199_254_740_991);
  });

  it('formats rupees with Indian digit grouping', () => {
    expect(formatInr(12_345_678)).toBe('₹1,23,456.78');
    expect(formatInr(0)).toBe('₹0.00');
    expect(formatInr(5)).toBe('₹0.05');
    expect(formatInr(99_900)).toBe('₹999.00');
    expect(formatInr(-150_000)).toBe('-₹1,500.00');
    expect(formatInr(123_456_789_012)).toBe('₹1,23,45,67,890.12');
    expect(formatInr(12_345_678, { decimals: false })).toBe('₹1,23,457');
  });

  it('formats compact lakh and crore amounts', () => {
    expect(formatInr(12_345_678, { compact: true })).toBe('₹1.23 L');
    expect(formatInr(120_000_00, { compact: true })).toBe('₹1.2 L');
    expect(formatInr(500_000_00, { compact: true })).toBe('₹5 L');
    expect(formatInr(2_500_000_000, { compact: true })).toBe('₹2.5 Cr');
    expect(formatInr(9_999_999_99, { compact: true })).toBe('₹1 Cr');
    expect(formatInr(45_000_00, { compact: true })).toBe('₹45,000');
    expect(formatInr(-250_000_00, { compact: true })).toBe('-₹2.5 L');
  });
});

describe('calendar', () => {
  it('maps day 0 to 1 June, Year 1 (Kharif)', () => {
    expect(toGameDate(0)).toEqual({
      day: 0,
      year: 1,
      month: 6,
      dayOfMonth: 1,
      dayOfYear: 150,
      season: 'kharif',
      label: '1 Jun, Year 1',
    });
  });

  it('rolls into calendar Year 2 on 1 January and wraps every 360 days', () => {
    expect(toGameDate(209).label).toBe('30 Dec, Year 1');
    const jan = toGameDate(210);
    expect(jan).toMatchObject({ year: 2, month: 1, dayOfMonth: 1, dayOfYear: 0, season: 'rabi' });
    expect(toGameDate(359).label).toBe('30 May, Year 2');
    expect(toGameDate(360).label).toBe('1 Jun, Year 2');
    expect(toGameDate(41)).toMatchObject({ month: 7, dayOfMonth: 12, label: '12 Jul, Year 1' });
  });

  it('assigns seasons Kharif Jun–Oct, Rabi Nov–Feb, Zaid Mar–May', () => {
    const seasons = Array.from({ length: 12 }, (_, i) => seasonOfMonth(i + 1));
    expect(seasons).toEqual([
      'rabi',
      'rabi',
      'zaid',
      'zaid',
      'zaid',
      'kharif',
      'kharif',
      'kharif',
      'kharif',
      'kharif',
      'rabi',
      'rabi',
    ]);
    expect(() => seasonOfMonth(13)).toThrow(RangeError);
  });

  it('monthOfDay, monthsUntil and firstDayOfMonthFrom agree with toGameDate', () => {
    for (let day = 0; day < 720; day += 7) expect(monthOfDay(day)).toBe(toGameDate(day).month);
    expect(monthsUntil(11, 2)).toBe(3);
    expect(monthsUntil(5, 5)).toBe(0);
    expect(monthsUntil(6, 5)).toBe(11);
    expect(firstDayOfMonthFrom(0, 10)).toBe(120);
    expect(firstDayOfMonthFrom(5, 6)).toBe(5);
    expect(firstDayOfMonthFrom(45, 6)).toBe(360);
    expect(toGameDate(firstDayOfMonthFrom(45, 6)).dayOfMonth).toBe(1);
  });
});
