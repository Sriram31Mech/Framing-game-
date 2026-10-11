/**
 * Per-command execution context and helpers shared by every command handler.
 *
 * Locking order (deadlock avoidance, see docs/IMPLEMENTATION.md §4):
 *   1. the contested entity row (parcel / listing / contract / plot / loan / asset / market item)
 *   2. company rows, all at once, sorted by id (lockCompanies)
 *   3. inventory lots (ordered by id or by a deterministic consumption order)
 * Every handler follows this order, so two commands can only wait on each other, never cycle.
 */
import { createHash } from 'node:crypto';
import type { DbClient } from '../db/pool';
import { DomainError, forbidden, notFound } from '../errors';
import { lockCompanies } from '../ledger/ledger';
import type { Actor, CoreDeps } from './types';

export interface LockedCompany {
  id: string;
  cashPaise: number;
  escrowPaise: number;
  status: 'active' | 'distressed' | 'bankrupt';
  regionId: string;
}

export interface CommandContext {
  deps: CoreDeps;
  client: DbClient;
  actor: Actor;
  regionId: string;
  /** Current game day (from world_clock) used to stamp every row and ledger entry. */
  day: number;
  /** Companies locked (and possibly mutated) by this command; they get company.updated events. */
  touched: Set<string>;
}

/**
 * Lock the given companies (actor included automatically) in id order and verify they exist in
 * the actor's region. Returns the locked rows.
 */
export async function lockParties(
  ctx: CommandContext,
  otherCompanyIds: (string | null | undefined)[] = [],
): Promise<Map<string, LockedCompany>> {
  const ids = [ctx.actor.companyId, ...otherCompanyIds.filter((x): x is string => !!x)];
  const rows = await lockCompanies(ctx.client, ids);
  const out = new Map<string, LockedCompany>();
  for (const id of new Set(ids)) {
    const r = rows.get(id);
    if (!r) throw notFound('Company', id);
    if (r.region_id !== ctx.regionId) throw forbidden('Company is in a different region');
    out.set(id, {
      id: r.id,
      cashPaise: r.cash_paise,
      escrowPaise: r.escrow_paise,
      status: r.status as LockedCompany['status'],
      regionId: r.region_id,
    });
    ctx.touched.add(id);
  }
  return out;
}

/** The actor's own locked row. */
export async function lockActor(ctx: CommandContext): Promise<LockedCompany> {
  return (await lockParties(ctx)).get(ctx.actor.companyId)!;
}

/** Throws CONFLICT when a client's optimistic version guard is stale. */
export function assertVersion(entity: string, expected: number, actual: number): void {
  if (expected !== actual) {
    throw new DomainError('CONFLICT', `${entity} was changed by someone else; refresh and retry`, {
      expectedVersion: expected,
      currentVersion: actual,
    });
  }
}

/** Product of integer paise/kg that must stay a safe integer. */
export function safeMul(a: number, b: number, label: string): number {
  const v = a * b;
  if (!Number.isSafeInteger(v)) {
    throw new DomainError('VALIDATION_FAILED', `${label} is too large`);
  }
  return v;
}

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Weighted average quality (rounded) of consumed parts. */
export function weightedQuality(parts: { quality: number; kg: number }[]): number {
  let kg = 0;
  let sum = 0;
  for (const p of parts) {
    kg += p.kg;
    sum += p.quality * p.kg;
  }
  return kg === 0 ? 0 : Math.round(sum / kg);
}
