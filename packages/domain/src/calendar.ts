import { DAYS_PER_MONTH, DAYS_PER_YEAR, MONTHS_PER_YEAR, START_MONTH } from './constants';
import type { GameDate, GameDay, Season } from './types';

export const MONTH_SHORT_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Days from 1 January of Year 1 to game day 0 (1 June). */
const START_OFFSET_DAYS = (START_MONTH - 1) * DAYS_PER_MONTH;

function floorMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * Calendar years run January–December. Game day 0 is 1 June of Year 1, so Year 1 has
 * only its June–December part; 1 January of Year 2 is game day 210.
 */
export function toGameDate(day: GameDay): GameDate {
  if (!Number.isInteger(day)) throw new RangeError(`game day must be an integer, got ${day}`);
  const absolute = day + START_OFFSET_DAYS;
  const year = Math.floor(absolute / DAYS_PER_YEAR) + 1;
  const dayOfYear = floorMod(absolute, DAYS_PER_YEAR);
  const month = Math.floor(dayOfYear / DAYS_PER_MONTH) + 1;
  const dayOfMonth = (dayOfYear % DAYS_PER_MONTH) + 1;
  return {
    day,
    year,
    month,
    dayOfMonth,
    dayOfYear,
    season: seasonOfMonth(month),
    label: `${dayOfMonth} ${MONTH_SHORT_NAMES[month - 1]}, Year ${year}`,
  };
}

/** Kharif: Jun–Oct, Rabi: Nov–Feb, Zaid: Mar–May. */
export function seasonOfMonth(month: number): Season {
  if (!Number.isInteger(month) || month < 1 || month > MONTHS_PER_YEAR) {
    throw new RangeError(`month must be 1..12, got ${month}`);
  }
  if (month >= 6 && month <= 10) return 'kharif';
  if (month >= 3 && month <= 5) return 'zaid';
  return 'rabi';
}

export function monthOfDay(day: GameDay): number {
  return Math.floor(floorMod(day + START_OFFSET_DAYS, DAYS_PER_YEAR) / DAYS_PER_MONTH) + 1;
}

/** Number of whole months (1..12 steps) from `fromMonth` until `toMonth` (0 if equal). */
export function monthsUntil(fromMonth: number, toMonth: number): number {
  return floorMod(toMonth - fromMonth, MONTHS_PER_YEAR);
}

/** The first game day on or after `day` that falls on the 1st of `month`, or `day` itself if already in it. */
export function firstDayOfMonthFrom(day: GameDay, month: number): GameDay {
  const current = toGameDate(day);
  const months = monthsUntil(current.month, month);
  if (months === 0) return day;
  return day - (current.dayOfMonth - 1) + months * DAYS_PER_MONTH;
}
