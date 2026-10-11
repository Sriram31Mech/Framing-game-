/**
 * Opaque bearer sessions. The raw 32-byte token is returned to the client once; the database
 * stores only HMAC-SHA256(SESSION_SECRET, token), so a DB leak does not leak usable tokens.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config';
import type { Queryable } from '../db/pool';

export interface AuthContext {
  sessionId: string;
  accountId: string;
  accountKind: 'human' | 'ai' | 'dev';
  /** The account's company (MVP: at most one), or null before founding one. */
  companyId: string | null;
  regionId: string;
}

export function hashSessionToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export interface NewSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export async function createSession(
  db: Queryable,
  config: AppConfig,
  accountId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<NewSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sessions (token_hash, account_id, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      hashSessionToken(config.sessionSecret, token),
      accountId,
      expiresAt,
      meta.userAgent?.slice(0, 256) ?? null,
      meta.ip ?? null,
    ],
  );
  await db.query('UPDATE accounts SET last_seen_at = now() WHERE id = $1', [accountId]);
  return { token, sessionId: rows[0]!.id, expiresAt };
}

/**
 * Resolve a bearer token to its account, company and region. Returns null for unknown,
 * expired or revoked sessions and for disabled accounts.
 */
export async function authenticate(
  db: Queryable,
  config: AppConfig,
  token: string,
): Promise<AuthContext | null> {
  if (token.length < 16 || token.length > 256) return null;
  const hash = hashSessionToken(config.sessionSecret, token);
  const { rows } = await db.query<{
    session_id: string;
    token_hash: string;
    account_id: string;
    kind: 'human' | 'ai' | 'dev';
    company_id: string | null;
    region_id: string | null;
  }>(
    `SELECT s.id AS session_id, s.token_hash, a.id AS account_id, a.kind,
            c.id AS company_id, c.region_id
     FROM sessions s
     JOIN accounts a ON a.id = s.account_id
     LEFT JOIN company_memberships m ON m.account_id = a.id
     LEFT JOIN companies c ON c.id = m.company_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
       AND a.disabled_at IS NULL`,
    [hash],
  );
  const r = rows[0];
  if (!r) return null;
  // Defence in depth: the index lookup already matched, compare in constant time anyway.
  const a = Buffer.from(r.token_hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // Throttled presence update (at most every 5 minutes).
  await db.query(
    `UPDATE accounts SET last_seen_at = now()
     WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')`,
    [r.account_id],
  );
  return {
    sessionId: r.session_id,
    accountId: r.account_id,
    accountKind: r.kind,
    companyId: r.company_id,
    regionId: r.region_id ?? config.regionId,
  };
}

/** Revoke the session for this token (logout). Returns true if a live session was revoked. */
export async function revokeSession(
  db: Queryable,
  config: AppConfig,
  token: string,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashSessionToken(config.sessionSecret, token)],
  );
  return (res.rowCount ?? 0) > 0;
}
