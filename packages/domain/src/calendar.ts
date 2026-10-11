import type { GameDate, GameDay, Season } from './types';

export function toGameDate(day: GameDay): GameDate {
  void day;
  throw new Error('not implemented');
}

/** Kharif: Jun–Oct, Rabi: Nov–Feb, Zaid: Mar–May. */
export function seasonOfMonth(month: number): Season {
  void month;
  throw new Error('not implemented');
}

export function monthOfDay(day: GameDay): number {
  void day;
  throw new Error('not implemented');
}

/** Number of whole months (1..12 steps) from `fromMonth` until `toMonth` (0 if equal). */
export function monthsUntil(fromMonth: number, toMonth: number): number {
  void fromMonth;
  void toMonth;
  throw new Error('not implemented');
}
