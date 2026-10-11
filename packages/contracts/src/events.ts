/**
 * Realtime events over WebSocket (GET /api/v1/ws).
 *
 * Protocol:
 * 1. Client connects, then sends { "type": "auth", "token": "<session token>" } within 10 s.
 * 2. Server replies { "type": "ready", "companyId": <uuid|null>, "lastSeq": <number> }.
 * 3. Server pushes { "type": "event", "event": RealtimeEvent } for:
 *    - public region events (companyId null), and
 *    - private events of the client's own company.
 * 4. Client may send { "type": "ping" } -> server { "type": "pong" }. Server pings every 30 s.
 * Clients must treat events as hints and refetch authoritative state; the DB is the source of truth.
 * If a client sees a gap in seq or reconnects, it refetches everything it displays.
 */
import { z } from 'zod';

export const EVENT_TYPES = [
  'world.time_updated', // public: payload { gameDay, date, weather }
  'parcel.ownership_changed', // public: { parcelId, ownerCompanyId, status, listPricePaise }
  'parcel.updated', // public: { parcelId } (crop planted/harvested, listing changed)
  'market.price_updated', // public: { marketId, prices: [{itemId, pricePaisePerKg}] }
  'listing.updated', // public: { listingId, status, remainingKg }
  'contract.updated', // public: { contractId, status }
  'company.updated', // private: { cashPaise, status }
  'crop.stage_changed', // private: { plotId, parcelId, stage }
  'crop.harvest_ready', // private: { plotId, parcelId }
  'crop.failed', // private: { plotId, parcelId, reason }
  'trade.completed', // private (both parties): { tradeId, itemId, quantityKg, totalPaise, role }
  'notification.created', // private: NotificationDto
  'loan.updated', // private: { loanId, status, outstandingPaise }
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const RealtimeEvent = z.object({
  seq: z.number().int(),
  id: z.uuid(),
  type: z.enum(EVENT_TYPES),
  schemaVersion: z.number().int(),
  regionId: z.string(),
  companyId: z.uuid().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  gameDay: z.number().int(),
  occurredAt: z.iso.datetime(),
  payload: z.record(z.string(), z.unknown()),
});
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(16).max(256) }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), companyId: z.uuid().nullable(), lastSeq: z.number().int() }),
  z.object({ type: z.literal('event'), event: RealtimeEvent }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
