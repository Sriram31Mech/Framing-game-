import { nextDueDay, splitInstalment } from '@bh/domain';
import { tickEvent, tickNotify, tickPost } from '../effects';
import type { TickContext } from '../types';

interface LoanRow {
  id: string;
  company_id: string;
  annual_rate_bps: number;
  term_months: number;
  emi_paise: number;
  outstanding_paise: number;
  instalments_paid: number;
  missed_payments: number;
  start_day: number;
  next_due_day: number;
  cash_paise: number;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

/**
 * Step 8 — loan instalments due on day D. Every instalment is always charged (scheduled
 * obligation, cash may go negative): interest → expense_interest, principal → loan_payable.
 * When the company could not cover the EMI from cash it counts as a missed payment (warning),
 * and negative cash drives the distress flow. The final instalment clears any rounding residue.
 */
export async function chargeLoanInstalments(ctx: TickContext): Promise<void> {
  const { rows } = await ctx.client.query<LoanRow>(
    `SELECT l.id, l.company_id, l.annual_rate_bps, l.term_months, l.emi_paise, l.outstanding_paise,
            l.instalments_paid, l.missed_payments, l.start_day, l.next_due_day, c.cash_paise
     FROM loans l JOIN companies c ON c.id = l.company_id
     WHERE c.region_id = $1 AND l.status = 'active' AND l.next_due_day <= $2
     ORDER BY l.company_id, l.id
     FOR UPDATE OF l`,
    [ctx.regionId, ctx.day],
  );
  const cash = new Map<string, number>();
  for (const loan of rows) {
    if (!cash.has(loan.company_id)) cash.set(loan.company_id, loan.cash_paise);
    let outstanding = loan.outstanding_paise;
    let paid = loan.instalments_paid;
    let missed = loan.missed_payments;
    let due = loan.next_due_day;
    // Normally exactly one instalment is due; loop defensively in case of skipped days.
    while (due <= ctx.day && outstanding > 0) {
      const split = splitInstalment(outstanding, loan.annual_rate_bps, loan.emi_paise);
      const interest = Math.max(0, split.interestPaise);
      const isFinal = paid + 1 >= loan.term_months;
      const principal = isFinal
        ? outstanding
        : Math.min(outstanding, Math.max(0, split.principalPaise));
      const payment = interest + principal;
      const cashBefore = cash.get(loan.company_id) ?? 0;
      const missedNow = cashBefore < payment;
      if (payment > 0) {
        await tickPost(ctx, {
          kind: 'loan_instalment',
          description: `Loan EMI ${paid + 1}/${loan.term_months}`,
          refType: 'loan',
          refId: loan.id,
          allowNegativeCash: true,
          entries: [
            { companyId: loan.company_id, account: 'expense_interest', amountPaise: interest },
            { companyId: loan.company_id, account: 'loan_payable', amountPaise: principal },
            { companyId: loan.company_id, account: 'cash', amountPaise: -payment },
          ],
        });
      }
      cash.set(loan.company_id, cashBefore - payment);
      outstanding -= principal;
      paid += 1;
      due = nextDueDay(loan.start_day, paid);
      ctx.stats.loanPayments++;
      if (missedNow) {
        missed += 1;
        ctx.stats.missedPayments++;
        await tickNotify(ctx, {
          companyId: loan.company_id,
          type: 'loan_payment_missed',
          severity: 'danger',
          title: 'Loan EMI not covered',
          body: `Your EMI of ${rupees(payment)} was charged but your cash could not cover it. Restore a positive balance to avoid bankruptcy.`,
          entityType: 'loan',
          entityId: loan.id,
          dedupeKey: `loan-missed:${loan.id}:${paid}`,
        });
      } else {
        await tickNotify(ctx, {
          companyId: loan.company_id,
          type: 'loan_payment',
          severity: 'info',
          title: 'Loan EMI paid',
          body: `EMI ${paid}/${loan.term_months} of ${rupees(payment)} paid (interest ${rupees(interest)}).`,
          entityType: 'loan',
          entityId: loan.id,
          dedupeKey: `loan-emi:${loan.id}:${paid}`,
        });
      }
    }
    const status = outstanding <= 0 ? 'repaid' : 'active';
    await ctx.client.query(
      `UPDATE loans SET outstanding_paise = $2, instalments_paid = $3, missed_payments = $4,
              next_due_day = $5, status = $6, version = version + 1
       WHERE id = $1`,
      [loan.id, Math.max(0, outstanding), paid, missed, due, status],
    );
    await tickEvent(ctx, {
      type: 'loan.updated',
      companyId: loan.company_id,
      entityType: 'loan',
      entityId: loan.id,
      payload: { loanId: loan.id, status, outstandingPaise: Math.max(0, outstanding) },
    });
    if (status === 'repaid') {
      await tickNotify(ctx, {
        companyId: loan.company_id,
        type: 'loan_repaid',
        severity: 'success',
        title: 'Loan repaid',
        body: 'Your loan has been fully repaid.',
        entityType: 'loan',
        entityId: loan.id,
        dedupeKey: `loan-repaid:${loan.id}`,
      });
    }
  }
}
