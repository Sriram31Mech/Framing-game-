/**
 * Query keys. The first element is always the resource name so that invalidating `[resource]`
 * matches every variant (all companies, all parameters) of that resource.
 */
import type { ItemId } from '@bh/domain';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { ListingsParams } from './endpoints';

export const RESOURCES = [
  'authConfig',
  'me',
  'world',
  'map',
  'parcel',
  'suitability',
  'crops',
  'overview',
  'ledger',
  'inventory',
  'plots',
  'loans',
  'machinery',
  'notifications',
  'away',
  'markets',
  'priceHistory',
  'quote',
  'listings',
  'contracts',
  'leaderboard',
] as const;
export type Resource = (typeof RESOURCES)[number];

export const qk = {
  authConfig: () => ['authConfig'] as const,
  me: () => ['me'] as const,
  world: () => ['world'] as const,
  map: (regionId: string) => ['map', regionId] as const,
  /** Under the 'map' prefix so any map invalidation refreshes open segments too. */
  segment: (segmentId: string) => ['map', 'segment', segmentId] as const,
  parcel: (parcelId: string) => ['parcel', parcelId] as const,
  suitability: (parcelId: string) => ['suitability', parcelId] as const,
  crops: () => ['crops'] as const,
  overview: (companyId: string) => ['overview', companyId] as const,
  ledger: (companyId: string, accountCode: string | null) =>
    ['ledger', companyId, accountCode] as const,
  inventory: (companyId: string) => ['inventory', companyId] as const,
  plots: (companyId: string) => ['plots', companyId] as const,
  loans: (companyId: string) => ['loans', companyId] as const,
  machinery: (companyId: string) => ['machinery', companyId] as const,
  notifications: (companyId: string) => ['notifications', companyId] as const,
  away: (companyId: string) => ['away', companyId] as const,
  markets: () => ['markets'] as const,
  priceHistory: (marketId: string, itemId: ItemId | null, days: number) =>
    ['priceHistory', marketId, itemId, days] as const,
  quote: (marketId: string, itemId: ItemId, quantityKg: number) =>
    ['quote', marketId, itemId, quantityKg] as const,
  listings: (params: ListingsParams) => ['listings', params] as const,
  contracts: (scope: 'open' | 'mine') => ['contracts', scope] as const,
  leaderboard: () => ['leaderboard'] as const,
};

/** Invalidate prefix keys (resource names or more specific prefixes). Only active queries refetch. */
export function invalidateKeys(qc: QueryClient, keys: readonly QueryKey[]): void {
  for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
}

export function resourceKeys(...resources: Resource[]): QueryKey[] {
  return resources.map((r) => [r]);
}
