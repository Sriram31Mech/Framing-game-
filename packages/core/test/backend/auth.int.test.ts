import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreDeps } from '../../src/commands/types';
import { devLogin, login, register, steamLogin } from '../../src/auth/accounts';
import { hashPassword, verifyPassword } from '../../src/auth/password';
import { authenticate, hashSessionToken, revokeSession } from '../../src/auth/sessions';
import { createSteamValidator, type FetchLike } from '../../src/auth/steam';
import { loadConfig } from '../../src/config';
import { testConfig } from '../helpers/db';
import { setupWorld } from './helpers';

let deps: CoreDeps;

beforeAll(async () => {
  deps = await setupWorld();
});
afterAll(async () => {
  await deps.pool.end();
});

describe('passwords', () => {
  it('hashes with scrypt and verifies in constant time', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('register / login / logout', () => {
  it('registers, logs in, authenticates and logs out', async () => {
    const reg = await register(deps, {
      username: 'Ravi_K',
      password: 'a-very-long-password',
      displayName: 'Ravi',
    });
    expect(reg.account).toMatchObject({ username: 'Ravi_K', kind: 'human' });
    // Only the HMAC of the token is stored.
    const stored = await deps.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM sessions WHERE account_id = $1',
      [reg.account.id],
    );
    expect(stored.rows[0]!.token_hash).toBe(hashSessionToken(deps.config.sessionSecret, reg.token));
    expect(stored.rows[0]!.token_hash).not.toContain(reg.token);

    await expect(
      register(deps, { username: 'ravi_k', password: 'another-long-password', displayName: 'X' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const session = await login(deps, { username: 'RAVI_K', password: 'a-very-long-password' });
    const auth = await authenticate(deps.pool, deps.config, session.token);
    expect(auth).toMatchObject({
      accountId: reg.account.id,
      companyId: null,
      regionId: 'tamil-nadu',
    });

    expect(await revokeSession(deps.pool, deps.config, session.token)).toBe(true);
    expect(await authenticate(deps.pool, deps.config, session.token)).toBeNull();
    // The registration session is independent.
    expect(await authenticate(deps.pool, deps.config, reg.token)).not.toBeNull();
  });

  it('rejects bad passwords and unknown users with the same generic error', async () => {
    const bad = await login(deps, { username: 'Ravi_K', password: 'nope-nope-nope' }).catch(
      (e: unknown) => e,
    );
    const unknown = await login(deps, {
      username: 'nobody_here',
      password: 'nope-nope-nope',
    }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Invalid username or password' });
    expect(unknown).toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'Invalid username or password',
    });
  });

  it('expired and garbage tokens do not authenticate', async () => {
    const s = await login(deps, { username: 'Ravi_K', password: 'a-very-long-password' });
    await deps.pool.query(
      `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`,
      [hashSessionToken(deps.config.sessionSecret, s.token)],
    );
    expect(await authenticate(deps.pool, deps.config, s.token)).toBeNull();
    expect(await authenticate(deps.pool, deps.config, 'x'.repeat(43))).toBeNull();
    // A token minted under a different secret is useless.
    const other = { ...deps.config, sessionSecret: 'another-secret-another-secret-123456' };
    const s2 = await login(deps, { username: 'Ravi_K', password: 'a-very-long-password' });
    expect(await authenticate(deps.pool, other, s2.token)).toBeNull();
  });
});

describe('dev login', () => {
  it('creates or fetches a dev account when enabled', async () => {
    const first = await devLogin(deps, { username: 'dev_asha' });
    const second = await devLogin(deps, { username: 'DEV_ASHA' });
    expect(first.account.kind).toBe('dev');
    expect(second.account.id).toBe(first.account.id);
    await expect(devLogin(deps, { username: 'Ravi_K' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('is disabled when the flag is off, and refused by config in production', async () => {
    const off = { ...deps, config: testConfig({ devAuthEnabled: false }) };
    await expect(devLogin(off, { username: 'dev_x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(() =>
      loadConfig({
        APP_ENV: 'production',
        DATABASE_URL: 'postgres://x',
        SESSION_SECRET: 'a'.repeat(40),
        ENABLE_DEV_AUTH: 'true',
      }),
    ).toThrow(/must not be enabled/);
    const prod = loadConfig({
      APP_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      SESSION_SECRET: 'b'.repeat(40),
    });
    expect(prod.devAuthEnabled).toBe(false);
    await expect(
      devLogin(
        { ...deps, config: { ...prod, databaseUrl: deps.config.databaseUrl } },
        { username: 'dev_y' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('steam login', () => {
  const steamConfig = () =>
    testConfig({ steam: { appId: '480', webApiKey: 'secret-key', enabled: true } });
  const fakeFetch = (body: unknown, ok = true): FetchLike & { urls: string[] } => {
    const urls: string[] = [];
    const fn: FetchLike = async (url) => {
      urls.push(url);
      return { ok, status: ok ? 200 : 500, json: async () => body };
    };
    return Object.assign(fn, { urls });
  };

  it('validates the ticket server-side and maps steamid → account (created on first login)', async () => {
    const config = steamConfig();
    const fetch = fakeFetch({
      response: {
        params: {
          result: 'OK',
          steamid: '76561198000000001',
          ownersteamid: '76561198000000001',
          vacbanned: false,
          publisherbanned: false,
        },
      },
    });
    const validator = createSteamValidator(config, fetch);
    const d = { ...deps, config };
    const first = await steamLogin(d, validator, { ticket: 'abcdef0123456789' });
    const second = await steamLogin(d, validator, { ticket: 'abcdef0123456789' });
    expect(second.account.id).toBe(first.account.id);
    expect(first.account.username).toBe('steam_76561198000000001');
    const url = new URL(fetch.urls[0]!);
    expect(url.origin + url.pathname).toBe(
      'https://partner.steam-api.com/ISteamUserAuth/AuthenticateUserTicket/v1/',
    );
    expect(url.searchParams.get('identity')).toBe('bharat-harvest');
    expect(url.searchParams.get('appid')).toBe('480');
  });

  it('rejects invalid tickets and maps outages to SERVICE_UNAVAILABLE', async () => {
    const config = steamConfig();
    const d = { ...deps, config };
    const rejected = createSteamValidator(
      config,
      fakeFetch({ response: { error: { errorcode: 101, errordesc: 'Invalid ticket' } } }),
    );
    await expect(steamLogin(d, rejected, { ticket: 'abcdef0123456789' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const down = createSteamValidator(config, fakeFetch({}, false));
    await expect(steamLogin(d, down, { ticket: 'abcdef0123456789' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    const throws = createSteamValidator(config, async () => {
      throw new Error('network down key=secret-key');
    });
    const err = (await steamLogin(d, throws, { ticket: 'abcdef0123456789' }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(err.message).not.toContain('secret-key');
    const disabled = createSteamValidator(deps.config, fakeFetch({}));
    await expect(steamLogin(deps, disabled, { ticket: 'abcdef0123456789' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
