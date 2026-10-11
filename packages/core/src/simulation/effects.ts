/**
 * Thin wrappers around the shared ledger/event/notification primitives that stamp the tick's
 * region + day and count what was written (stats are persisted on the checkpoint row).
 */
import { emitEvent, notify, type EmitEventInput, type NotifyInput } from '../events/events';
import { postLedger, type LedgerTransactionInput } from '../ledger/ledger';
import type { TickContext } from './types';

export async function tickPost(
  ctx: TickContext,
  tx: Omit<LedgerTransactionInput, 'regionId' | 'gameDay'>,
): Promise<string> {
  const id = await postLedger(ctx.client, { ...tx, regionId: ctx.regionId, gameDay: ctx.day });
  ctx.stats.ledgerTransactions++;
  for (const e of tx.entries) {
    if (e.companyId !== null && (e.account === 'cash' || e.account === 'escrow')) {
      ctx.touchedCompanies.add(e.companyId);
    }
  }
  return id;
}

export async function tickEvent(
  ctx: TickContext,
  e: Omit<EmitEventInput, 'regionId' | 'gameDay'> & { gameDay?: number },
): Promise<void> {
  await emitEvent(ctx.client, { gameDay: ctx.day, ...e, regionId: ctx.regionId });
  ctx.stats.events++;
}

export async function tickNotify(
  ctx: TickContext,
  n: Omit<NotifyInput, 'regionId' | 'gameDay'>,
): Promise<boolean> {
  const id = await notify(ctx.client, { ...n, regionId: ctx.regionId, gameDay: ctx.day });
  if (id === null) return false;
  ctx.stats.notifications++;
  // notify() also emits `notification.created`.
  ctx.stats.events++;
  return true;
}

/** Private `company.updated` event with the company's current cash and status. */
export async function emitCompanyUpdated(ctx: TickContext, companyId: string): Promise<void> {
  const { rows } = await ctx.client.query<{ cash_paise: number; status: string }>(
    'SELECT cash_paise, status FROM companies WHERE id = $1',
    [companyId],
  );
  const row = rows[0];
  if (!row) return;
  await tickEvent(ctx, {
    type: 'company.updated',
    companyId,
    entityType: 'company',
    entityId: companyId,
    payload: { cashPaise: row.cash_paise, status: row.status },
  });
}

/** Chunk an array for batched SQL. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
