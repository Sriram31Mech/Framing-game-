/**
 * Ledger posting patterns used by the daily tick. Every money movement goes through postLedger
 * (balanced, same DB transaction as the state change). Conventions (company perspective,
 * positive = debit):
 *
 * - Paying the world (suppliers, state, bank interest): Dr expense_* / Cr cash.
 * - Receiving from the world as a capital injection (restart grant, deficit write-off):
 *   Dr cash / Cr world_treasury — the same pattern the backend uses for starting cash.
 * - Non-cash write-downs (depreciation, spoilage): Dr expense_* / Cr asset account.
 *
 * Scheduled obligations (irrigation, EMIs, taxes, maintenance, contract penalties) are charged
 * with allowNegativeCash: cash may go negative, which then drives the distress/bankruptcy flow.
 */
import type { CompanyAccount } from '../ledger/ledger';
import { tickPost } from './effects';
import type { TickContext } from './types';

export async function chargeExpense(
  ctx: TickContext,
  input: {
    companyId: string;
    account: CompanyAccount;
    amountPaise: number;
    kind: string;
    description: string;
    refType?: string;
    refId?: string;
  },
): Promise<void> {
  if (input.amountPaise <= 0) return;
  await tickPost(ctx, {
    kind: input.kind,
    description: input.description,
    refType: input.refType,
    refId: input.refId,
    allowNegativeCash: true,
    entries: [
      { companyId: input.companyId, account: input.account, amountPaise: input.amountPaise },
      { companyId: input.companyId, account: 'cash', amountPaise: -input.amountPaise },
    ],
  });
}

/** Sum of a company's ledger balance for one account (debit positive). */
export async function accountBalance(
  ctx: TickContext,
  companyId: string,
  account: CompanyAccount,
): Promise<number> {
  const { rows } = await ctx.client.query<{ total: number }>(
    `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total
     FROM ledger_entries WHERE company_id = $1 AND account_code = $2`,
    [companyId, account],
  );
  return Number(rows[0]?.total ?? 0);
}
