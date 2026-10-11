import type { Paise } from './types';

/** Throws if value is not a safe integer. Use at every money boundary. */
export function assertPaise(value: number, label = 'amount'): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer number of paise, got ${value}`);
  }
  return value;
}

/**
 * Round half away from zero. A tiny relative tolerance absorbs binary floating-point error,
 * so that e.g. 1.005 * 100 (= 100.49999999999999) rounds to 101 as a human would expect.
 */
export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`cannot round non-finite value ${value}`);
  const magnitude = Math.abs(value);
  const floor = Math.floor(magnitude);
  const fraction = magnitude - floor;
  const tolerance = Math.max(1e-9, magnitude * 1e-12);
  const rounded = fraction + tolerance >= 0.5 ? floor + 1 : floor;
  return value < 0 ? -rounded : rounded;
}

export function rupeesToPaise(rupees: number): Paise {
  return assertPaise(roundHalfAwayFromZero(rupees * 100), 'rupees');
}

/** Multiply money by a rate and round half away from zero to an integer. */
export function mulPaise(amount: Paise, factor: number): Paise {
  assertPaise(amount);
  if (!Number.isFinite(factor)) throw new RangeError(`factor must be finite, got ${factor}`);
  return assertPaise(roundHalfAwayFromZero(amount * factor), 'product');
}

/** amount * bps / 10_000, rounded half away from zero. */
export function applyBps(amount: Paise, bps: number): Paise {
  assertPaise(amount);
  if (!Number.isInteger(bps)) return mulPaise(amount, bps / 10_000);
  const product = amount * bps;
  if (Number.isSafeInteger(product)) {
    // Exact integer arithmetic: quotient and remainder, then round half away from zero.
    const quotient = Math.trunc(product / 10_000);
    const remainder = product - quotient * 10_000;
    const roundAway = Math.abs(remainder) * 2 >= 10_000 ? Math.sign(product) : 0;
    return assertPaise(quotient + roundAway, 'bps product');
  }
  const big = BigInt(amount) * BigInt(bps);
  const quotient = big / 10_000n;
  const remainder = big - quotient * 10_000n;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  const adjusted = absRemainder * 2n >= 10_000n ? quotient + (big < 0n ? -1n : 1n) : quotient;
  return assertPaise(Number(adjusted), 'bps product');
}

const RUPEES_PER_LAKH = 100_000;
const RUPEES_PER_CRORE = 10_000_000;

/** Indian digit grouping of a non-negative integer string: "12345678" -> "1,23,45,678". */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) groups.unshift(rest);
  return `${groups.join(',')},${lastThree}`;
}

/** Up to two decimals with trailing zeros trimmed: 1.20 -> "1.2", 2.00 -> "2". */
function trimmedDecimal(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Indian-format currency string, e.g. 12345678 -> "₹1,23,456.78"; compact: "₹1.23 L", "₹2.5 Cr".
 *
 * - `decimals` defaults to true for the full format (always two paise digits) and false for
 *   compact amounts under one lakh (rounded to whole rupees).
 * - Compact uses lakh (L) from ₹1,00,000 and crore (Cr) from ₹1,00,00,000, at most two decimals.
 * - Negative amounts are prefixed with "-", e.g. "-₹1,500.00".
 */
export function formatInr(amount: Paise, opts?: { compact?: boolean; decimals?: boolean }): string {
  assertPaise(amount);
  const sign = amount < 0 ? '-' : '';
  const absPaise = Math.abs(amount);
  const compact = opts?.compact ?? false;

  if (compact) {
    const rupees = absPaise / 100;
    const crores = rupees / RUPEES_PER_CRORE;
    const lakhs = rupees / RUPEES_PER_LAKH;
    // Compare after rounding so ₹99.999 L shows as "₹1 Cr", not "₹100 L".
    if (crores >= 1 || Number(lakhs.toFixed(2)) >= 100) {
      return `${sign}₹${groupDecimal(trimmedDecimal(crores))} Cr`;
    }
    if (lakhs >= 1) return `${sign}₹${trimmedDecimal(lakhs)} L`;
  }

  const showDecimals = opts?.decimals ?? !compact;
  if (showDecimals) {
    const rupees = Math.floor(absPaise / 100);
    const paise = absPaise % 100;
    return `${sign}₹${groupIndian(String(rupees))}.${String(paise).padStart(2, '0')}`;
  }
  const roundedRupees = roundHalfAwayFromZero(absPaise / 100);
  return `${sign}₹${groupIndian(String(roundedRupees))}`;
}

/** Applies Indian grouping to the integer part of a decimal string ("12345.5" -> "12,345.5"). */
function groupDecimal(text: string): string {
  const [integer = '0', fraction] = text.split('.');
  return fraction === undefined ? groupIndian(integer) : `${groupIndian(integer)}.${fraction}`;
}
