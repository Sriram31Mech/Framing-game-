/**
 * Realtime gateway for GET /api/v1/ws (protocol: packages/contracts/src/events.ts).
 *
 * A dedicated pg connection LISTENs on `bh_domain_events`; each NOTIFY carries only the event
 * seq, so the gateway reads the committed row and fans it out: public events (company_id NULL)
 * to every authenticated socket in the region, private events only to that company's sockets.
 * Clients authenticate with their first message (10 s deadline); the server pings every 30 s and
 * drops dead sockets; sessions are re-validated on every ping cycle (logout disconnects).
 */
import { ClientMessage, type RealtimeEvent, type ServerMessage } from '@bh/contracts';
import { authenticate, type AuthContext, type CoreDeps } from '@bh/core';
import pg from 'pg';
import type { RawData, WebSocket } from 'ws';
import type { Metrics } from '../metrics';

export interface GatewayOptions {
  authTimeoutMs: number;
  pingIntervalMs: number;
  maxConnectionsPerAccount: number;
  /** Client messages allowed per socket per ping interval before it is dropped. */
  maxMessagesPerInterval: number;
  /** Drop sockets whose unsent buffer exceeds this (slow consumers). */
  maxBufferedBytes: number;
}

export const DEFAULT_GATEWAY_OPTIONS: GatewayOptions = {
  authTimeoutMs: 10_000,
  pingIntervalMs: 30_000,
  maxConnectionsPerAccount: 5,
  maxMessagesPerInterval: 60,
  maxBufferedBytes: 1_000_000,
};

/** WebSocket close codes (4000–4999 are application-defined). */
export const WS_CLOSE = { unauthenticated: 4401, tooMany: 4429, protocol: 4400, slow: 4408 };

interface ClientState {
  token: string | null;
  auth: AuthContext | null;
  alive: boolean;
  messages: number;
  authTimer: NodeJS.Timeout | null;
}

interface EventRow {
  seq: number;
  id: string;
  type: RealtimeEvent['type'];
  schema_version: number;
  region_id: string;
  company_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  game_day: number;
  occurred_at: Date;
  payload: Record<string, unknown>;
}

export class RealtimeGateway {
  private readonly clients = new Map<WebSocket, ClientState>();
  private listener: pg.Client | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = 500;
  private stopped = false;

  constructor(
    private readonly deps: CoreDeps,
    private readonly metrics: Metrics,
    private readonly opts: GatewayOptions = DEFAULT_GATEWAY_OPTIONS,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.pingTimer = setInterval(() => void this.heartbeat(), this.opts.pingIntervalMs);
    this.pingTimer.unref();
    await this.connectListener();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const [socket, state] of this.clients) {
      if (state.authTimer) clearTimeout(state.authTimer);
      socket.close(1001, 'server shutting down');
    }
    this.clients.clear();
    this.metrics.wsConnections.set(0);
    const listener = this.listener;
    this.listener = null;
    if (listener) await listener.end().catch(() => {});
  }

  /** Open (not closing/closed) sockets. */
  get connectionCount(): number {
    let n = 0;
    for (const socket of this.clients.keys()) if (socket.readyState === socket.OPEN) n++;
    return n;
  }

  private async connectListener(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({
      connectionString: this.deps.config.databaseUrl,
      application_name: 'bh-realtime',
    });
    const retry = (err?: unknown) => {
      if (this.listener !== client || this.stopped) return;
      this.listener = null;
      if (err) this.deps.logger.warn({ err }, 'realtime listener lost; reconnecting');
      client.end().catch(() => {});
      this.scheduleReconnect();
    };
    client.on('error', retry);
    client.on('end', () => retry());
    client.on('notification', (msg) => {
      const seq = Number(msg.payload);
      if (Number.isSafeInteger(seq)) void this.dispatch(seq);
    });
    this.listener = client;
    try {
      await client.connect();
      await client.query('LISTEN bh_domain_events');
      this.backoffMs = 500;
    } catch (err) {
      retry(err);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectListener();
    }, delay);
    this.reconnectTimer.unref();
  }

  /** Attach a freshly upgraded socket. */
  handleConnection(socket: WebSocket): void {
    const state: ClientState = {
      token: null,
      auth: null,
      alive: true,
      messages: 0,
      authTimer: null,
    };
    this.clients.set(socket, state);
    this.metrics.wsConnections.set(this.connectionCount);
    state.authTimer = setTimeout(() => {
      if (!state.auth)
        this.reject(
          socket,
          WS_CLOSE.unauthenticated,
          'AUTH_TIMEOUT',
          'Authenticate within 10 seconds',
        );
    }, this.opts.authTimeoutMs);

    socket.on('pong', () => {
      state.alive = true;
    });
    socket.on('message', (data: RawData, isBinary: boolean) => {
      void this.onMessage(socket, state, data, isBinary);
    });
    socket.on('close', () => this.forget(socket));
    socket.on('error', () => this.forget(socket));
  }

  private forget(socket: WebSocket): void {
    const state = this.clients.get(socket);
    if (state?.authTimer) clearTimeout(state.authTimer);
    this.clients.delete(socket);
    this.metrics.wsConnections.set(this.connectionCount);
  }

  private send(socket: WebSocket, msg: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > this.opts.maxBufferedBytes) {
      socket.terminate();
      this.forget(socket);
      return;
    }
    socket.send(JSON.stringify(msg));
  }

  private reject(socket: WebSocket, code: number, errorCode: string, message: string): void {
    this.send(socket, { type: 'error', code: errorCode, message });
    socket.close(code, errorCode);
    this.forget(socket);
  }

  private async onMessage(
    socket: WebSocket,
    state: ClientState,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    state.alive = true;
    if (++state.messages > this.opts.maxMessagesPerInterval) {
      this.reject(socket, WS_CLOSE.protocol, 'TOO_MANY_MESSAGES', 'Too many messages');
      return;
    }
    let parsed: ClientMessage;
    try {
      if (isBinary) throw new Error('binary');
      const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString();
      const result = ClientMessage.safeParse(JSON.parse(text));
      if (!result.success) throw new Error('invalid');
      parsed = result.data;
    } catch {
      this.reject(socket, WS_CLOSE.protocol, 'BAD_MESSAGE', 'Unrecognised message');
      return;
    }

    if (parsed.type === 'ping') {
      this.send(socket, { type: 'pong' });
      return;
    }
    // parsed.type === 'auth'
    if (state.auth) return; // already authenticated; ignore repeats
    const auth = await authenticate(this.deps.pool, this.deps.config, parsed.token).catch(
      () => null,
    );
    if (!this.clients.has(socket)) return; // closed meanwhile
    if (!auth) {
      this.reject(
        socket,
        WS_CLOSE.unauthenticated,
        'UNAUTHENTICATED',
        'Invalid or expired session',
      );
      return;
    }
    const open = [...this.clients].filter(
      ([s, st]) => s.readyState === s.OPEN && st.auth?.accountId === auth.accountId,
    ).length;
    if (open >= this.opts.maxConnectionsPerAccount) {
      this.reject(socket, WS_CLOSE.tooMany, 'TOO_MANY_CONNECTIONS', 'Too many open connections');
      return;
    }
    if (state.authTimer) clearTimeout(state.authTimer);
    state.authTimer = null;
    state.auth = auth;
    state.token = parsed.token;
    const { rows } = await this.deps.pool.query<{ last: number }>(
      'SELECT COALESCE(MAX(seq), 0)::bigint AS last FROM domain_events WHERE region_id = $1',
      [auth.regionId],
    );
    this.send(socket, {
      type: 'ready',
      companyId: auth.companyId,
      lastSeq: Number(rows[0]?.last ?? 0),
    });
  }

  /** Ping, drop dead sockets, reset message budgets, re-validate sessions. */
  private async heartbeat(): Promise<void> {
    for (const [socket, state] of [...this.clients]) {
      if (socket.readyState !== socket.OPEN && socket.readyState !== socket.CONNECTING) {
        this.forget(socket);
        continue;
      }
      if (!state.alive) {
        socket.terminate();
        this.forget(socket);
        continue;
      }
      state.alive = false;
      state.messages = 0;
      socket.ping();
      if (state.token) {
        const auth = await authenticate(this.deps.pool, this.deps.config, state.token).catch(
          () => state.auth,
        );
        if (!auth) {
          this.reject(socket, WS_CLOSE.unauthenticated, 'SESSION_ENDED', 'Session ended');
        } else {
          state.auth = auth; // picks up a newly founded company
        }
      }
    }
  }

  private async dispatch(seq: number): Promise<void> {
    if (this.clients.size === 0) return;
    let row: EventRow | undefined;
    try {
      const { rows } = await this.deps.pool.query<EventRow>(
        `SELECT seq, id, type, schema_version, region_id, company_id, entity_type, entity_id, game_day,
                occurred_at, payload
         FROM domain_events WHERE seq = $1`,
        [seq],
      );
      row = rows[0];
    } catch (err) {
      this.deps.logger.warn({ err, seq }, 'failed to load domain event');
      return;
    }
    if (!row) return;
    const event: RealtimeEvent = {
      seq: Number(row.seq),
      id: row.id,
      type: row.type,
      schemaVersion: row.schema_version,
      regionId: row.region_id,
      companyId: row.company_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      gameDay: row.game_day,
      occurredAt: row.occurred_at.toISOString(),
      payload: row.payload,
    };

    // A socket that authenticated before founding its company learns the company id from the
    // company's first private event (membership is checked against the DB, never trusted).
    if (event.companyId) await this.adoptNewCompany(event.companyId);

    for (const [socket, state] of this.clients) {
      const auth = state.auth;
      if (!auth || auth.regionId !== event.regionId) continue;
      if (event.companyId !== null && auth.companyId !== event.companyId) continue;
      this.send(socket, { type: 'event', event });
      this.metrics.wsEventsSent.inc();
    }
  }

  private async adoptNewCompany(companyId: string): Promise<void> {
    const waiting = [...this.clients.values()].filter((s) => s.auth && s.auth.companyId === null);
    if (waiting.length === 0) return;
    const { rows } = await this.deps.pool.query<{ account_id: string; region_id: string }>(
      `SELECT m.account_id, c.region_id FROM company_memberships m JOIN companies c ON c.id = m.company_id
       WHERE m.company_id = $1`,
      [companyId],
    );
    for (const s of waiting) {
      const member = rows.find((r) => r.account_id === s.auth!.accountId);
      if (member) s.auth = { ...s.auth!, companyId, regionId: member.region_id };
    }
  }
}
