/**
 * TanStack Query hooks for every query endpoint.
 */
import type { ItemId } from '@bh/domain';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../store/auth';
import { useConnectionStore } from '../store/connection';
import { api } from './client';
import type { ListingsParams } from './endpoints';
import { qk } from './queryKeys';

/** When realtime hints are unavailable, fall back to polling the most time-sensitive views. */
function usePollFallback(ms: number): number | false {
  const status = useConnectionStore((s) => s.status);
  return status === 'live' ? false : ms;
}

export function useAuthConfig() {
  return useQuery({ queryKey: qk.authConfig(), queryFn: api.authConfig, staleTime: Infinity });
}

export function useMe() {
  const token = useAuthStore((s) => s.token);
  return useQuery({ queryKey: qk.me(), queryFn: api.me, enabled: !!token, staleTime: 15_000 });
}

/** The signed-in company id, or null. */
export function useCompanyId(): string | null {
  return useMe().data?.company?.id ?? null;
}

export function useWorld() {
  const token = useAuthStore((s) => s.token);
  const poll = usePollFallback(20_000);
  return useQuery({
    queryKey: qk.world(),
    queryFn: api.world,
    enabled: !!token,
    staleTime: 5_000,
    refetchInterval: poll,
  });
}

export function useRegionMap(regionId: string | undefined) {
  const poll = usePollFallback(60_000);
  return useQuery({
    queryKey: qk.map(regionId ?? ''),
    queryFn: () => api.regionMap(regionId!),
    enabled: !!regionId,
    staleTime: 30_000,
    refetchInterval: poll,
  });
}

export function useParcel(parcelId: string | null) {
  return useQuery({
    queryKey: qk.parcel(parcelId ?? ''),
    queryFn: () => api.parcel(parcelId!),
    enabled: !!parcelId,
    staleTime: 5_000,
  });
}

export function useSuitability(parcelId: string | null) {
  return useQuery({
    queryKey: qk.suitability(parcelId ?? ''),
    queryFn: () => api.parcelSuitability(parcelId!),
    enabled: !!parcelId,
    staleTime: 60_000,
  });
}

export function useCrops() {
  const token = useAuthStore((s) => s.token);
  return useQuery({
    queryKey: qk.crops(),
    queryFn: api.crops,
    enabled: !!token,
    staleTime: Infinity,
  });
}

export function useOverview() {
  const companyId = useCompanyId();
  const poll = usePollFallback(30_000);
  return useQuery({
    queryKey: qk.overview(companyId ?? ''),
    queryFn: () => api.companyOverview(companyId!),
    enabled: !!companyId,
    refetchInterval: poll,
  });
}

export function useLedger(accountCode: string | null, pageSize = 50) {
  const companyId = useCompanyId();
  return useInfiniteQuery({
    queryKey: qk.ledger(companyId ?? '', accountCode),
    queryFn: ({ pageParam }) =>
      api.companyLedger(companyId!, {
        cursor: pageParam ?? undefined,
        limit: pageSize,
        accountCode: accountCode ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!companyId,
  });
}

export function useInventory() {
  const companyId = useCompanyId();
  return useQuery({
    queryKey: qk.inventory(companyId ?? ''),
    queryFn: () => api.companyInventory(companyId!),
    enabled: !!companyId,
  });
}

export function usePlots() {
  const companyId = useCompanyId();
  const poll = usePollFallback(30_000);
  return useQuery({
    queryKey: qk.plots(companyId ?? ''),
    queryFn: () => api.companyPlots(companyId!),
    enabled: !!companyId,
    refetchInterval: poll,
  });
}

export function useLoans() {
  const companyId = useCompanyId();
  return useQuery({
    queryKey: qk.loans(companyId ?? ''),
    queryFn: () => api.companyLoans(companyId!),
    enabled: !!companyId,
  });
}

export function useMachinery() {
  const companyId = useCompanyId();
  return useQuery({
    queryKey: qk.machinery(companyId ?? ''),
    queryFn: () => api.companyMachinery(companyId!),
    enabled: !!companyId,
    staleTime: 60_000,
  });
}

export function useNotifications() {
  const companyId = useCompanyId();
  const poll = usePollFallback(45_000);
  return useQuery({
    queryKey: qk.notifications(companyId ?? ''),
    queryFn: () => api.companyNotifications(companyId!, { limit: 50 }),
    enabled: !!companyId,
    refetchInterval: poll,
  });
}

export function useAwaySummary() {
  const companyId = useCompanyId();
  return useQuery({
    queryKey: qk.away(companyId ?? ''),
    queryFn: () => api.companyAwaySummary(companyId!),
    enabled: !!companyId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useMarkets() {
  const token = useAuthStore((s) => s.token);
  const poll = usePollFallback(30_000);
  return useQuery({
    queryKey: qk.markets(),
    queryFn: api.markets,
    enabled: !!token,
    refetchInterval: poll,
  });
}

export function usePriceHistory(marketId: string | null, itemId: ItemId | null, days = 60) {
  return useQuery({
    queryKey: qk.priceHistory(marketId ?? '', itemId, days),
    queryFn: () => api.marketPrices(marketId!, { itemId: itemId ?? undefined, days }),
    enabled: !!marketId,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useSaleQuote(marketId: string | null, itemId: ItemId | null, quantityKg: number) {
  return useQuery({
    queryKey: qk.quote(marketId ?? '', itemId ?? 'rice', quantityKg),
    queryFn: ({ signal }) => api.marketQuote(marketId!, { itemId: itemId!, quantityKg }, signal),
    enabled: !!marketId && !!itemId && Number.isInteger(quantityKg) && quantityKg > 0,
    staleTime: 3_000,
    placeholderData: keepPreviousData,
  });
}

export function useListings(params: ListingsParams) {
  const token = useAuthStore((s) => s.token);
  return useQuery({
    queryKey: qk.listings(params),
    queryFn: () => api.listings(params),
    enabled: !!token,
  });
}

export function useContracts(scope: 'open' | 'mine') {
  const token = useAuthStore((s) => s.token);
  return useQuery({
    queryKey: qk.contracts(scope),
    queryFn: () => api.contracts({ scope, limit: 50 }),
    enabled: !!token,
  });
}

export function useLeaderboard() {
  const token = useAuthStore((s) => s.token);
  return useQuery({
    queryKey: qk.leaderboard(),
    queryFn: api.leaderboard,
    enabled: !!token,
    staleTime: 60_000,
  });
}
