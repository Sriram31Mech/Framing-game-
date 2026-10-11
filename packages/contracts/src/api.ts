/**
 * HTTP API contract: /api/v1. Shared by @bh/server (validation) and @bh/client (typing + parsing).
 *
 * Rules:
 * - Auth: `Authorization: Bearer <token>` on every endpoint except /auth/* and /health*.
 * - Every POST command (except /auth/*) REQUIRES an `Idempotency-Key` header (8–128 chars).
 *   Replaying the same key with the same body returns the original response; a different body
 *   with the same key returns 422 IDEMPOTENCY_KEY_REUSED.
 * - The acting company is ALWAYS derived from the session, never from the request body.
 * - Money fields are integer paise; quantities are integer kg; days are integer game days.
 * - Clients never send authoritative prices/balances. Where a price is sent (expected... or min... fields), it is
 *   only a guard: the server rejects with 409 PRICE_CHANGED if the server-side value differs.
 * - Errors: { error: { code, message, details? } } with the HTTP status listed in ERROR_STATUS.
 */
import { z } from 'zod';
import {
  AI_PERSONALITIES,
  CROP_ID,
  GAME_DAY,
  ITEM_ID,
  KG,
  MACHINERY_TYPE,
  PAISE,
  POSITIVE_KG,
  POSITIVE_PAISE,
} from './common';

// ---------------------------------------------------------------------------
// Errors

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT', // stale version / concurrent modification / already owned
  'PRICE_CHANGED',
  'INSUFFICIENT_FUNDS',
  'INSUFFICIENT_STOCK',
  'RULE_VIOLATION', // game rule e.g. sowing season closed, parcel not owned, plot not ready
  'LIMIT_EXCEEDED', // e.g. borrowing limit, region full
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  'COMPANY_REQUIRED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRICE_CHANGED: 409,
  INSUFFICIENT_FUNDS: 422,
  INSUFFICIENT_STOCK: 422,
  RULE_VIOLATION: 422,
  LIMIT_EXCEEDED: 422,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  COMPANY_REQUIRED: 403,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export const ApiError = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

// ---------------------------------------------------------------------------
// Auth & identity

const USERNAME = z
  .string()
  .min(3)
  .max(24)
  .regex(/^[a-zA-Z0-9_]+$/, 'letters, digits and underscore only');

export const RegisterRequest = z.object({
  username: USERNAME,
  password: z.string().min(10).max(200),
  displayName: z.string().trim().min(2).max(40),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({ username: USERNAME, password: z.string().min(1).max(200) });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const DevLoginRequest = z.object({ username: USERNAME });
export type DevLoginRequest = z.infer<typeof DevLoginRequest>;

/** Hex-encoded Steam session ticket from GetAuthTicketForWebApi (validated server-side). */
export const SteamLoginRequest = z.object({ ticket: z.string().regex(/^[0-9a-fA-F]{16,4096}$/) });
export type SteamLoginRequest = z.infer<typeof SteamLoginRequest>;

export const AccountDto = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  kind: z.enum(['human', 'ai', 'dev']),
});
export type AccountDto = z.infer<typeof AccountDto>;

export const AuthResponse = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
  account: AccountDto,
});
export type AuthResponse = z.infer<typeof AuthResponse>;

export const AuthConfigResponse = z.object({
  devAuth: z.boolean(),
  passwordAuth: z.boolean(),
  steamAuth: z.boolean(),
  appEnv: z.string(),
});
export type AuthConfigResponse = z.infer<typeof AuthConfigResponse>;

export const CompanySummaryDto = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['human', 'ai']),
  status: z.enum(['active', 'distressed', 'bankrupt']),
  cashPaise: PAISE,
  aiPersonality: z.enum(AI_PERSONALITIES).nullable(),
});
export type CompanySummaryDto = z.infer<typeof CompanySummaryDto>;

export const MeResponse = z.object({
  account: AccountDto,
  company: CompanySummaryDto.nullable(),
  regionId: z.string(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const CreateCompanyRequest = z.object({
  name: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[\p{L}\p{N} &'.-]+$/u, "letters, digits, spaces and & ' . - only"),
});
export type CreateCompanyRequest = z.infer<typeof CreateCompanyRequest>;

// ---------------------------------------------------------------------------
// World / map

export const GameDateDto = z.object({
  day: GAME_DAY,
  year: z.number().int(),
  month: z.number().int(),
  dayOfMonth: z.number().int(),
  dayOfYear: z.number().int(),
  season: z.enum(['kharif', 'rabi', 'zaid']),
  label: z.string(),
});

export const WorldResponse = z.object({
  regionId: z.string(),
  regionName: z.string(),
  gameDay: GAME_DAY,
  date: GameDateDto,
  realSecondsPerGameDay: z.number().int().positive(),
  /** Wall-clock ISO time when the next day is expected to complete. */
  nextTickAt: z.iso.datetime(),
  rulesetVersion: z.string(),
  paused: z.boolean(),
  weather: z.object({ rainMm: z.number(), tempC: z.number(), event: z.string() }).nullable(),
});
export type WorldResponse = z.infer<typeof WorldResponse>;

const Point = z.object({ x: z.number(), y: z.number() });

export const ParcelEnvironmentDto = z.object({
  areaHa: z.number(),
  elevationM: z.number(),
  slopePct: z.number(),
  soilTexture: z.string(),
  soilPh: z.number(),
  fertility: z.number(),
  drainage: z.string(),
  waterAccess: z.string(),
  roadDistanceKm: z.number(),
});

export const ParcelStatus = z.enum(['for_sale', 'owned', 'leased', 'reserved']);

export const ParcelSummaryDto = z.object({
  id: z.string(),
  polygon: z.array(Point),
  centroid: Point,
  areaHa: z.number(),
  status: ParcelStatus,
  ownerCompanyId: z.uuid().nullable(),
  ownerName: z.string().nullable(),
  /** Company currently farming it (owner, or lessee when leased). */
  operatorCompanyId: z.uuid().nullable(),
  listPricePaise: PAISE.nullable(),
  isStarterPlot: z.boolean(),
  soilTexture: z.string(),
  waterAccess: z.string(),
  elevationM: z.number(),
  version: z.number().int(),
  /** Live crop for rendering, if any. */
  crop: z
    .object({
      cropId: CROP_ID,
      status: z.enum(['growing', 'ready', 'failed']),
      progress: z.number().min(0).max(1),
      health: z.number(),
    })
    .nullable(),
});
export type ParcelSummaryDto = z.infer<typeof ParcelSummaryDto>;

export const MarketDefinitionDto = z.object({
  id: z.string(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  feeBps: z.number().int(),
  demandScale: z.number(),
  priceScale: z.number(),
});
export type MarketDefinitionDto = z.infer<typeof MarketDefinitionDto>;

export const RegionMapResponse = z.object({
  region: z.object({
    id: z.string(),
    name: z.string(),
    seed: z.number().int(),
    halfSizeM: z.number(),
  }),
  parcels: z.array(ParcelSummaryDto),
  roads: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['highway', 'district', 'village', 'farm_track']),
      points: z.array(Point),
      widthM: z.number(),
    }),
  ),
  river: z.object({ points: z.array(Point), widthM: z.number() }),
  features: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['village', 'warehouse', 'temple', 'water_tank', 'tree_cluster', 'school']),
      x: z.number(),
      y: z.number(),
      rotation: z.number(),
      scale: z.number(),
    }),
  ),
  markets: z.array(MarketDefinitionDto),
});
export type RegionMapResponse = z.infer<typeof RegionMapResponse>;

export const SuitabilityDto = z.object({
  cropId: CROP_ID,
  score: z.number(),
  grade: z.enum(['excellent', 'good', 'fair', 'poor', 'unsuitable']),
  factors: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      score: z.number(),
      weight: z.number(),
      detail: z.string(),
    }),
  ),
  limitingFactor: z.string().nullable(),
  yieldKgPerHa: z.object({ low: z.number(), expected: z.number(), high: z.number() }),
  irrigationAssumed: z.boolean(),
  sowingOpen: z.boolean(),
  nextSowingMonth: z.number().int(),
});
export type SuitabilityDto = z.infer<typeof SuitabilityDto>;

export const CropPlotDto = z.object({
  id: z.uuid(),
  parcelId: z.string(),
  companyId: z.uuid(),
  cropId: CROP_ID,
  status: z.enum(['growing', 'ready', 'failed', 'harvested', 'cleared']),
  sownDay: GAME_DAY,
  stage: z.string(), // germination | vegetative | flowering | maturation | ready
  progress: z.number(),
  health: z.number(),
  waterStress: z.number(),
  pestPressure: z.number(),
  irrigated: z.boolean(),
  fertilized: z.boolean(),
  pestProtectedUntilDay: GAME_DAY.nullable(),
  expectedHarvestKg: KG,
  expectedQuality: z.number(),
  readyDay: GAME_DAY.nullable(), // estimated (growing) or actual (ready)
  harvestDeadlineDay: GAME_DAY.nullable(), // last loss-free day
  costBasisPaise: PAISE,
  dailyIrrigationCostPaise: PAISE,
  version: z.number().int(),
});
export type CropPlotDto = z.infer<typeof CropPlotDto>;

export const ParcelDetailResponse = z.object({
  parcel: ParcelSummaryDto.extend({
    env: ParcelEnvironmentDto,
    marketDistanceKm: z.number(),
    nearestMarketId: z.string(),
    basePricePaise: PAISE,
    leaseRentPaisePerSeason: PAISE,
    lease: z
      .object({
        id: z.uuid(),
        lesseeCompanyId: z.uuid(),
        lesseeName: z.string(),
        startDay: GAME_DAY,
        endDay: GAME_DAY,
        rentPaise: PAISE,
      })
      .nullable(),
    /** Land tax per 30-day month for this parcel. */
    monthlyLandTaxPaise: PAISE,
  }),
  plot: CropPlotDto.nullable(),
  /** What the requesting company may do right now, with reasons when not. */
  actions: z.object({
    canPurchase: z.boolean(),
    canLease: z.boolean(),
    canPlant: z.boolean(),
    canListForSale: z.boolean(),
    canSellToState: z.boolean(),
    reasons: z.record(z.string(), z.string()),
  }),
});
export type ParcelDetailResponse = z.infer<typeof ParcelDetailResponse>;

export const ParcelSuitabilityResponse = z.object({
  parcelId: z.string(),
  gameDay: GAME_DAY,
  irrigationAvailable: z.boolean(),
  results: z.array(SuitabilityDto),
});
export type ParcelSuitabilityResponse = z.infer<typeof ParcelSuitabilityResponse>;

export const CropInfoDto = z.object({
  id: CROP_ID,
  name: z.string(),
  localName: z.string(),
  sowingMonths: z.array(z.number().int()),
  durationDays: z.number().int(),
  harvestWindowDays: z.number().int(),
  baseYieldKgPerHa: z.number(),
  basePricePaisePerKg: PAISE,
  shelfLifeDays: z.number().int(),
  waterNeed: z.enum(['low', 'medium', 'high']),
  costs: z.object({
    seedPaisePerHa: PAISE,
    sowingLaborPaisePerHa: PAISE,
    fertilizerPaisePerHa: PAISE,
    pestControlPaisePerHa: PAISE,
    harvestLaborPaisePerHa: PAISE,
    irrigationPaisePerHaPerDay: PAISE,
  }),
});
export type CropInfoDto = z.infer<typeof CropInfoDto>;
export const CropsResponse = z.object({ crops: z.array(CropInfoDto), rulesetVersion: z.string() });
export type CropsResponse = z.infer<typeof CropsResponse>;

// ---------------------------------------------------------------------------
// Company views

export const CompanyOverviewResponse = z.object({
  company: CompanySummaryDto.extend({
    escrowPaise: PAISE,
    distressSinceDay: GAME_DAY.nullable(),
    graceDaysRemaining: z.number().int().nullable(),
    bankruptcies: z.number().int(),
    foundedDay: GAME_DAY,
  }),
  balanceSheet: z.object({
    cashPaise: PAISE,
    escrowPaise: PAISE,
    inventoryValuePaise: PAISE,
    landValuePaise: PAISE,
    machineryBookValuePaise: PAISE,
    totalAssetsPaise: PAISE,
    loanOutstandingPaise: PAISE,
    totalLiabilitiesPaise: PAISE,
    equityPaise: PAISE,
  }),
  /** Profit & loss over the trailing `periodDays`. */
  profitAndLoss: z.object({
    periodDays: z.number().int(),
    revenuePaise: PAISE,
    expensesPaise: PAISE,
    netPaise: PAISE,
    lines: z.array(z.object({ accountCode: z.string(), label: z.string(), amountPaise: PAISE })),
  }),
  /** Daily cash balance for the trailing period (for charts). */
  cashSeries: z.array(z.object({ day: GAME_DAY, cashPaise: PAISE })),
  counts: z.object({
    parcelsOwned: z.number().int(),
    parcelsLeased: z.number().int(),
    plotsGrowing: z.number().int(),
    plotsReady: z.number().int(),
    openListings: z.number().int(),
    openContracts: z.number().int(),
    unreadNotifications: z.number().int(),
  }),
  upcoming: z.array(
    z.object({
      day: GAME_DAY,
      kind: z.enum(['loan_due', 'lease_end', 'contract_deadline', 'harvest_deadline', 'land_tax']),
      label: z.string(),
      amountPaise: PAISE.nullable(),
      entityId: z.string().nullable(),
    }),
  ),
  valuationPaise: PAISE,
});
export type CompanyOverviewResponse = z.infer<typeof CompanyOverviewResponse>;

export const LedgerEntryDto = z.object({
  id: z.string(),
  transactionId: z.uuid(),
  kind: z.string(),
  description: z.string(),
  accountCode: z.string(),
  amountPaise: PAISE,
  gameDay: GAME_DAY,
  createdAt: z.iso.datetime(),
});
export type LedgerEntryDto = z.infer<typeof LedgerEntryDto>;
export const LedgerQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  accountCode: z.string().optional(),
});
export const LedgerResponse = z.object({
  entries: z.array(LedgerEntryDto),
  nextCursor: z.string().nullable(),
});
export type LedgerResponse = z.infer<typeof LedgerResponse>;

export const InventoryLotDto = z.object({
  id: z.uuid(),
  itemId: ITEM_ID,
  quantityKg: KG,
  reservedKg: KG,
  availableKg: KG,
  quality: z.number().int(),
  costBasisPaise: PAISE,
  producedDay: GAME_DAY,
  expiresDay: GAME_DAY,
  source: z.enum(['harvest', 'trade', 'contract']),
});
export type InventoryLotDto = z.infer<typeof InventoryLotDto>;
export const InventoryResponse = z.object({
  lots: z.array(InventoryLotDto),
  totals: z.array(z.object({ itemId: ITEM_ID, quantityKg: KG, availableKg: KG })),
  storageCapacityKg: KG,
});
export type InventoryResponse = z.infer<typeof InventoryResponse>;

export const PlotsResponse = z.object({ plots: z.array(CropPlotDto) });
export type PlotsResponse = z.infer<typeof PlotsResponse>;

export const LoanDto = z.object({
  id: z.uuid(),
  principalPaise: PAISE,
  annualRateBps: z.number().int(),
  termMonths: z.number().int(),
  emiPaise: PAISE,
  outstandingPaise: PAISE,
  instalmentsPaid: z.number().int(),
  missedPayments: z.number().int(),
  startDay: GAME_DAY,
  nextDueDay: GAME_DAY,
  status: z.enum(['active', 'repaid', 'written_off']),
});
export type LoanDto = z.infer<typeof LoanDto>;
export const LoansResponse = z.object({
  loans: z.array(LoanDto),
  offer: z.object({
    maxPrincipalPaise: PAISE,
    annualRateBps: z.number().int(),
    maxTermMonths: z.number().int(),
  }),
});
export type LoansResponse = z.infer<typeof LoansResponse>;

export const MachineryAssetDto = z.object({
  id: z.uuid(),
  type: MACHINERY_TYPE,
  name: z.string(),
  purchasePricePaise: PAISE,
  bookValuePaise: PAISE,
  purchasedDay: GAME_DAY,
});
export const MachineryResponse = z.object({
  owned: z.array(MachineryAssetDto),
  catalog: z.array(
    z.object({
      type: MACHINERY_TYPE,
      name: z.string(),
      pricePaise: PAISE,
      maintenancePaisePerDay: PAISE,
      description: z.string(),
    }),
  ),
});
export type MachineryResponse = z.infer<typeof MachineryResponse>;

export const NotificationDto = z.object({
  id: z.uuid(),
  type: z.string(),
  severity: z.enum(['info', 'success', 'warning', 'danger']),
  title: z.string(),
  body: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  gameDay: GAME_DAY,
  createdAt: z.iso.datetime(),
  read: z.boolean(),
});
export type NotificationDto = z.infer<typeof NotificationDto>;
/**
 * Boolean query-string flag. (z.coerce.boolean() would turn the string "false" into true.)
 * Accepts true/false/1/0 strings or real booleans.
 */
const QueryFlag = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const NotificationsQuery = z.object({
  unreadOnly: QueryFlag.default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const NotificationsResponse = z.object({
  notifications: z.array(NotificationDto),
  unreadCount: z.number().int(),
});
export type NotificationsResponse = z.infer<typeof NotificationsResponse>;

/** "While you were away" summary, computed from events since the company's last activity. */
export const AwaySummaryResponse = z.object({
  fromDay: GAME_DAY,
  toDay: GAME_DAY,
  cashChangePaise: PAISE,
  highlights: z.array(
    z.object({ severity: z.enum(['info', 'success', 'warning', 'danger']), text: z.string() }),
  ),
});
export type AwaySummaryResponse = z.infer<typeof AwaySummaryResponse>;

// ---------------------------------------------------------------------------
// Markets & trade

export const MarketPriceDto = z.object({
  itemId: ITEM_ID,
  pricePaisePerKg: PAISE,
  basePricePaisePerKg: PAISE,
  demandKgPerDay: KG,
  changePct7d: z.number(),
});
export const MarketsResponse = z.object({
  markets: z.array(MarketDefinitionDto.extend({ prices: z.array(MarketPriceDto) })),
});
export type MarketsResponse = z.infer<typeof MarketsResponse>;

export const PriceHistoryQuery = z.object({
  itemId: ITEM_ID.optional(),
  days: z.coerce.number().int().min(1).max(360).default(60),
});
export const PriceHistoryResponse = z.object({
  marketId: z.string(),
  series: z.array(
    z.object({
      itemId: ITEM_ID,
      points: z.array(z.object({ day: GAME_DAY, pricePaisePerKg: PAISE, volumeKg: KG })),
    }),
  ),
});
export type PriceHistoryResponse = z.infer<typeof PriceHistoryResponse>;

export const SaleQuoteQuery = z.object({
  itemId: ITEM_ID,
  quantityKg: z.coerce.number().int().positive(),
});
export const SaleQuoteResponse = z.object({
  marketId: z.string(),
  itemId: ITEM_ID,
  quantityKg: KG,
  quality: z.number(),
  unitPricePaise: PAISE,
  grossPaise: PAISE,
  feePaise: PAISE,
  transportPaise: PAISE,
  netPaise: PAISE,
  priceImpactPct: z.number(),
});
export type SaleQuoteResponse = z.infer<typeof SaleQuoteResponse>;

export const ListingDto = z.object({
  id: z.uuid(),
  sellerCompanyId: z.uuid(),
  sellerName: z.string(),
  itemId: ITEM_ID,
  quality: z.number().int(),
  quantityKg: KG,
  remainingKg: KG,
  unitPricePaise: PAISE,
  status: z.enum(['open', 'filled', 'cancelled', 'expired']),
  createdDay: GAME_DAY,
  expiresDay: GAME_DAY,
  version: z.number().int(),
});
export type ListingDto = z.infer<typeof ListingDto>;
export const ListingsQuery = z.object({
  itemId: ITEM_ID.optional(),
  mine: QueryFlag.default(false),
  status: z.enum(['open', 'filled', 'cancelled', 'expired']).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const ListingsResponse = z.object({ listings: z.array(ListingDto) });
export type ListingsResponse = z.infer<typeof ListingsResponse>;

export const ContractDto = z.object({
  id: z.uuid(),
  buyerCompanyId: z.uuid(),
  buyerName: z.string(),
  sellerCompanyId: z.uuid().nullable(),
  sellerName: z.string().nullable(),
  itemId: ITEM_ID,
  quantityKg: KG,
  minQuality: z.number().int(),
  unitPricePaise: PAISE,
  totalPaise: PAISE,
  deliveryByDay: GAME_DAY,
  createdDay: GAME_DAY,
  acceptedDay: GAME_DAY.nullable(),
  settledDay: GAME_DAY.nullable(),
  status: z.enum(['open', 'accepted', 'fulfilled', 'cancelled', 'defaulted', 'expired']),
  termsHash: z.string(),
  version: z.number().int(),
});
export type ContractDto = z.infer<typeof ContractDto>;
export const ContractsQuery = z.object({
  scope: z.enum(['open', 'mine']).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const ContractsResponse = z.object({ contracts: z.array(ContractDto) });
export type ContractsResponse = z.infer<typeof ContractsResponse>;

export const LeaderboardResponse = z.object({
  entries: z.array(
    z.object({
      rank: z.number().int(),
      companyId: z.uuid(),
      name: z.string(),
      kind: z.enum(['human', 'ai']),
      valuationPaise: PAISE,
      landHa: z.number(),
    }),
  ),
});
export type LeaderboardResponse = z.infer<typeof LeaderboardResponse>;

// ---------------------------------------------------------------------------
// Commands (POST, Idempotency-Key required)

export const PurchaseParcelRequest = z.object({
  expectedVersion: z.number().int().positive(),
  expectedPricePaise: POSITIVE_PAISE,
});
export type PurchaseParcelRequest = z.infer<typeof PurchaseParcelRequest>;

export const LeaseParcelRequest = z.object({
  expectedVersion: z.number().int().positive(),
  seasons: z.number().int().min(1).max(3),
  expectedRentPaise: POSITIVE_PAISE, // total for all seasons
});
export type LeaseParcelRequest = z.infer<typeof LeaseParcelRequest>;

export const ListParcelRequest = z.object({ pricePaise: POSITIVE_PAISE });
export type ListParcelRequest = z.infer<typeof ListParcelRequest>;

export const SellParcelToStateRequest = z.object({
  expectedVersion: z.number().int().positive(),
  expectedPricePaise: POSITIVE_PAISE,
});
export type SellParcelToStateRequest = z.infer<typeof SellParcelToStateRequest>;

export const PlantRequest = z.object({
  parcelId: z.string().min(1).max(32),
  cropId: CROP_ID,
  irrigate: z.boolean(),
  fertilize: z.boolean(),
  /** Guard: client's displayed planting cost; 409 PRICE_CHANGED if server cost differs. */
  expectedCostPaise: PAISE,
});
export type PlantRequest = z.infer<typeof PlantRequest>;

export const PlotOperationRequest = z.object({
  op: z.enum(['irrigation_on', 'irrigation_off', 'fertilize', 'pest_control']),
});
export type PlotOperationRequest = z.infer<typeof PlotOperationRequest>;

export const SellToMarketRequest = z.object({
  itemId: ITEM_ID,
  quantityKg: POSITIVE_KG,
  /** Slippage guard: reject if realised net unit price (after fee+transport) would be below this. */
  minNetUnitPricePaise: PAISE,
});
export type SellToMarketRequest = z.infer<typeof SellToMarketRequest>;

export const CreateListingRequest = z.object({
  itemId: ITEM_ID,
  quantityKg: POSITIVE_KG,
  unitPricePaise: POSITIVE_PAISE,
  durationDays: z.number().int().min(1).max(60),
  /** Optional specific lot; otherwise best-quality available lot with enough stock. */
  lotId: z.uuid().optional(),
});
export type CreateListingRequest = z.infer<typeof CreateListingRequest>;

export const BuyListingRequest = z.object({
  quantityKg: POSITIVE_KG,
  expectedUnitPricePaise: POSITIVE_PAISE,
});
export type BuyListingRequest = z.infer<typeof BuyListingRequest>;

export const CreateContractRequest = z.object({
  itemId: ITEM_ID,
  quantityKg: POSITIVE_KG,
  minQuality: z.number().int().min(0).max(100),
  unitPricePaise: POSITIVE_PAISE,
  /** Days from now; delivery deadline = current day + deliveryWithinDays. */
  deliveryWithinDays: z.number().int().min(3).max(180),
});
export type CreateContractRequest = z.infer<typeof CreateContractRequest>;

export const AcceptContractRequest = z.object({
  expectedVersion: z.number().int().positive(),
  termsHash: z.string().length(64),
});
export type AcceptContractRequest = z.infer<typeof AcceptContractRequest>;

export const TakeLoanRequest = z.object({
  principalPaise: POSITIVE_PAISE,
  termMonths: z.number().int().min(1).max(36),
  expectedRateBps: z.number().int().min(0),
});
export type TakeLoanRequest = z.infer<typeof TakeLoanRequest>;

export const RepayLoanRequest = z.object({ amountPaise: POSITIVE_PAISE });
export type RepayLoanRequest = z.infer<typeof RepayLoanRequest>;

export const BuyMachineryRequest = z.object({
  type: MACHINERY_TYPE,
  expectedPricePaise: POSITIVE_PAISE,
});
export type BuyMachineryRequest = z.infer<typeof BuyMachineryRequest>;

export const MarkNotificationsReadRequest = z.object({
  ids: z.array(z.uuid()).max(200).optional(),
  all: z.boolean().optional(),
});
export type MarkNotificationsReadRequest = z.infer<typeof MarkNotificationsReadRequest>;

/** Dev/test only (ENABLE_DEV_ADMIN and APP_ENV != production): run N daily ticks immediately. */
export const DevAdvanceRequest = z.object({ days: z.number().int().min(1).max(400) });
export type DevAdvanceRequest = z.infer<typeof DevAdvanceRequest>;

/** Standard success envelope for commands. */
export const CommandResult = <T extends z.ZodType>(result: T) =>
  z.object({ ok: z.literal(true), gameDay: GAME_DAY, result });

export const CommandOk = z.object({ ok: z.literal(true), gameDay: GAME_DAY, result: z.unknown() });
export type CommandOk = z.infer<typeof CommandOk>;

// ---------------------------------------------------------------------------
// Endpoint catalogue (for docs/tests/client). Path params prefixed with ':'.

export const ENDPOINTS = {
  // auth (no Idempotency-Key)
  authConfig: 'GET /api/v1/auth/config',
  register: 'POST /api/v1/auth/register',
  login: 'POST /api/v1/auth/login',
  devLogin: 'POST /api/v1/auth/dev-login',
  steamLogin: 'POST /api/v1/auth/steam',
  logout: 'POST /api/v1/auth/logout',
  // queries
  me: 'GET /api/v1/me',
  world: 'GET /api/v1/world',
  regionMap: 'GET /api/v1/regions/:regionId/map',
  parcel: 'GET /api/v1/parcels/:parcelId',
  parcelSuitability: 'GET /api/v1/parcels/:parcelId/suitability',
  crops: 'GET /api/v1/crops',
  companyOverview: 'GET /api/v1/companies/:companyId/overview',
  companyLedger: 'GET /api/v1/companies/:companyId/ledger',
  companyInventory: 'GET /api/v1/companies/:companyId/inventory',
  companyPlots: 'GET /api/v1/companies/:companyId/plots',
  companyLoans: 'GET /api/v1/companies/:companyId/loans',
  companyMachinery: 'GET /api/v1/companies/:companyId/machinery',
  companyNotifications: 'GET /api/v1/companies/:companyId/notifications',
  companyAwaySummary: 'GET /api/v1/companies/:companyId/away-summary',
  markets: 'GET /api/v1/markets',
  marketPrices: 'GET /api/v1/markets/:marketId/prices',
  marketQuote: 'GET /api/v1/markets/:marketId/quote',
  listings: 'GET /api/v1/market-listings',
  contracts: 'GET /api/v1/contracts',
  leaderboard: 'GET /api/v1/leaderboard',
  // commands (Idempotency-Key required)
  createCompany: 'POST /api/v1/companies',
  purchaseParcel: 'POST /api/v1/parcels/:parcelId/purchase',
  leaseParcel: 'POST /api/v1/parcels/:parcelId/lease',
  listParcel: 'POST /api/v1/parcels/:parcelId/list',
  delistParcel: 'POST /api/v1/parcels/:parcelId/delist',
  sellParcelToState: 'POST /api/v1/parcels/:parcelId/sell-to-state',
  plant: 'POST /api/v1/crop-plots',
  plotOperation: 'POST /api/v1/crop-plots/:plotId/operations',
  harvest: 'POST /api/v1/crop-plots/:plotId/harvest',
  clearPlot: 'POST /api/v1/crop-plots/:plotId/clear',
  sellToMarket: 'POST /api/v1/markets/:marketId/sell',
  createListing: 'POST /api/v1/market-listings',
  buyListing: 'POST /api/v1/market-listings/:listingId/purchase',
  cancelListing: 'POST /api/v1/market-listings/:listingId/cancel',
  createContract: 'POST /api/v1/contracts',
  acceptContract: 'POST /api/v1/contracts/:contractId/accept',
  deliverContract: 'POST /api/v1/contracts/:contractId/deliver',
  cancelContract: 'POST /api/v1/contracts/:contractId/cancel',
  takeLoan: 'POST /api/v1/loans',
  repayLoan: 'POST /api/v1/loans/:loanId/repay',
  buyMachinery: 'POST /api/v1/machinery',
  sellMachinery: 'POST /api/v1/machinery/:assetId/sell',
  markNotificationsRead: 'POST /api/v1/notifications/read',
  devAdvance: 'POST /api/v1/dev/advance',
  // ops (no auth)
  health: 'GET /healthz',
  ready: 'GET /readyz',
  version: 'GET /api/v1/version',
  metrics: 'GET /metrics',
  websocket: 'GET /api/v1/ws',
} as const;
