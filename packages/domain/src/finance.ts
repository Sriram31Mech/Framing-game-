import type {
  BalanceSheetInput,
  GameDay,
  LoanTerms,
  Paise,
  SolvencyInput,
  SolvencyResult,
} from './types';

/** Standard amortising EMI, rounded UP to the paisa. Rate 0 => principal / n (rounded up). */
export function computeLoanTerms(
  principalPaise: Paise,
  annualRateBps: number,
  termMonths: number,
): LoanTerms {
  void principalPaise;
  void annualRateBps;
  void termMonths;
  throw new Error('not implemented');
}

/** Rate offered: base rate + risk premium from leverage (debt / assets) and past bankruptcies. */
export function loanRateBps(input: { leverage: number; bankruptcies: number }): number {
  void input;
  throw new Error('not implemented');
}

/** Maximum additional principal a company may borrow now. */
export function maxBorrowablePaise(input: {
  netAssetsPaise: Paise;
  loanOutstandingPaise: Paise;
}): Paise {
  void input;
  throw new Error('not implemented');
}

/** Split an instalment into interest and principal given outstanding principal. */
export function splitInstalment(
  outstandingPaise: Paise,
  annualRateBps: number,
  instalmentPaise: Paise,
): { interestPaise: Paise; principalPaise: Paise } {
  void outstandingPaise;
  void annualRateBps;
  void instalmentPaise;
  throw new Error('not implemented');
}

/** Straight-line depreciation for one day. */
export function dailyDepreciationPaise(
  pricePaise: Paise,
  salvageFraction: number,
  usefulLifeDays: number,
): Paise {
  void pricePaise;
  void salvageFraction;
  void usefulLifeDays;
  throw new Error('not implemented');
}

export function landTaxPaise(areaHa: number, months?: number): Paise {
  void areaHa;
  void months;
  throw new Error('not implemented');
}

export function incomeTaxPaise(annualNetProfitPaise: Paise): Paise {
  void annualNetProfitPaise;
  throw new Error('not implemented');
}

/**
 * Daily solvency check. Negative cash => 'distressed' (start grace period, DISTRESS_GRACE_DAYS).
 * Cash back >= 0 => 'active'. Still negative after grace => 'bankrupt'.
 */
export function evaluateSolvency(input: SolvencyInput): SolvencyResult {
  void input;
  throw new Error('not implemented');
}

/** Transparent valuation: assets - liabilities. */
export function companyValuationPaise(input: BalanceSheetInput): Paise {
  void input;
  throw new Error('not implemented');
}

/** Days until next instalment from a reference day. */
export function nextDueDay(startDay: GameDay, instalmentsPaid: number): GameDay {
  void startDay;
  void instalmentsPaid;
  throw new Error('not implemented');
}
