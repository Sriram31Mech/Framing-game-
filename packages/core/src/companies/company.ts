/**
 * Company row access, membership lookup and machinery effects.
 */
import {
  combinedMachineryEffects,
  type AiPersonality,
  type CompanyStatus,
  type MachineryDefinition,
  type MachineryType,
} from '@bh/domain';
import type { Queryable } from '../db/pool';
import { notFound } from '../errors';

export interface CompanyRow {
  id: string;
  regionId: string;
  name: string;
  kind: 'human' | 'ai';
  aiPersonality: AiPersonality | null;
  cashPaise: number;
  escrowPaise: number;
  status: CompanyStatus;
  distressSinceDay: number | null;
  bankruptcies: number;
  foundedDay: number;
  lastActiveDay: number | null;
  version: number;
}

interface CompanyDbRow {
  id: string;
  region_id: string;
  name: string;
  kind: 'human' | 'ai';
  ai_personality: AiPersonality | null;
  cash_paise: number;
  escrow_paise: number;
  status: CompanyStatus;
  distress_since_day: number | null;
  bankruptcies: number;
  founded_day: number;
  last_active_day: number | null;
  version: number;
}

/** Column list matching CompanyDbRow; `c` must alias companies. */
const COMPANY_COLUMNS = `c.id, c.region_id, c.name, c.kind, c.ai_personality, c.cash_paise, c.escrow_paise,
  c.status, c.distress_since_day, c.bankruptcies, c.founded_day, c.last_active_day, c.version`;

function mapCompany(r: CompanyDbRow): CompanyRow {
  return {
    id: r.id,
    regionId: r.region_id,
    name: r.name,
    kind: r.kind,
    aiPersonality: r.ai_personality,
    cashPaise: r.cash_paise,
    escrowPaise: r.escrow_paise,
    status: r.status,
    distressSinceDay: r.distress_since_day,
    bankruptcies: r.bankruptcies,
    foundedDay: r.founded_day,
    lastActiveDay: r.last_active_day,
    version: r.version,
  };
}

export async function findCompany(db: Queryable, companyId: string): Promise<CompanyRow | null> {
  const { rows } = await db.query<CompanyDbRow>(
    `SELECT ${COMPANY_COLUMNS} FROM companies c WHERE c.id = $1`,
    [companyId],
  );
  const r = rows[0];
  return r ? mapCompany(r) : null;
}

export async function getCompany(db: Queryable, companyId: string): Promise<CompanyRow> {
  const c = await findCompany(db, companyId);
  if (!c) throw notFound('Company', companyId);
  return c;
}

/** The company an account belongs to (MVP: at most one), or null. */
export async function findCompanyForAccount(
  db: Queryable,
  accountId: string,
): Promise<CompanyRow | null> {
  const { rows } = await db.query<CompanyDbRow>(
    `SELECT ${COMPANY_COLUMNS}
     FROM company_memberships m JOIN companies c ON c.id = m.company_id
     WHERE m.account_id = $1`,
    [accountId],
  );
  const r = rows[0];
  return r ? mapCompany(r) : null;
}

/** Companies of one kind in a region (e.g. for the AI scheduler: `listCompanies(db, region, 'ai')`). */
export async function listCompanies(
  db: Queryable,
  regionId: string,
  kind?: 'human' | 'ai',
): Promise<CompanyRow[]> {
  const { rows } = await db.query<CompanyDbRow>(
    `SELECT ${COMPANY_COLUMNS} FROM companies c
     WHERE c.region_id = $1 AND ($2::text IS NULL OR c.kind = $2) ORDER BY c.id`,
    [regionId, kind ?? null],
  );
  return rows.map(mapCompany);
}

/** Active machinery types owned by a company. */
export async function ownedMachineryTypes(
  db: Queryable,
  companyId: string,
): Promise<MachineryType[]> {
  const { rows } = await db.query<{ type: MachineryType }>(
    `SELECT type FROM machinery_assets WHERE company_id = $1 AND status = 'active' ORDER BY type`,
    [companyId],
  );
  return rows.map((r) => r.type);
}

export type MachineryEffects = Required<MachineryDefinition['effects']>;

export async function machineryEffectsFor(
  db: Queryable,
  companyId: string,
): Promise<MachineryEffects> {
  return combinedMachineryEffects(await ownedMachineryTypes(db, companyId));
}

/**
 * Baseline storage every company has (a rented village godown), before warehouse upgrades.
 * Informational in the MVP: harvests are never blocked by capacity.
 */
export const BASE_STORAGE_CAPACITY_KG = 50_000;
