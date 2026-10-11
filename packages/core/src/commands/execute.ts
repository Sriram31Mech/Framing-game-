/**
 * executeCommand — the single write path for gameplay state (humans via HTTP, AI via the
 * scheduler). One database transaction per command:
 *
 *   1. actor company check (exists, same region, status permits the command)
 *   2. idempotency claim: INSERT a placeholder row for (company, key). A concurrent request with
 *      the same key blocks on the unique index until we commit, then replays our stored outcome.
 *      An existing row with the same request hash is replayed; a different hash → 422.
 *   3. SAVEPOINT; run the handler (locks, validation, ledger, events); release
 *   4. on DomainError: ROLLBACK TO SAVEPOINT (no state change) but still store the error outcome,
 *      so a retried failed command returns the same failure
 *   5. store the outcome on the idempotency row; COMMIT
 *
 * Unexpected errors are not stored: the whole transaction rolls back and the error is rethrown
 * (deadlocks/serialization failures are retried by withTransaction).
 */
import { IdempotencyKey } from '@bh/contracts';
import { findCompany } from '../companies/company';
import { withTransaction } from '../db/tx';
import { DomainError, isDomainError } from '../errors';
import { emitEvent } from '../events/events';
import { getCurrentGameDay } from '../world/clock';
import { canonicalJson, sha256Hex, type CommandContext } from './context';
import { acceptContract, cancelContract, createContract, deliverContract } from './contracts';
import { clearPlot, harvest, plant, plotOperation } from './farming';
import { repayLoan, takeLoan } from './finance';
import { delistParcel, leaseParcel, listParcel, purchaseParcel, sellParcelToState } from './land';
import { buyListing, cancelListing, createListing } from './listings';
import { buyMachinery, sellMachinery } from './machinery';
import { sellToMarket } from './market';
import { markNotificationsRead } from './notifications';
import type {
  Actor,
  CommandOutcome,
  CoreDeps,
  ExecuteOptions,
  GameCommand,
  GameCommandType,
} from './types';

/**
 * Commands a distressed company may still run: ways to raise cash or reduce obligations
 * (sell, repay, delist) plus harvesting/clearing so produce can be sold, and housekeeping.
 */
export const DISTRESSED_ALLOWED_COMMANDS: ReadonlySet<GameCommandType> = new Set<GameCommandType>([
  'sell_to_market',
  'create_listing',
  'cancel_listing',
  'list_parcel',
  'delist_parcel',
  'sell_parcel_to_state',
  'sell_machinery',
  'repay_loan',
  'deliver_contract',
  'harvest',
  'clear_plot',
  'mark_notifications_read',
]);

/** Commands a bankrupt company may still run (it is being liquidated). */
const BANKRUPT_ALLOWED_COMMANDS: ReadonlySet<GameCommandType> = new Set<GameCommandType>([
  'mark_notifications_read',
]);

/** Commands that do not count as "activity" (they do not reset the away summary). */
const PASSIVE_COMMANDS: ReadonlySet<GameCommandType> = new Set<GameCommandType>([
  'mark_notifications_read',
]);

type StoredOutcome =
  | { ok: true; gameDay: number; result: unknown }
  | {
      ok: false;
      status: number;
      error: { code: DomainError['code']; message: string; details?: unknown };
    };

function errorOutcome(err: DomainError): Extract<StoredOutcome, { ok: false }> {
  return { ok: false, status: err.status, error: err.toJSON().error };
}

/** sha256 of the canonical command JSON; replays must match it exactly. */
export function commandRequestHash(command: GameCommand): string {
  return sha256Hex(canonicalJson(command));
}

async function dispatch(ctx: CommandContext, command: GameCommand): Promise<unknown> {
  switch (command.type) {
    case 'purchase_parcel':
      return purchaseParcel(ctx, command);
    case 'lease_parcel':
      return leaseParcel(ctx, command);
    case 'list_parcel':
      return listParcel(ctx, command);
    case 'delist_parcel':
      return delistParcel(ctx, command);
    case 'sell_parcel_to_state':
      return sellParcelToState(ctx, command);
    case 'plant':
      return plant(ctx, command);
    case 'plot_operation':
      return plotOperation(ctx, command);
    case 'harvest':
      return harvest(ctx, command);
    case 'clear_plot':
      return clearPlot(ctx, command);
    case 'sell_to_market':
      return sellToMarket(ctx, command);
    case 'create_listing':
      return createListing(ctx, command);
    case 'buy_listing':
      return buyListing(ctx, command);
    case 'cancel_listing':
      return cancelListing(ctx, command);
    case 'create_contract':
      return createContract(ctx, command);
    case 'accept_contract':
      return acceptContract(ctx, command);
    case 'deliver_contract':
      return deliverContract(ctx, command);
    case 'cancel_contract':
      return cancelContract(ctx, command);
    case 'take_loan':
      return takeLoan(ctx, command);
    case 'repay_loan':
      return repayLoan(ctx, command);
    case 'buy_machinery':
      return buyMachinery(ctx, command);
    case 'sell_machinery':
      return sellMachinery(ctx, command);
    case 'mark_notifications_read':
      return markNotificationsRead(ctx, command);
    default: {
      const never: never = command;
      throw new DomainError(
        'VALIDATION_FAILED',
        `Unknown command ${(never as { type: string }).type}`,
      );
    }
  }
}

/** Map expected database errors raised inside a handler to domain errors. */
function asDomainError(err: unknown): DomainError | null {
  if (isDomainError(err)) return err;
  // @bh/domain throws RangeError for out-of-range inputs (e.g. loan term, non-integer kg).
  if (err instanceof RangeError) return new DomainError('VALIDATION_FAILED', err.message);
  const code = (err as { code?: string } | null)?.code;
  // unique_violation: a concurrent command won a race the handler's checks could not see
  // (e.g. two plantings on one parcel); the loser simply conflicts.
  if (code === '23505')
    return new DomainError('CONFLICT', 'This was changed by someone else; refresh and retry');
  // invalid_text_representation: malformed uuid ids from callers that skipped validation.
  if (code === '22P02') return new DomainError('NOT_FOUND', 'Not found');
  return null;
}

async function finalizeTouched(ctx: CommandContext, command: GameCommand): Promise<void> {
  const ids = [...ctx.touched].sort();
  if (ids.length === 0) {
    ids.push(ctx.actor.companyId);
  }
  const markActive =
    ctx.actor.kind === 'human' && !PASSIVE_COMMANDS.has(command.type) ? ctx.actor.companyId : null;
  const { rows } = await ctx.client.query<{ id: string; cash_paise: number; status: string }>(
    `UPDATE companies
     SET version = version + 1,
         last_active_day = CASE WHEN id = $2 THEN $3 ELSE last_active_day END
     WHERE id = ANY($1::uuid[])
     RETURNING id, cash_paise, status`,
    [ids, markActive, ctx.day],
  );
  for (const r of rows.sort((a, b) => a.id.localeCompare(b.id))) {
    if (!ctx.touched.has(r.id)) continue;
    await emitEvent(ctx.client, {
      regionId: ctx.regionId,
      type: 'company.updated',
      gameDay: ctx.day,
      companyId: r.id,
      actorCompanyId: ctx.actor.companyId,
      entityType: 'company',
      entityId: r.id,
      payload: { cashPaise: r.cash_paise, status: r.status },
    });
  }
}

export async function executeCommand(
  deps: CoreDeps,
  actor: Actor,
  command: GameCommand,
  opts: ExecuteOptions = {},
): Promise<CommandOutcome> {
  const key = opts.idempotencyKey;
  if (key !== undefined && !IdempotencyKey.safeParse(key).success) {
    const err = new DomainError('VALIDATION_FAILED', 'Malformed Idempotency-Key');
    return { ...errorOutcome(err), replayed: false };
  }
  const requestHash = commandRequestHash(command);

  return withTransaction(deps.pool, async (client): Promise<CommandOutcome> => {
    const company = await findCompany(client, actor.companyId);
    if (!company) {
      return {
        ...errorOutcome(new DomainError('NOT_FOUND', 'Company not found')),
        replayed: false,
      };
    }
    if (company.regionId !== actor.regionId) {
      return {
        ...errorOutcome(new DomainError('FORBIDDEN', 'Company is in a different region')),
        replayed: false,
      };
    }

    if (key !== undefined) {
      const claimed = await client.query(
        `INSERT INTO idempotency_keys (company_id, key, command, request_hash, response, status_code)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 0)
         ON CONFLICT (company_id, key) DO NOTHING`,
        [actor.companyId, key, command.type, requestHash],
      );
      if (claimed.rowCount === 0) {
        const { rows } = await client.query<{
          request_hash: string;
          response: StoredOutcome;
          status_code: number;
        }>(
          'SELECT request_hash, response, status_code FROM idempotency_keys WHERE company_id = $1 AND key = $2',
          [actor.companyId, key],
        );
        const prior = rows[0];
        if (!prior || prior.request_hash !== requestHash) {
          const err = new DomainError(
            'IDEMPOTENCY_KEY_REUSED',
            'This Idempotency-Key was already used for a different request',
          );
          return { ...errorOutcome(err), replayed: false };
        }
        return { ...prior.response, replayed: true } as CommandOutcome;
      }
    }

    let outcome: StoredOutcome;
    const statusError =
      company.status === 'bankrupt' && !BANKRUPT_ALLOWED_COMMANDS.has(command.type)
        ? new DomainError('RULE_VIOLATION', 'Your company is bankrupt and in liquidation')
        : company.status === 'distressed' && !DISTRESSED_ALLOWED_COMMANDS.has(command.type)
          ? new DomainError(
              'RULE_VIOLATION',
              'Your company is in financial distress: you may only sell assets, repay loans, harvest or delist until cash is positive',
            )
          : null;

    if (statusError) {
      outcome = errorOutcome(statusError);
    } else {
      const day = await getCurrentGameDay(client, actor.regionId);
      const ctx: CommandContext = {
        deps,
        client,
        actor,
        regionId: actor.regionId,
        day,
        touched: new Set(),
      };
      await client.query('SAVEPOINT bh_command');
      try {
        const result = await dispatch(ctx, command);
        await finalizeTouched(ctx, command);
        await client.query('RELEASE SAVEPOINT bh_command');
        outcome = { ok: true, gameDay: day, result: result ?? null };
      } catch (err) {
        const domainErr = asDomainError(err);
        if (!domainErr) throw err;
        await client.query('ROLLBACK TO SAVEPOINT bh_command');
        outcome = errorOutcome(domainErr);
      }
    }

    // Round-trip through JSON so the first response is byte-identical to later replays.
    outcome = JSON.parse(JSON.stringify(outcome)) as StoredOutcome;
    if (key !== undefined) {
      await client.query(
        `UPDATE idempotency_keys SET response = $3, status_code = $4 WHERE company_id = $1 AND key = $2`,
        [actor.companyId, key, JSON.stringify(outcome), outcome.ok ? 200 : outcome.status],
      );
    }
    return { ...outcome, replayed: false };
  });
}
