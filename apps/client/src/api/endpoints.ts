/**
 * One typed function per endpoint in `@bh/contracts` ENDPOINTS. Paths are built here only.
 */
import {
  AuthConfigResponse,
  AuthResponse,
  AwaySummaryResponse,
  CommandOk,
  CompanyOverviewResponse,
  ContractsResponse,
  CropsResponse,
  InventoryResponse,
  LeaderboardResponse,
  LedgerResponse,
  ListingsResponse,
  LoansResponse,
  MachineryResponse,
  MarketsResponse,
  MeResponse,
  NotificationsResponse,
  ParcelDetailResponse,
  ParcelSuitabilityResponse,
  PlotsResponse,
  PriceHistoryResponse,
  RegionMapResponse,
  SegmentDetailResponse,
  SaleQuoteResponse,
  WorldResponse,
  type AcceptContractRequest,
  type BuyListingRequest,
  type BuyMachineryRequest,
  type CreateCompanyRequest,
  type CreateContractRequest,
  type CreateListingRequest,
  type DevLoginRequest,
  type LeaseParcelRequest,
  type ListParcelRequest,
  type LoginRequest,
  type MarkNotificationsReadRequest,
  type PlantRequest,
  type PlotOperationRequest,
  type PurchaseParcelRequest,
  type RegisterRequest,
  type RepayLoanRequest,
  type SellParcelToStateRequest,
  type SellToMarketRequest,
  type SteamLoginRequest,
  type TakeLoanRequest,
} from '@bh/contracts';
import type { ItemId } from '@bh/domain';
import { z } from 'zod';
import type { HttpClient } from './http';

const V1 = '/api/v1';
const enc = encodeURIComponent;
const Empty = z.unknown();

export interface ListingsParams {
  itemId?: ItemId;
  mine?: boolean;
  status?: 'open' | 'filled' | 'cancelled' | 'expired';
  limit?: number;
}

export function createApi(http: HttpClient) {
  const get = <T>(
    path: string,
    schema: z.ZodType<T>,
    query?: Record<string, string | number | boolean | undefined>,
    signal?: AbortSignal,
  ) => http.request({ method: 'GET', path: `${V1}${path}`, schema, query, signal });
  const command = (path: string, body: unknown = {}) =>
    http.request({ method: 'POST', path: `${V1}${path}`, schema: CommandOk, body, command: true });

  return {
    // auth (no Idempotency-Key, no bearer)
    authConfig: () =>
      http.request({
        method: 'GET',
        path: `${V1}/auth/config`,
        schema: AuthConfigResponse,
        auth: false,
      }),
    register: (body: RegisterRequest) =>
      http.request({
        method: 'POST',
        path: `${V1}/auth/register`,
        schema: AuthResponse,
        body,
        auth: false,
      }),
    login: (body: LoginRequest) =>
      http.request({
        method: 'POST',
        path: `${V1}/auth/login`,
        schema: AuthResponse,
        body,
        auth: false,
      }),
    devLogin: (body: DevLoginRequest) =>
      http.request({
        method: 'POST',
        path: `${V1}/auth/dev-login`,
        schema: AuthResponse,
        body,
        auth: false,
      }),
    steamLogin: (body: SteamLoginRequest) =>
      http.request({
        method: 'POST',
        path: `${V1}/auth/steam`,
        schema: AuthResponse,
        body,
        auth: false,
      }),
    logout: () =>
      http.request({ method: 'POST', path: `${V1}/auth/logout`, schema: Empty, body: {} }),

    // queries
    me: () => get('/me', MeResponse),
    world: () => get('/world', WorldResponse),
    regionMap: (regionId: string) => get(`/regions/${enc(regionId)}/map`, RegionMapResponse),
    segment: (segmentId: string) => get(`/segments/${enc(segmentId)}`, SegmentDetailResponse),
    parcel: (parcelId: string) => get(`/parcels/${enc(parcelId)}`, ParcelDetailResponse),
    parcelSuitability: (parcelId: string) =>
      get(`/parcels/${enc(parcelId)}/suitability`, ParcelSuitabilityResponse),
    crops: () => get('/crops', CropsResponse),
    companyOverview: (companyId: string) =>
      get(`/companies/${enc(companyId)}/overview`, CompanyOverviewResponse),
    companyLedger: (
      companyId: string,
      q: { cursor?: string; limit?: number; accountCode?: string },
    ) => get(`/companies/${enc(companyId)}/ledger`, LedgerResponse, q),
    companyInventory: (companyId: string) =>
      get(`/companies/${enc(companyId)}/inventory`, InventoryResponse),
    companyPlots: (companyId: string) => get(`/companies/${enc(companyId)}/plots`, PlotsResponse),
    companyLoans: (companyId: string) => get(`/companies/${enc(companyId)}/loans`, LoansResponse),
    companyMachinery: (companyId: string) =>
      get(`/companies/${enc(companyId)}/machinery`, MachineryResponse),
    companyNotifications: (companyId: string, q: { unreadOnly?: boolean; limit?: number } = {}) =>
      get(`/companies/${enc(companyId)}/notifications`, NotificationsResponse, q),
    companyAwaySummary: (companyId: string) =>
      get(`/companies/${enc(companyId)}/away-summary`, AwaySummaryResponse),
    markets: () => get('/markets', MarketsResponse),
    marketPrices: (marketId: string, q: { itemId?: ItemId; days?: number }) =>
      get(`/markets/${enc(marketId)}/prices`, PriceHistoryResponse, q),
    marketQuote: (
      marketId: string,
      q: { itemId: ItemId; quantityKg: number },
      signal?: AbortSignal,
    ) => get(`/markets/${enc(marketId)}/quote`, SaleQuoteResponse, q, signal),
    listings: (q: ListingsParams) => get('/market-listings', ListingsResponse, { ...q }),
    contracts: (q: { scope: 'open' | 'mine'; limit?: number }) =>
      get('/contracts', ContractsResponse, q),
    leaderboard: () => get('/leaderboard', LeaderboardResponse),

    // commands (Idempotency-Key)
    createCompany: (body: CreateCompanyRequest) => command('/companies', body),
    purchaseParcel: (parcelId: string, body: PurchaseParcelRequest) =>
      command(`/parcels/${enc(parcelId)}/purchase`, body),
    leaseParcel: (parcelId: string, body: LeaseParcelRequest) =>
      command(`/parcels/${enc(parcelId)}/lease`, body),
    listParcel: (parcelId: string, body: ListParcelRequest) =>
      command(`/parcels/${enc(parcelId)}/list`, body),
    delistParcel: (parcelId: string) => command(`/parcels/${enc(parcelId)}/delist`),
    sellParcelToState: (parcelId: string, body: SellParcelToStateRequest) =>
      command(`/parcels/${enc(parcelId)}/sell-to-state`, body),
    plant: (body: PlantRequest) => command('/crop-plots', body),
    plotOperation: (plotId: string, body: PlotOperationRequest) =>
      command(`/crop-plots/${enc(plotId)}/operations`, body),
    harvest: (plotId: string) => command(`/crop-plots/${enc(plotId)}/harvest`),
    clearPlot: (plotId: string) => command(`/crop-plots/${enc(plotId)}/clear`),
    sellToMarket: (marketId: string, body: SellToMarketRequest) =>
      command(`/markets/${enc(marketId)}/sell`, body),
    createListing: (body: CreateListingRequest) => command('/market-listings', body),
    buyListing: (listingId: string, body: BuyListingRequest) =>
      command(`/market-listings/${enc(listingId)}/purchase`, body),
    cancelListing: (listingId: string) => command(`/market-listings/${enc(listingId)}/cancel`),
    createContract: (body: CreateContractRequest) => command('/contracts', body),
    acceptContract: (contractId: string, body: AcceptContractRequest) =>
      command(`/contracts/${enc(contractId)}/accept`, body),
    deliverContract: (contractId: string) => command(`/contracts/${enc(contractId)}/deliver`),
    cancelContract: (contractId: string) => command(`/contracts/${enc(contractId)}/cancel`),
    takeLoan: (body: TakeLoanRequest) => command('/loans', body),
    repayLoan: (loanId: string, body: RepayLoanRequest) =>
      command(`/loans/${enc(loanId)}/repay`, body),
    buyMachinery: (body: BuyMachineryRequest) => command('/machinery', body),
    sellMachinery: (assetId: string) => command(`/machinery/${enc(assetId)}/sell`),
    markNotificationsRead: (body: MarkNotificationsReadRequest) =>
      command('/notifications/read', body),
    devAdvance: (days: number) => command('/dev/advance', { days }),
  };
}

export type Api = ReturnType<typeof createApi>;
