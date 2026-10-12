import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiError,
  AuthResponse,
  MeResponse,
  RegionMapResponse,
  SegmentDetailResponse,
} from '@bh/contracts';
import { bootstrapWorld, findLedgerMismatches, type CoreDeps } from '@bh/core';
import type { FastifyInstance } from 'fastify';
import { createTestDeps, testConfig } from '../../../packages/core/test/helpers/db';
import { buildApp } from '../src/app';

let deps: CoreDeps;
let app: FastifyInstance;
let keyN = 0;
const key = () => `http-test-key-${++keyN}-${Date.now()}`;

beforeAll(async () => {
  deps = await createTestDeps({ aiCompanyCount: 0 });
  ({ app } = await buildApp(deps, { rateLimits: { auth: 1000 } }));
  app.get('/__boom', async () => {
    throw new Error('secret internal detail: password=hunter2');
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await deps.pool.end();
});

async function devLogin(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/dev-login',
    payload: { username },
  });
  expect(res.statusCode).toBe(200);
  return AuthResponse.parse(res.json()).token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('ops endpoints', () => {
  it('healthz is live; readyz waits for the world; version reports ruleset', async () => {
    expect((await app.inject('/healthz')).json()).toEqual({ status: 'ok' });
    const notReady = await app.inject('/readyz');
    expect(notReady.statusCode).toBe(503);
    expect(ApiError.parse(notReady.json()).error.code).toBe('SERVICE_UNAVAILABLE');
    await bootstrapWorld(deps, { regionId: 'tamil-nadu' });
    const ready = await app.inject('/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', gameDay: 0 });
    const version = (await app.inject('/api/v1/version')).json();
    expect(version).toMatchObject({
      version: expect.any(String),
      rulesetVersion: expect.any(String),
      gitSha: expect.any(String),
    });
  });

  it('exposes Prometheus metrics (optionally token-protected)', async () => {
    const res = await app.inject('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('bh_http_request_duration_seconds');
    expect(res.body).toContain('bh_db_pool_connections');
    const { app: locked } = await buildApp(deps, { metricsToken: 'metrics-secret-token' });
    await locked.ready();
    expect((await locked.inject('/metrics')).statusCode).toBe(401);
    const okRes = await locked.inject({ url: '/metrics', headers: bearer('metrics-secret-token') });
    expect(okRes.statusCode).toBe(200);
    await locked.close();
  });

  it('returns the error envelope for unknown routes and hides internals on 500', async () => {
    const missing = await app.inject('/api/v1/nope');
    expect(missing.statusCode).toBe(404);
    expect(ApiError.parse(missing.json()).error.code).toBe('NOT_FOUND');
    const boom = await app.inject('/__boom');
    expect(boom.statusCode).toBe(500);
    const body = ApiError.parse(boom.json());
    expect(body.error.code).toBe('INTERNAL');
    expect(boom.body).not.toContain('hunter2');
    expect(boom.body).not.toContain('secret internal');
    expect(boom.headers['x-request-id']).toBeTruthy();
  });

  it('applies CORS for the configured client origin only', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/me',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    expect((await app.inject('/healthz')).headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('auth over HTTP', () => {
  it('register → me → logout → 401', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        username: 'http_user',
        password: 'long-enough-password',
        displayName: 'Http User',
      },
    });
    expect(reg.statusCode).toBe(201);
    const { token } = AuthResponse.parse(reg.json());
    const me = await app.inject({ url: '/api/v1/me', headers: bearer(token) });
    expect(MeResponse.parse(me.json())).toMatchObject({ company: null, regionId: 'tamil-nadu' });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'http_user', password: 'wrong-password' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Invalid username or password' },
    });

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: bearer(token),
    });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ url: '/api/v1/me', headers: bearer(token) });
    expect(after.statusCode).toBe(401);
    expect(ApiError.parse(after.json()).error.code).toBe('UNAUTHENTICATED');
  });

  it('reports auth config; dev-login is absent when disabled', async () => {
    const cfg = (await app.inject('/api/v1/auth/config')).json();
    expect(cfg).toMatchObject({
      devAuth: true,
      passwordAuth: true,
      steamAuth: false,
      appEnv: 'test',
    });
    const { app: noDev } = await buildApp({
      ...deps,
      config: testConfig({ devAuthEnabled: false, devAdminEnabled: false }),
    });
    await noDev.ready();
    const res = await noDev.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: { username: 'someone' },
    });
    expect(res.statusCode).toBe(404);
    expect(ApiError.parse(res.json()).error.code).toBe('NOT_FOUND');
    const adv = await noDev.inject({
      method: 'POST',
      url: '/api/v1/dev/advance',
      payload: { days: 1 },
    });
    expect(adv.statusCode).toBe(404);
    await noDev.close();
  });

  it('validates auth payloads', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: 'x', password: 'short', displayName: '' },
    });
    expect(res.statusCode).toBe(400);
    const body = ApiError.parse(res.json());
    expect(body.error.code).toBe('VALIDATION_FAILED');
    const issues = (body.error.details as { issues: { path: string }[] }).issues.map((i) => i.path);
    expect(issues).toEqual(
      expect.arrayContaining(['body.username', 'body.password', 'body.displayName']),
    );
  });
});

describe('commands over HTTP', () => {
  let tokenA: string;
  let tokenB: string;
  let companyA: string;

  it('requires an Idempotency-Key and a company', async () => {
    tokenA = await devLogin('dev_alice');
    tokenB = await devLogin('dev_bob');
    const noKey = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: bearer(tokenA),
      payload: { name: 'Alice Agro' },
    });
    expect(noKey.statusCode).toBe(400);
    expect(ApiError.parse(noKey.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const noCompany = await app.inject({
      method: 'POST',
      url: '/api/v1/machinery',
      headers: { ...bearer(tokenA), 'idempotency-key': key() },
      payload: { type: 'tractor', expectedPricePaise: 1 },
    });
    expect(noCompany.statusCode).toBe(403);
    expect(ApiError.parse(noCompany.json()).error.code).toBe('COMPANY_REQUIRED');

    const k = key();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { ...bearer(tokenA), 'idempotency-key': k },
      payload: { name: 'Alice Agro' },
    });
    expect(created.statusCode).toBe(201);
    companyA = created.json().result.company.id;
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { ...bearer(tokenA), 'idempotency-key': k },
      payload: { name: 'Alice Agro' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().result.company.id).toBe(companyA);
    const b = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { ...bearer(tokenB), 'idempotency-key': key() },
      payload: { name: 'Bob Farms' },
    });
    expect(b.statusCode).toBe(201);
    const me = MeResponse.parse(
      (await app.inject({ url: '/api/v1/me', headers: bearer(tokenA) })).json(),
    );
    expect(me.company?.id).toBe(companyA);
  });

  it('validates params and bodies with issue details', async () => {
    const badBody = await app.inject({
      method: 'POST',
      url: '/api/v1/parcels/TN-001-02/purchase',
      headers: { ...bearer(tokenA), 'idempotency-key': key() },
      payload: { expectedVersion: 'one', expectedPricePaise: -5 },
    });
    expect(badBody.statusCode).toBe(400);
    const err = ApiError.parse(badBody.json()).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect((err.details as { issues: { path: string }[] }).issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['body.expectedVersion', 'body.expectedPricePaise']),
    );
    const badParam = await app.inject({
      method: 'POST',
      url: '/api/v1/crop-plots/not-a-uuid/harvest',
      headers: { ...bearer(tokenA), 'idempotency-key': key() },
    });
    expect(badParam.statusCode).toBe(400);
    const badKey = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read',
      headers: { ...bearer(tokenA), 'idempotency-key': 'short' },
      payload: { all: true },
    });
    expect(badKey.statusCode).toBe(400);
    const big = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read',
      headers: { ...bearer(tokenA), 'idempotency-key': key(), 'content-type': 'application/json' },
      payload: JSON.stringify({ ids: [], pad: 'x'.repeat(70 * 1024) }),
    });
    expect(big.statusCode).toBe(413);
    expect(ApiError.parse(big.json()).error.code).toBe('VALIDATION_FAILED');
  });

  it('runs a purchase once per key, replays it, and rejects key reuse with a different body', async () => {
    const map = RegionMapResponse.parse(
      (await app.inject({ url: '/api/v1/regions/tamil-nadu/map', headers: bearer(tokenA) })).json(),
    );
    expect(map.districts).toHaveLength(32);
    const segmentId = map.segments.find((s) => s.holdingsForSale > 0)!.id;
    const segment = SegmentDetailResponse.parse(
      (await app.inject({ url: `/api/v1/segments/${segmentId}`, headers: bearer(tokenA) })).json(),
    );
    expect(segment.district.monthlyRainMm).toHaveLength(12);
    const parcel = segment.holdings
      .filter((p) => p.status === 'for_sale' && p.ownerCompanyId === null)
      .sort((x, y) => (x.listPricePaise ?? 0) - (y.listPricePaise ?? 0))[0]!;
    // Fund Alice enough (ledger-consistent grant) to buy land.
    await deps.pool.query(
      `WITH t AS (INSERT INTO ledger_transactions (region_id, kind, description, game_day) VALUES ('tamil-nadu','test','grant',0) RETURNING id)
       INSERT INTO ledger_entries (transaction_id, company_id, account_code, amount_paise, game_day)
       SELECT t.id, x.c, x.a, x.v, 0 FROM t, (VALUES ($1::uuid, 'cash', 100000000::bigint), (NULL::uuid, 'world_treasury', -100000000::bigint)) AS x(c, a, v)`,
      [companyA],
    );
    await deps.pool.query(
      'UPDATE companies SET cash_paise = cash_paise + 100000000 WHERE id = $1',
      [companyA],
    );

    const k = key();
    const payload = { expectedVersion: parcel.version, expectedPricePaise: parcel.listPricePaise };
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/parcels/${parcel.id}/purchase`,
      headers: { ...bearer(tokenA), 'idempotency-key': k },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, gameDay: 0, result: { parcelId: parcel.id } });
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/parcels/${parcel.id}/purchase`,
      headers: { ...bearer(tokenA), 'idempotency-key': k },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    const reused = await app.inject({
      method: 'POST',
      url: `/api/v1/parcels/${parcel.id}/purchase`,
      headers: { ...bearer(tokenA), 'idempotency-key': k },
      payload: { ...payload, expectedPricePaise: 1 },
    });
    expect(reused.statusCode).toBe(422);
    expect(ApiError.parse(reused.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Bob loses: the parcel version moved on.
    const lost = await app.inject({
      method: 'POST',
      url: `/api/v1/parcels/${parcel.id}/purchase`,
      headers: { ...bearer(tokenB), 'idempotency-key': key() },
      payload,
    });
    expect(lost.statusCode).toBe(409);
    expect(ApiError.parse(lost.json()).error.code).toBe('CONFLICT');
    expect(await findLedgerMismatches(deps.pool)).toEqual([]);
  });

  it("forbids reading another company's private data", async () => {
    for (const path of [
      'overview',
      'ledger',
      'inventory',
      'plots',
      'loans',
      'machinery',
      'notifications',
      'away-summary',
    ]) {
      const res = await app.inject({
        url: `/api/v1/companies/${companyA}/${path}`,
        headers: bearer(tokenB),
      });
      expect(res.statusCode, path).toBe(403);
      expect(ApiError.parse(res.json()).error.code).toBe('FORBIDDEN');
      const own = await app.inject({
        url: `/api/v1/companies/${companyA}/${path}`,
        headers: bearer(tokenA),
      });
      expect(own.statusCode, path).toBe(200);
    }
  });

  it('boolean query flags parse "false" as false', async () => {
    const res = await app.inject({
      url: '/api/v1/market-listings?mine=false',
      headers: bearer(tokenA),
    });
    expect(res.statusCode).toBe(200);
    const bad = await app.inject({
      url: '/api/v1/market-listings?mine=maybe',
      headers: bearer(tokenA),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('dev advance runs daily ticks and shifts the epoch back', async () => {
    const before = await deps.pool.query<{ epoch_at: Date }>('SELECT epoch_at FROM world_clock');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dev/advance',
      headers: { ...bearer(tokenA), 'idempotency-key': key() },
      payload: { days: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, gameDay: 2, result: { daysAdvanced: 2 } });
    const after = await deps.pool.query<{ epoch_at: Date; real_seconds_per_game_day: number }>(
      'SELECT epoch_at, real_seconds_per_game_day FROM world_clock',
    );
    const shiftMs = before.rows[0]!.epoch_at.getTime() - after.rows[0]!.epoch_at.getTime();
    expect(shiftMs).toBe(2 * after.rows[0]!.real_seconds_per_game_day * 1000);
    expect(await findLedgerMismatches(deps.pool)).toEqual([]);
  });
});

describe('rate limiting', () => {
  it('limits auth endpoints to 10/min per IP with the error envelope', async () => {
    const { app: limited } = await buildApp(deps);
    await limited.ready();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await limited.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'nobody_x', password: 'whatever-pass' },
      });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) {
        expect(ApiError.parse(res.json()).error.code).toBe('RATE_LIMITED');
        expect(res.headers['retry-after']).toBeDefined();
      }
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    await limited.close();
  });

  it('limits commands per session', async () => {
    const { app: limited } = await buildApp(deps, { rateLimits: { commands: 3 } });
    await limited.ready();
    const token = await devLogin('dev_alice');
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await limited.inject({
        method: 'POST',
        url: '/api/v1/notifications/read',
        headers: { ...bearer(token), 'idempotency-key': key() },
        payload: { all: true },
      });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429]);
    await limited.close();
  });
});
