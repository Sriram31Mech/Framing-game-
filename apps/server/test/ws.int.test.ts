import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthResponse, ServerMessage } from '@bh/contracts';
import { bootstrapWorld, type CoreDeps } from '@bh/core';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { createTestDeps } from '../../../packages/core/test/helpers/db';
import { buildApp } from '../src/app';
import type { RealtimeGateway } from '../src/realtime/gateway';

let deps: CoreDeps;
let app: FastifyInstance;
let gateway: RealtimeGateway;
let n = 0;

beforeAll(async () => {
  deps = await createTestDeps({ aiCompanyCount: 0 });
  await bootstrapWorld(deps, { regionId: 'tamil-nadu' });
  ({ app, gateway } = await buildApp(deps, {
    rateLimits: { auth: 1000 },
    gateway: { authTimeoutMs: 300, maxConnectionsPerAccount: 2 },
  }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await deps.pool.end();
});

/** Socket wrapper that buffers parsed server messages. */
async function connect() {
  const ws = (await app.injectWS('/api/v1/ws')) as WebSocket;
  const inbox: ServerMessage[] = [];
  let closed: { code: number } | null = null;
  ws.on('message', (data) => inbox.push(ServerMessage.parse(JSON.parse(data.toString()))));
  ws.on('close', (code) => {
    closed = { code };
  });
  const waitFor = async <T extends ServerMessage>(
    pred: (m: ServerMessage) => m is T,
    ms = 3000,
  ): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      if (Date.now() - start > ms) throw new Error(`timed out; inbox=${JSON.stringify(inbox)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const waitClosed = async (ms = 3000) => {
    const start = Date.now();
    while (!closed) {
      if (Date.now() - start > ms) throw new Error('socket did not close');
      await new Promise((r) => setTimeout(r, 20));
    }
    return closed as { code: number };
  };
  return { ws, inbox, waitFor, waitClosed, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

async function player(name: string): Promise<{ token: string; companyId: string }> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/dev-login',
    payload: { username: name },
  });
  const { token } = AuthResponse.parse(login.json());
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/companies',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': `ws-company-${name}-${++n}` },
    payload: { name: `${name.replace(/_/g, ' ')} Farms` },
  });
  return { token, companyId: res.json().result.company.id };
}

const isReady = (m: ServerMessage): m is Extract<ServerMessage, { type: 'ready' }> =>
  m.type === 'ready';
const isError = (m: ServerMessage): m is Extract<ServerMessage, { type: 'error' }> =>
  m.type === 'error';
const isEvent =
  (type: string, companyId?: string | null) =>
  (m: ServerMessage): m is Extract<ServerMessage, { type: 'event' }> =>
    m.type === 'event' &&
    m.event.type === type &&
    (companyId === undefined || m.event.companyId === companyId);

describe('realtime gateway', () => {
  it('authenticates with the first message, answers pings, fans out public and private events', async () => {
    const a = await player('ws_anna');
    const b = await player('ws_bala');
    const sa = await connect();
    const sb = await connect();
    sa.send({ type: 'auth', token: a.token });
    sb.send({ type: 'auth', token: b.token });
    const ready = await sa.waitFor(isReady);
    expect(ready.companyId).toBe(a.companyId);
    await sb.waitFor(isReady);
    sa.send({ type: 'ping' });
    await sa.waitFor((m): m is Extract<ServerMessage, { type: 'pong' }> => m.type === 'pong');

    // A's command: private notification for A, public listing/parcel events for everyone.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read',
      headers: { authorization: `Bearer ${a.token}`, 'idempotency-key': `ws-read-${++n}-x` },
      payload: { all: true },
    });
    expect(res.statusCode).toBe(200);
    await deps.pool.query(
      `INSERT INTO domain_events (region_id, type, company_id, payload, game_day)
       VALUES ('tamil-nadu', 'parcel.updated', NULL, '{"parcelId":"TN-001-02"}', 0),
              ('tamil-nadu', 'company.updated', $1, '{"cashPaise":1,"status":"active"}', 0)`,
      [a.companyId],
    );
    const pub = await sb.waitFor(isEvent('parcel.updated'));
    expect(pub.event.payload).toEqual({ parcelId: 'TN-001-02' });
    await sa.waitFor(isEvent('parcel.updated'));
    await sa.waitFor(isEvent('company.updated', a.companyId));
    // B never receives A's private events.
    await new Promise((r) => setTimeout(r, 200));
    expect(sb.inbox.some((m) => m.type === 'event' && m.event.companyId === a.companyId)).toBe(
      false,
    );
    sa.ws.close();
    sb.ws.close();
  });

  it('rejects bad tokens, garbage and silent clients; caps connections per account', async () => {
    const bad = await connect();
    bad.send({ type: 'auth', token: 'x'.repeat(40) });
    await bad.waitFor(isError);
    expect((await bad.waitClosed()).code).toBe(4401);

    const garbage = await connect();
    garbage.ws.send('not json');
    expect((await garbage.waitClosed()).code).toBe(4400);

    const silent = await connect();
    expect((await silent.waitClosed()).code).toBe(4401);

    const c = await player('ws_chitra');
    const s1 = await connect();
    const s2 = await connect();
    const s3 = await connect();
    for (const s of [s1, s2]) {
      s.send({ type: 'auth', token: c.token });
      await s.waitFor(isReady);
    }
    s3.send({ type: 'auth', token: c.token });
    expect((await s3.waitFor(isError)).code).toBe('TOO_MANY_CONNECTIONS');
    expect((await s3.waitClosed()).code).toBe(4429);
    s1.ws.close();
    s2.ws.close();
  });

  it('a socket opened before founding a company starts receiving its private events', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: { username: 'ws_dev_late' },
    });
    const { token } = AuthResponse.parse(login.json());
    const s = await connect();
    s.send({ type: 'auth', token });
    expect((await s.waitFor(isReady)).companyId).toBeNull();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': `ws-late-${++n}-key` },
      payload: { name: 'Late Bloomers' },
    });
    const companyId = res.json().result.company.id as string;
    await s.waitFor(isEvent('company.updated', companyId));
    s.ws.close();
    for (let i = 0; i < 100 && gateway.connectionCount > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(gateway.connectionCount).toBe(0);
  });
});
