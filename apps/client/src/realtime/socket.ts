/**
 * WebSocket client for GET /api/v1/ws (see @bh/contracts events.ts for the protocol):
 * connect → send auth → await `ready` → receive `event`s; ping keep-alive; exponential
 * reconnect with jitter. The DB is the source of truth: on every reconnect the caller
 * refetches everything it displays.
 */
import { ServerMessage, type ClientMessage, type RealtimeEvent } from '@bh/contracts';
import type { ConnectionStatus } from '../store/connection';
import { reconnectDelayMs } from './invalidation';

/** Server close codes (apps/server): auth failure, too many connections, bad message. */
export const CLOSE_AUTH_FAILED = 4401;
export const CLOSE_TOO_MANY = 4429;
export const CLOSE_BAD_MESSAGE = 4400;

export interface RealtimeDeps {
  url: string;
  getToken: () => string | null;
  onEvent: (event: RealtimeEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** Called on each `ready`; `reconnected` is true for every ready after the first. */
  onReady: (info: { companyId: string | null; lastSeq: number; reconnected: boolean }) => void;
  /** Server rejected the session token. */
  onAuthError: () => void;
  WebSocketImpl?: typeof WebSocket;
  random?: () => number;
  pingIntervalMs?: number;
  /** Close and reconnect if nothing is heard for this long. */
  silenceTimeoutMs?: number;
  /** Attempts before showing 'offline' instead of 'reconnecting'. */
  offlineAfterAttempts?: number;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private everReady = false;
  private lastSeq = -1;
  private lastHeardAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RealtimeDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, 'client stop');
      } catch {
        // ignore
      }
    }
    this.deps.onStatus('idle');
  }

  /** Skip the backoff wait (e.g. the browser just came back online). */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState === 1) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private connect(): void {
    const token = this.deps.getToken();
    if (!token) {
      this.deps.onStatus('idle');
      return;
    }
    const Impl = this.deps.WebSocketImpl ?? WebSocket;
    this.deps.onStatus(this.everReady || this.attempt > 0 ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new Impl(this.deps.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.lastHeardAt = Date.now();
      this.send({ type: 'auth', token });
    };
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
    ws.onerror = () => {
      // onclose follows and handles reconnection.
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.stopped) return;
      if (ev.code === CLOSE_AUTH_FAILED) {
        // Session rejected: reconnecting with the same token would fail forever.
        this.stop();
        this.deps.onAuthError();
        return;
      }
      // Too many connections (another tab): wait longer before trying again.
      this.scheduleReconnect(ev.code === CLOSE_TOO_MANY ? 4 : 0);
    };
  }

  private handleMessage(data: unknown): void {
    this.lastHeardAt = Date.now();
    let json: unknown;
    try {
      json = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    const parsed = ServerMessage.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.type) {
      case 'ready': {
        const reconnected = this.everReady;
        this.everReady = true;
        this.attempt = 0;
        this.lastSeq = msg.lastSeq;
        this.deps.onStatus('live');
        this.startPing();
        this.deps.onReady({ companyId: msg.companyId, lastSeq: msg.lastSeq, reconnected });
        break;
      }
      case 'event':
        // Drop duplicates / replays already covered by the snapshot we refetched.
        if (msg.event.seq <= this.lastSeq) return;
        this.lastSeq = msg.event.seq;
        this.deps.onEvent(msg.event);
        break;
      case 'pong':
        break;
      case 'error':
        if (msg.code === 'UNAUTHENTICATED' || msg.code === 'FORBIDDEN') {
          this.stop();
          this.deps.onAuthError();
        }
        break;
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const interval = this.deps.pingIntervalMs ?? 25_000;
    const silence = this.deps.silenceTimeoutMs ?? 75_000;
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeardAt > silence) {
        // Half-open connection: force a reconnect.
        try {
          this.ws?.close(4000, 'silence');
        } catch {
          // ignore
        }
        return;
      }
      this.send({ type: 'ping' });
    }, interval);
  }

  private scheduleReconnect(extraAttempts = 0): void {
    if (this.stopped) return;
    this.attempt += 1 + extraAttempts;
    const offlineAfter = this.deps.offlineAfterAttempts ?? 5;
    this.deps.onStatus(this.attempt > offlineAfter ? 'offline' : 'reconnecting');
    const delay = reconnectDelayMs(this.attempt - 1, this.deps.random);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export function defaultSocketUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/api/v1/ws`;
}
