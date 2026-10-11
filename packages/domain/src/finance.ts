import {
  BASE_LOAN_RATE_BPS,
  DAYS_PER_MONTH,
  DISTRESS_GRACE_DAYS,
  INCOME_TAX_BPS,
  LAND_TAX_PAISE_PER_HA_PER_MONTH,
  MAX_LOAN_TERM_MONTHS,
  MAX_LOAN_TO_NET_ASSETS,
  MIN_LOAN_CAP_PAISE,
} from './constants';
import { applyBps, assertPaise, mulPaise, roundHalfAwayFromZero } from './money';
import type {
  BalanceSheetInput,
  GameDay,
  LoanTerms,
  Paise,
  SolvencyInput,
  SolvencyResult,
} from './types';

/** Highest rate any borrower is offered, bps. */
export const MAX_LOAN_RATE_BPS = 2400;
/** Leverage (debt / assets) below which no risk premium applies. */
const LEVERAGE_PREMIUM_THRESHOLD = 0.2;
/** Premium per unit of leverage above the threshold, bps. */
const LEVERAGE_PREMIUM_BPS = 1500;
/** Premium per past bankruptcy, bps. */
const BANKRUPTCY_PREMIUM_BPS = 300;

/** Monthly (30-day) rate as a fraction for an annual rate in bps. */
function monthlyRate(annualRateBps: number): number {
  return annualRateBps / 10_000 / 12;
}

/** Standard amortising EMI, rounded UP to the paisa. Rate 0 => principal / n (rounded up). */
export function computeLoanTerms(
  principalPaise: Paise,
  annualRateBps: number,
  termMonths: number,
): LoanTerms {
  assertPaise(principalPaise, 'principal');
  if (principalPaise <= 0) throw new RangeError('principal must be positive');
  if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > MAX_LOAN_TERM_MONTHS) {
    throw new RangeError(`termMonths must be 1..${MAX_LOAN_TERM_MONTHS}, got ${termMonths}`);
  }
  if (!Number.isFinite(annualRateBps) || annualRateBps < 0) {
    throw new RangeError(`annualRateBps must be >= 0, got ${annualRateBps}`);
  }
  const r = monthlyRate(annualRateBps);
  const exact =
    r === 0
      ? principalPaise / termMonths
      : (principalPaise * r * (1 + r) ** termMonths) / ((1 + r) ** termMonths - 1);
  // Tolerance keeps an exact integer EMI from being pushed up by floating-point noise.
  const emiPaise = assertPaise(Math.ceil(exact - 1e-7), 'EMI');
  return {
    principalPaise,
    annualRateBps,
    termMonths,
    emiPaise,
    totalRepayablePaise: assertPaise(emiPaise * termMonths, 'total repayable'),
  };
}

/** Rate offered: base rate + risk premium from leverage (debt / assets) and past bankruptcies. */
export function loanRateBps(input: { leverage: number; bankruptcies: number }): number {
  const leverage = Number.isFinite(input.leverage) ? Math.max(0, input.leverage) : 0;
  const bankruptcies = Math.max(0, Math.floor(input.bankruptcies));
  const premium =
    Math.max(0, leverage - LEVERAGE_PREMIUM_THRESHOLD) * LEVERAGE_PREMIUM_BPS +
    bankruptcies * BANKRUPTCY_PREMIUM_BPS;
  return Math.min(MAX_LOAN_RATE_BPS, Math.round(BASE_LOAN_RATE_BPS + premium));
}

/**
 * Maximum additional principal a company may borrow now: MAX_LOAN_TO_NET_ASSETS × net assets
 * (at least MIN_LOAN_CAP_PAISE while net assets are positive) minus what is already owed.
 */
export function maxBorrowablePaise(input: {
  netAssetsPaise: Paise;
  loanOutstandingPaise: Paise;
}): Paise {
  if (input.netAssetsPaise <= 0) return 0;
  const cap = Math.max(
    MIN_LOAN_CAP_PAISE,
    Math.floor(input.netAssetsPaise * MAX_LOAN_TO_NET_ASSETS),
  );
  return assertPaise(Math.max(0, cap - Math.max(0, input.loanOutstandingPaise)), 'borrowable');
}

/**
 * Split an instalment into interest and principal given outstanding principal.
 * Interest = one month on the outstanding balance (rounded half away from zero). If the
 * instalment does not cover the interest, it is all interest; principal never exceeds what is
 * outstanding (so the final payment due is interest + remaining principal).
 */
export function splitInstalment(
  outstandingPaise: Paise,
  annualRateBps: number,
  instalmentPaise: Paise,
): { interestPaise: Paise; principalPaise: Paise } {
  assertPaise(outstandingPaise, 'outstanding');
  assertPaise(instalmentPaise, 'instalment');
  if (outstandingPaise <= 0 || instalmentPaise <= 0) return { interestPaise: 0, principalPaise: 0 };
  const interest = mulPaise(outstandingPaise, monthlyRate(annualRateBps));
  if (instalmentPaise <= interest) return { interestPaise: instalmentPaise, principalPaise: 0 };
  return {
    interestPaise: interest,
    principalPaise: Math.min(outstandingPaise, instalmentPaise - interest),
  };
}

/** Straight-line depreciation for one day. */
export function dailyDepreciationPaise(
  pricePaise: Paise,
  salvageFraction: number,
  usefulLifeDays: number,
): Paise {
  if (usefulLifeDays <= 0 || pricePaise <= 0) return 0;
  const depreciable = pricePaise * (1 - Math.min(1, Math.max(0, salvageFraction)));
  return assertPaise(roundHalfAwayFromZero(depreciable / usefulLifeDays), 'depreciation');
}

/** Land tax for `areaHa` over `months` 30-day months (default 1). */
export function landTaxPaise(areaHa: number, months = 1): Paise {
  if (areaHa <= 0 || months <= 0) return 0;
  return mulPaise(LAND_TAX_PAISE_PER_HA_PER_MONTH, areaHa * months);
}

export function incomeTaxPaise(annualNetProfitPaise: Paise): Paise {
  assertPaise(annualNetProfitPaise, 'net profit');
  return annualNetProfitPaise > 0 ? applyBps(annualNetProfitPaise, INCOME_TAX_BPS) : 0;
}

/**
 * Daily solvency check. Negative cash => 'distressed' (start grace period, DISTRESS_GRACE_DAYS).
 * Cash back >= 0 => 'active'. Still negative after grace => 'bankrupt'.
 *
 * A 'bankrupt' input is returned unchanged: liquidation (and the restart as 'active') is the
 * caller's job. `graceDaysRemaining` counts down from DISTRESS_GRACE_DAYS on the day distress
 * starts to 1 on the last day; bankruptcy is declared when it would reach 0.
 */
export function evaluateSolvency(input: SolvencyInput): SolvencyResult {
  const { cashPaise, status, day } = input;
  if (status === 'bankrupt') {
    return {
      status,
      distressSinceDay: input.distressSinceDay,
      graceDaysRemaining: null,
      changed: false,
    };
  }
  if (cashPaise >= 0) {
    return {
      status: 'active',
      distressSinceDay: null,
      graceDaysRemaining: null,
      changed: status !== 'active',
    };
  }
  if (status === 'active') {
    return {
      status: 'distressed',
      distressSinceDay: day,
      graceDaysRemaining: DISTRESS_GRACE_DAYS,
      changed: true,
    };
  }
  const since = input.distressSinceDay ?? day;
  const remaining = DISTRESS_GRACE_DAYS - (day - since);
  if (remaining <= 0) {
    return { status: 'bankrupt', distressSinceDay: since, graceDaysRemaining: 0, changed: true };
  }
  return {
    status: 'distressed',
    distressSinceDay: since,
    graceDaysRemaining: remaining,
    changed: false,
  };
}

/** Transparent valuation: assets - liabilities. */
export function companyValuationPaise(input: BalanceSheetInput): Paise {
  const assets =
    input.cashPaise +
    input.inventoryValuePaise +
    input.landValuePaise +
    input.machineryBookValuePaise +
    input.escrowPaise;
  return assertPaise(assets - input.loanOutstandingPaise, 'valuation');
}

/** Day the next instalment falls due: every 30 days from the loan's start day. */
export function nextDueDay(startDay: GameDay, instalmentsPaid: number): GameDay {
  return startDay + DAYS_PER_MONTH * (Math.max(0, instalmentsPaid) + 1);
}
