/**
 * Account flows: register / login (password), dev login, Steam login.
 * Every successful flow returns a fresh session token (see sessions.ts).
 */
import type { CoreDeps } from '../commands/types';
import { withTransaction } from '../db/tx';
import type { Queryable } from '../db/pool';
import { DomainError, notFound } from '../errors';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password';
import { createSession } from './sessions';
import type { SteamTicketValidator } from './steam';

export interface AccountView {
  id: string;
  username: string;
  displayName: string;
  kind: 'human' | 'ai' | 'dev';
}

export interface AuthResult {
  token: string;
  expiresAt: string;
  account: AccountView;
}

export interface ClientMeta {
  userAgent?: string | null;
  ip?: string | null;
}

const INVALID_CREDENTIALS = 'Invalid username or password';

interface AccountDbRow {
  id: string;
  username: string;
  display_name: string;
  kind: 'human' | 'ai' | 'dev';
  password_hash: string | null;
  disabled_at: Date | null;
}

const toView = (r: AccountDbRow): AccountView => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  kind: r.kind,
});

export async function getAccount(db: Queryable, accountId: string): Promise<AccountView> {
  const { rows } = await db.query<AccountDbRow>(
    'SELECT id, username, display_name, kind, password_hash, disabled_at FROM accounts WHERE id = $1',
    [accountId],
  );
  const r = rows[0];
  if (!r) throw notFound('Account', accountId);
  return toView(r);
}

async function issue(deps: CoreDeps, account: AccountView, meta: ClientMeta): Promise<AuthResult> {
  const session = await createSession(deps.pool, deps.config, account.id, meta);
  return { token: session.token, expiresAt: session.expiresAt.toISOString(), account };
}

export async function register(
  deps: CoreDeps,
  input: { username: string; password: string; displayName: string },
  meta: ClientMeta = {},
): Promise<AuthResult> {
  if (!deps.config.passwordAuthEnabled) {
    throw new DomainError('FORBIDDEN', 'Password sign-up is disabled');
  }
  const hash = await hashPassword(input.password);
  const { rows } = await deps.pool.query<AccountDbRow>(
    `INSERT INTO accounts (username, display_name, password_hash, kind) VALUES ($1, $2, $3, 'human')
     ON CONFLICT ((lower(username))) DO NOTHING
     RETURNING id, username, display_name, kind, password_hash, disabled_at`,
    [input.username, input.displayName.trim(), hash],
  );
  const r = rows[0];
  if (!r) throw new DomainError('CONFLICT', 'That username is taken');
  return issue(deps, toView(r), meta);
}

export async function login(
  deps: CoreDeps,
  input: { username: string; password: string },
  meta: ClientMeta = {},
): Promise<AuthResult> {
  if (!deps.config.passwordAuthEnabled) {
    throw new DomainError('FORBIDDEN', 'Password sign-in is disabled');
  }
  const { rows } = await deps.pool.query<AccountDbRow>(
    `SELECT id, username, display_name, kind, password_hash, disabled_at FROM accounts
     WHERE lower(username) = lower($1)`,
    [input.username],
  );
  const r = rows[0];
  // Always run one scrypt verification so response time does not reveal whether the user exists.
  const stored = r?.password_hash ?? (await dummyPasswordHash());
  const ok = await verifyPassword(input.password, stored);
  if (!r || !r.password_hash || !ok || r.disabled_at || r.kind !== 'human') {
    throw new DomainError('UNAUTHENTICATED', INVALID_CREDENTIALS);
  }
  return issue(deps, toView(r), meta);
}

/** Username-only sign-in for development; refused unless ENABLE_DEV_AUTH (never in production). */
export async function devLogin(
  deps: CoreDeps,
  input: { username: string },
  meta: ClientMeta = {},
): Promise<AuthResult> {
  if (!deps.config.devAuthEnabled || deps.config.isProduction) {
    throw new DomainError('NOT_FOUND', 'Not found');
  }
  const { rows } = await deps.pool.query<AccountDbRow>(
    `INSERT INTO accounts (username, display_name, kind) VALUES ($1, $1, 'dev')
     ON CONFLICT ((lower(username))) DO UPDATE SET username = accounts.username
     RETURNING id, username, display_name, kind, password_hash, disabled_at`,
    [input.username],
  );
  const r = rows[0]!;
  if (r.kind !== 'dev' || r.disabled_at) {
    // Never let dev login take over a real (password/Steam) or AI account.
    throw new DomainError('CONFLICT', 'That username belongs to a non-dev account');
  }
  return issue(deps, toView(r), meta);
}

export async function steamLogin(
  deps: CoreDeps,
  validate: SteamTicketValidator,
  input: { ticket: string },
  meta: ClientMeta = {},
): Promise<AuthResult> {
  if (!deps.config.steam.enabled)
    throw new DomainError('FORBIDDEN', 'Steam sign-in is not enabled');
  const { steamId } = await validate(input.ticket);
  const account = await withTransaction(deps.pool, async (client) => {
    // Serialise first logins of the same SteamID.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`steam:${steamId}`]);
    const existing = await client.query<AccountDbRow>(
      `SELECT a.id, a.username, a.display_name, a.kind, a.password_hash, a.disabled_at
       FROM steam_identities s JOIN accounts a ON a.id = s.account_id WHERE s.steam_id = $1`,
      [steamId],
    );
    const found = existing.rows[0];
    if (found) {
      if (found.disabled_at) throw new DomainError('FORBIDDEN', 'This account is disabled');
      return toView(found);
    }
    const created = await client.query<AccountDbRow>(
      `INSERT INTO accounts (username, display_name, kind) VALUES ($1, $2, 'human')
       RETURNING id, username, display_name, kind, password_hash, disabled_at`,
      [`steam_${steamId}`, `Farmer ${steamId.slice(-4)}`],
    );
    const row = created.rows[0]!;
    await client.query('INSERT INTO steam_identities (steam_id, account_id) VALUES ($1, $2)', [
      steamId,
      row.id,
    ]);
    return toView(row);
  });
  return issue(deps, account, meta);
}
