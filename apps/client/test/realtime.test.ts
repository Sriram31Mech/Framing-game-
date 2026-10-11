import type { RealtimeEvent } from '@bh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidationsForEvent, reconnectDelayMs } from '../src/realtime/invalidation';
import { RealtimeClient } from '../src/realtime/socket';
import { toastForEvent } from '../src/realtime/useRealtime';

function ev(
  type: RealtimeEvent['type'],
  payload: Record<string, unknown> = {},
  seq = 1,
): RealtimeEvent {
  return {
    seq,
    id: '00000000-0000-4000-8000-000000000001',
    type,
    schemaVersion: 1,
    regionId: 'hemavati',
    companyId: null,
    entityType: null,
    entityId: null,
    gameDay: 10,
    occurredAt: '2026-10-11T00:00:00.000Z',
    payload,
  };
}

const keys = (e: RealtimeEvent) => invalidationsForEvent(e).map((k) => k.join(':'));

describe('event → invalidation mapping', () => {
  it('world.time_updated refreshes world, plots and overview (and the map for crop growth)', () => {
    const k = keys(ev('world.time_updated'));
    for (const r of ['world', 'plots', 'overview', 'map']) expect(k).toContain(r);
  });
  it('parcel events refresh the map and that parcel only', () => {
    expect(keys(ev('parcel.ownership_changed', { parcelId: 'HV-007' }))).toEqual([
      'map',
      'parcel:HV-007',
      'leaderboard',
    ]);
    expect(keys(ev('parcel.updated', { parcelId: 'HV-001' }))).toContain('parcel:HV-001');
  });
  it('market prices refresh markets, history and quotes', () => {
    expect(keys(ev('market.price_updated'))).toEqual(['markets', 'priceHistory', 'quote']);
  });
  it('company.updated refreshes me and overview', () => {
    const k = keys(ev('company.updated'));
    expect(k).toContain('me');
    expect(k).toContain('overview');
  });
  it('notification.created refreshes notifications and produces a toast', () => {
    const e = ev('notification.created', {
      id: '00000000-0000-4000-8000-000000000002',
      type: 'crop.ready',
      severity: 'success',
      title: 'Rice is ready',
      body: 'Harvest HV-001 within 10 days',
      entityType: 'parcel',
      entityId: 'HV-001',
      gameDay: 10,
      createdAt: '2026-10-11T00:00:00.000Z',
      read: false,
    });
    expect(keys(e)).toContain('notifications');
    expect(toastForEvent(e)).toEqual({
      severity: 'success',
      title: 'Rice is ready',
      body: 'Harvest HV-001 within 10 days',
    });
    expect(toastForEvent(ev('notification.created', { junk: true }))).toBeNull();
    expect(toastForEvent(ev('company.updated'))).toBeNull();
  });
  it('trade, loan and crop events map to their resources', () => {
    expect(keys(ev('trade.completed'))).toEqual(
      expect.arrayContaining(['inventory', 'listings', 'ledger']),
    );
    expect(keys(ev('loan.updated'))).toEqual(expect.arrayContaining(['loans', 'overview']));
    expect(keys(ev('crop.harvest_ready', { parcelId: 'HV-3' }))).toEqual(
      expect.arrayContaining(['plots', 'map', 'parcel:HV-3']),
    );
  });
});

describe('reconnect backoff', () => {
  it('grows exponentially, is capped and never below the floor', () => {
    expect(reconnectDelayMs(0, () => 0.999)).toBeLessThanOrEqual(1000);
    expect(reconnectDelayMs(3, () => 0.999)).toBeLessThanOrEqual(8000);
    expect(reconnectDelayMs(3, () => 0.999)).toBeGreaterThan(4000);
    expect(reconnectDelayMs(20, () => 0.999)).toBeLessThanOrEqual(30_000);
    expect(reconnectDelayMs(5, () => 0)).toBe(500);
  });
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

describe('RealtimeClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  function make() {
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    const onReady = vi.fn();
    const onAuthError = vi.fn();
    const client = new RealtimeClient({
      url: 'ws://test/api/v1/ws',
      getToken: () => 'token_abcdefghijklmnop',
      onEvent,
      onStatus,
      onReady,
      onAuthError,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      random: () => 0.5,
    });
    return { client, onEvent, onStatus, onReady, onAuthError };
  }

  it('authenticates, goes live, dedupes events and refetches after reconnect', () => {
    const { client, onEvent, onStatus, onReady } = make();
    client.start();
    const s1 = FakeSocket.instances[0]!;
    s1.open();
    expect(JSON.parse(s1.sent[0]!)).toEqual({ type: 'auth', token: 'token_abcdefghijklmnop' });
    s1.receive({ type: 'ready', companyId: null, lastSeq: 5 });
    expect(onStatus).toHaveBeenLastCalledWith('live');
    expect(onReady).toHaveBeenLastCalledWith({ companyId: null, lastSeq: 5, reconnected: false });
    s1.receive({ type: 'event', event: ev('world.time_updated', {}, 5) });
    s1.receive({ type: 'event', event: ev('world.time_updated', {}, 6) });
    s1.receive({ type: 'event', event: ev('world.time_updated', {}, 6) });
    expect(onEvent).toHaveBeenCalledTimes(1);

    s1.drop();
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    vi.advanceTimersByTime(30_000);
    const s2 = FakeSocket.instances[1]!;
    s2.open();
    s2.receive({ type: 'ready', companyId: null, lastSeq: 9 });
    expect(onReady).toHaveBeenLastCalledWith({ companyId: null, lastSeq: 9, reconnected: true });
    client.stop();
  });

  it('stops and signs out on an auth failure close (4401)', () => {
    const { client, onAuthError } = make();
    client.start();
    const s1 = FakeSocket.instances[0]!;
    s1.open();
    s1.drop(4401);
    expect(onAuthError).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
