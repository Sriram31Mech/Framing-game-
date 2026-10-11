/**
 * Realtime events are hints: each maps to the queries that may now be stale.
 * Pure function so the mapping is unit-testable.
 */
import type { RealtimeEvent } from '@bh/contracts';
import type { QueryKey } from '@tanstack/react-query';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function invalidationsForEvent(event: RealtimeEvent): QueryKey[] {
  const p = event.payload;
  switch (event.type) {
    case 'world.time_updated':
      // A new day: crop progress, costs, spoilage, instalments, prices snapshot.
      return [
        ['world'],
        ['plots'],
        ['overview'],
        ['map'],
        ['parcel'],
        ['inventory'],
        ['loans'],
        ['machinery'],
        ['ledger'],
        ['leaderboard'],
        ['suitability'],
      ];
    case 'parcel.ownership_changed':
    case 'parcel.updated': {
      const parcelId = str(p.parcelId) ?? event.entityId;
      return [['map'], parcelId ? ['parcel', parcelId] : ['parcel'], ['leaderboard']];
    }
    case 'market.price_updated':
      return [['markets'], ['priceHistory'], ['quote']];
    case 'listing.updated':
      return [['listings']];
    case 'contract.updated':
      return [['contracts']];
    case 'company.updated':
      return [['me'], ['overview'], ['ledger']];
    case 'crop.stage_changed':
    case 'crop.harvest_ready':
    case 'crop.failed': {
      const parcelId = str(p.parcelId);
      return [['plots'], ['map'], parcelId ? ['parcel', parcelId] : ['parcel'], ['overview']];
    }
    case 'trade.completed':
      return [['inventory'], ['listings'], ['contracts'], ['overview'], ['me'], ['ledger']];
    case 'notification.created':
      return [['notifications'], ['overview']];
    case 'loan.updated':
      return [['loans'], ['overview'], ['me'], ['ledger']];
    default:
      return [];
  }
}

/** Exponential backoff with full jitter: random in [0, min(cap, base·2^attempt)], floored at `min`. */
export function reconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
  opts: { baseMs?: number; capMs?: number; minMs?: number } = {},
): number {
  const base = opts.baseMs ?? 1000;
  const cap = opts.capMs ?? 30_000;
  const min = opts.minMs ?? 500;
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.max(min, Math.floor(random() * ceiling));
}
