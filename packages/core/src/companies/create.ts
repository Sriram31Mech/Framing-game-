/**
 * Company founding: the one path used for human players (POST /companies) and AI companies
 * (world bootstrap). See docs/IMPLEMENTATION.md §4 "New human company".
 */
import {
  NO_STARTER_PLOT_BONUS_PAISE,
  AI_STARTING_CASH_PAISE,
  STARTING_CASH_PAISE,
  formatInr,
  type AiPersonality,
} from '@bh/domain';
import type { CoreDeps } from '../commands/types';
import type { DbClient } from '../db/pool';
import { withTransaction } from '../db/tx';
import { conflict, DomainError, notFound } from '../errors';
import { emitEvent, notify } from '../events/events';
import { postLedger } from '../ledger/ledger';
import { getCurrentGameDay } from '../world/clock';

export interface CreateCompanyInput {
  accountId: string;
  name: string;
  kind: 'human' | 'ai';
  aiPersonality?: AiPersonality;
  regionId: string;
}

export interface CreateCompanyResult {
  companyId: string;
  /** Starter parcel granted, or null when none were left (bonus cash paid instead). */
  starterParcelId: string | null;
  /** True when the account already had this company (idempotent retry). */
  existing: boolean;
}

/** Create a company in its own transaction. */
export async function createCompany(
  deps: CoreDeps,
  input: CreateCompanyInput,
): Promise<CreateCompanyResult> {
  return withTransaction(deps.pool, (client) => createCompanyInTx(client, input));
}

/**
 * Create a company inside the caller's transaction:
 * one company per account; region capacity for humans; unique name (case-insensitive);
 * starting cash (world_treasury → cash); a reserved starter plot if one is left, otherwise
 * NO_STARTER_PLOT_BONUS_PAISE extra cash; a welcome notification.
 *
 * Retrying with the same account and the same name returns the existing company (idempotent).
 */
export async function createCompanyInTx(
  client: DbClient,
  input: CreateCompanyInput,
): Promise<CreateCompanyResult> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (input.kind === 'ai' && !input.aiPersonality) {
    throw new DomainError('VALIDATION_FAILED', 'AI companies need a personality');
  }

  // Serialise per account (one company per account) ...
  const account = await client.query<{ id: string }>(
    'SELECT id FROM accounts WHERE id = $1 FOR UPDATE',
    [input.accountId],
  );
  if (account.rowCount === 0) throw notFound('Account', input.accountId);

  const existing = await client.query<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM company_memberships m JOIN companies c ON c.id = m.company_id
     WHERE m.account_id = $1`,
    [input.accountId],
  );
  const prior = existing.rows[0];
  if (prior) {
    if (prior.name.toLowerCase() === name.toLowerCase()) {
      return { companyId: prior.id, starterParcelId: null, existing: true };
    }
    throw conflict('This account already has a company', { companyId: prior.id });
  }

  // ... and per region (capacity count + starter plot allocation).
  const region = await client.query<{ max_human_companies: number }>(
    'SELECT max_human_companies FROM regions WHERE id = $1 FOR UPDATE',
    [input.regionId],
  );
  const regionRow = region.rows[0];
  if (!regionRow) throw notFound('Region', input.regionId);

  if (input.kind === 'human') {
    const { rows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM companies WHERE region_id = $1 AND kind = 'human'`,
      [input.regionId],
    );
    if ((rows[0]?.n ?? 0) >= regionRow.max_human_companies) {
      throw new DomainError('LIMIT_EXCEEDED', 'This region is full; no more companies can join', {
        maxHumanCompanies: regionRow.max_human_companies,
      });
    }
  }

  const taken = await client.query(
    'SELECT 1 FROM companies WHERE region_id = $1 AND lower(name) = lower($2)',
    [input.regionId, name],
  );
  if ((taken.rowCount ?? 0) > 0) throw conflict('That company name is already taken');

  const day = await getCurrentGameDay(client, input.regionId);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO companies (region_id, name, kind, ai_personality, cash_paise, founded_day, last_active_day)
     VALUES ($1, $2, $3, $4, 0, $5, $5) RETURNING id`,
    [input.regionId, name, input.kind, input.aiPersonality ?? null, day],
  );
  const companyId = inserted.rows[0]!.id;
  await client.query(
    `INSERT INTO company_memberships (company_id, account_id, role) VALUES ($1, $2, 'owner')`,
    [companyId, input.accountId],
  );

  const startingCash = input.kind === 'ai' ? AI_STARTING_CASH_PAISE : STARTING_CASH_PAISE;
  await postLedger(client, {
    regionId: input.regionId,
    kind: 'starting_capital',
    description: `Starting capital for ${name}`,
    gameDay: day,
    refType: 'company',
    refId: companyId,
    entries: [
      { companyId, account: 'cash', amountPaise: startingCash },
      { companyId: null, account: 'world_treasury', amountPaise: -startingCash },
    ],
  });

  // Grant a reserved starter plot. SKIP LOCKED lets concurrent foundings in other regions
  // (or a future relaxed region lock) pick different plots without waiting.
  const plot = await client.query<{ id: string; area_ha: number }>(
    `SELECT id, area_ha FROM land_parcels
     WHERE region_id = $1 AND status = 'reserved' AND is_starter_plot AND owner_company_id IS NULL
     ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [input.regionId],
  );
  const starter = plot.rows[0];
  let starterParcelId: string | null = null;
  if (starter) {
    starterParcelId = starter.id;
    await client.query(
      `UPDATE land_parcels SET owner_company_id = $2, status = 'owned', list_price_paise = NULL,
         version = version + 1, updated_at = now()
       WHERE id = $1`,
      [starter.id, companyId],
    );
    await client.query(
      `INSERT INTO land_ownership_history (parcel_id, from_company_id, to_company_id, price_paise, reason, game_day)
       VALUES ($1, NULL, $2, 0, 'starter_grant', $3)`,
      [starter.id, companyId, day],
    );
    await emitEvent(client, {
      regionId: input.regionId,
      type: 'parcel.ownership_changed',
      gameDay: day,
      companyId: null,
      actorCompanyId: companyId,
      entityType: 'parcel',
      entityId: starter.id,
      payload: {
        parcelId: starter.id,
        ownerCompanyId: companyId,
        status: 'owned',
        listPricePaise: null,
      },
    });
  } else {
    await postLedger(client, {
      regionId: input.regionId,
      kind: 'starter_bonus',
      description: 'Cash grant in lieu of a starter plot',
      gameDay: day,
      refType: 'company',
      refId: companyId,
      entries: [
        { companyId, account: 'cash', amountPaise: NO_STARTER_PLOT_BONUS_PAISE },
        { companyId: null, account: 'world_treasury', amountPaise: -NO_STARTER_PLOT_BONUS_PAISE },
      ],
    });
  }

  await notify(client, {
    regionId: input.regionId,
    companyId,
    type: 'welcome',
    severity: 'success',
    title: `Welcome to the valley, ${name}!`,
    body: starterParcelId
      ? `You start with ${formatInr(STARTING_CASH_PAISE, { compact: true })} and starter plot ${starterParcelId}. Check its crop suitability and plant when the sowing window opens.`
      : `You start with ${formatInr(STARTING_CASH_PAISE + NO_STARTER_PLOT_BONUS_PAISE, { compact: true })} (no starter plots were left, so you received extra cash). Buy or lease land to begin farming.`,
    gameDay: day,
    entityType: 'company',
    entityId: companyId,
    dedupeKey: 'welcome',
  });

  const cash = await client.query<{ cash_paise: number }>(
    'SELECT cash_paise FROM companies WHERE id = $1',
    [companyId],
  );
  await emitEvent(client, {
    regionId: input.regionId,
    type: 'company.updated',
    gameDay: day,
    companyId,
    actorCompanyId: companyId,
    entityType: 'company',
    entityId: companyId,
    payload: { cashPaise: cash.rows[0]?.cash_paise ?? 0, status: 'active' },
  });

  return { companyId, starterParcelId, existing: false };
}
