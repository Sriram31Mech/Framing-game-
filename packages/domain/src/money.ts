import type { Paise } from './types';

/** Throws if value is not a safe integer. Use at every money boundary. */
export function assertPaise(value: number, label = 'amount'): Paise {
  void value;
  void label;
  throw new Error('not implemented');
}

export function rupeesToPaise(rupees: number): Paise {
  void rupees;
  throw new Error('not implemented');
}

/** Multiply money by a rate and round half away from zero to an integer. */
export function mulPaise(amount: Paise, factor: number): Paise {
  void amount;
  void factor;
  throw new Error('not implemented');
}

/** amount * bps / 10_000, rounded half away from zero. */
export function applyBps(amount: Paise, bps: number): Paise {
  void amount;
  void bps;
  throw new Error('not implemented');
}

/** Indian-format currency string, e.g. 12345678 -> "₹1,23,456.78"; compact: "₹1.23 L", "₹2.5 Cr". */
export function formatInr(amount: Paise, opts?: { compact?: boolean; decimals?: boolean }): string {
  void amount;
  void opts;
  throw new Error('not implemented');
}
