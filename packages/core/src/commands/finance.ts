/**
 * Loans from the state bank. docs/IMPLEMENTATION.md §4 "Loans".
 * Instalments (EMI every 30 days) are collected by the daily tick; here: borrowing and early
 * (principal) repayment, which carries no penalty.
 */
import { computeLoanTerms, MAX_LOAN_TERM_MONTHS, nextDueDay } from '@bh/domain';
import { computeBalanceSheet, loanOfferFor } from '../companies/valuation';
import { DomainError, forbidden, notFound, ruleViolation } from '../errors';
import { emitEvent } from '../events/events';
import { postLedger } from '../ledger/ledger';
import { lockParties, type CommandContext } from './context';
import type { GameCommand } from './types';

type Cmd<T extends GameCommand['type']> = Extract<GameCommand, { type: T }>;

/** Cap on simultaneously active loans per company. */
export const MAX_ACTIVE_LOANS = 5;

async function emitLoanUpdated(
  ctx: CommandContext,
  loanId: string,
  status: string,
  outstandingPaise: number,
): Promise<void> {
  await emitEvent(ctx.client, {
    regionId: ctx.regionId,
    type: 'loan.updated',
    gameDay: ctx.day,
    companyId: ctx.actor.companyId,
    actorCompanyId: ctx.actor.companyId,
    entityType: 'loan',
    entityId: loanId,
    payload: { loanId, status, outstandingPaise },
  });
}

export async function takeLoan(ctx: CommandContext, cmd: Cmd<'take_loan'>) {
  const me = ctx.actor.companyId;
  if (cmd.termMonths < 1 || cmd.termMonths > MAX_LOAN_TERM_MONTHS) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Loan terms run 1 to ${MAX_LOAN_TERM_MONTHS} months`,
    );
  }
  // Lock first so the balance sheet the offer is based on cannot change underneath us.
  await lockParties(ctx);
  const active = await ctx.client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM loans WHERE company_id = $1 AND status = 'active'`,
    [me],
  );
  if ((active.rows[0]?.n ?? 0) >= MAX_ACTIVE_LOANS) {
    throw new DomainError('LIMIT_EXCEEDED', `At most ${MAX_ACTIVE_LOANS} active loans`);
  }
  const offer = loanOfferFor(await computeBalanceSheet(ctx.client, ctx.regionId, me));
  if (cmd.expectedRateBps !== offer.annualRateBps) {
    throw new DomainError('PRICE_CHANGED', 'The interest rate offered has changed', {
      expected: cmd.expectedRateBps,
      actual: offer.annualRateBps,
    });
  }
  if (cmd.principalPaise > offer.maxPrincipalPaise) {
    throw new DomainError('LIMIT_EXCEEDED', 'This exceeds what the bank will lend you', {
      maxPrincipalPaise: offer.maxPrincipalPaise,
    });
  }
  const terms = computeLoanTerms(cmd.principalPaise, offer.annualRateBps, cmd.termMonths);
  const { rows } = await ctx.client.query<{ id: string; next_due_day: number }>(
    `INSERT INTO loans (company_id, principal_paise, annual_rate_bps, term_months, emi_paise,
       outstanding_paise, start_day, next_due_day, status)
     VALUES ($1, $2, $3, $4, $5, $2, $6, $7, 'active') RETURNING id, next_due_day`,
    [
      me,
      terms.principalPaise,
      terms.annualRateBps,
      terms.termMonths,
      terms.emiPaise,
      ctx.day,
      nextDueDay(ctx.day, 0),
    ],
  );
  const loanId = rows[0]!.id;
  await postLedger(ctx.client, {
    regionId: ctx.regionId,
    kind: 'loan_disbursement',
    description: `Loan of ${terms.principalPaise} paise over ${terms.termMonths} months`,
    gameDay: ctx.day,
    refType: 'loan',
    refId: loanId,
    entries: [
      { companyId: me, account: 'cash', amountPaise: terms.principalPaise },
      { companyId: me, account: 'loan_payable', amountPaise: -terms.principalPaise },
    ],
  });
  await emitLoanUpdated(ctx, loanId, 'active', terms.principalPaise);
  return {
    loanId,
    principalPaise: terms.principalPaise,
    annualRateBps: terms.annualRateBps,
    termMonths: terms.termMonths,
    emiPaise: terms.emiPaise,
    totalRepayablePaise: terms.totalRepayablePaise,
    nextDueDay: rows[0]!.next_due_day,
  };
}

export async function repayLoan(ctx: CommandContext, cmd: Cmd<'repay_loan'>) {
  const me = ctx.actor.companyId;
  const { rows } = await ctx.client.query<{
    id: string;
    company_id: string;
    outstanding_paise: number;
    status: string;
  }>('SELECT id, company_id, outstanding_paise, status FROM loans WHERE id = $1 FOR UPDATE', [
    cmd.loanId,
  ]);
  const loan = rows[0];
  if (!loan) throw notFound('Loan', cmd.loanId);
  if (loan.company_id !== me) throw forbidden('This is not your loan');
  if (loan.status !== 'active') throw ruleViolation('This loan is not active');
  await lockParties(ctx);

  // Repaying more than is owed simply settles the loan.
  const pay = Math.min(cmd.amountPaise, loan.outstanding_paise);
  const outstanding = loan.outstanding_paise - pay;
  const status = outstanding === 0 ? 'repaid' : 'active';
  await postLedger(ctx.client, {
    regionId: ctx.regionId,
    kind: 'loan_prepayment',
    description: status === 'repaid' ? 'Loan repaid in full' : 'Early loan repayment',
    gameDay: ctx.day,
    refType: 'loan',
    refId: loan.id,
    entries: [
      { companyId: me, account: 'loan_payable', amountPaise: pay },
      { companyId: me, account: 'cash', amountPaise: -pay },
    ],
  });
  await ctx.client.query(
    `UPDATE loans SET outstanding_paise = $2, status = $3, version = version + 1 WHERE id = $1`,
    [loan.id, outstanding, status],
  );
  await emitLoanUpdated(ctx, loan.id, status, outstanding);
  return { loanId: loan.id, paidPaise: pay, outstandingPaise: outstanding, status };
}
