import type { DailyWeather, GameDate, RegionClimate } from '@bh/domain';
import type { CoreDeps } from '../commands/types';
import type { DbClient } from '../db/pool';

/** Counters collected while processing one day; persisted on the checkpoint row. */
export interface TickStats {
  plotsProcessed: number;
  cropEvents: number;
  cropsReady: number;
  cropsFailed: number;
  irrigationCharges: number;
  lotsSpoiled: number;
  marketItemsUpdated: number;
  listingsExpired: number;
  contractsExpired: number;
  contractsDefaulted: number;
  leasesEnded: number;
  loanPayments: number;
  missedPayments: number;
  landTaxCharges: number;
  machineryDepreciated: number;
  companiesDistressed: number;
  companiesRecovered: number;
  bankruptcies: number;
  incomeTaxCharges: number;
  ledgerTransactions: number;
  events: number;
  notifications: number;
}

export function emptyStats(): TickStats {
  return {
    plotsProcessed: 0,
    cropEvents: 0,
    cropsReady: 0,
    cropsFailed: 0,
    irrigationCharges: 0,
    lotsSpoiled: 0,
    marketItemsUpdated: 0,
    listingsExpired: 0,
    contractsExpired: 0,
    contractsDefaulted: 0,
    leasesEnded: 0,
    loanPayments: 0,
    missedPayments: 0,
    landTaxCharges: 0,
    machineryDepreciated: 0,
    companiesDistressed: 0,
    companiesRecovered: 0,
    bankruptcies: 0,
    incomeTaxCharges: 0,
    ledgerTransactions: 0,
    events: 0,
    notifications: 0,
  };
}

export interface AdvanceDayResult {
  regionId: string;
  /** The day whose end was processed (D). */
  processedDay: number;
  /** The clock's day after this call (D+1 when advanced, unchanged when skipped). */
  gameDay: number;
  /** True when another worker/call already processed this day (idempotent no-op). */
  skipped: boolean;
  /** Why the call was a no-op, if it was. */
  skipReason?: 'already_processed' | 'paused';
  durationMs: number;
  stats: TickStats;
}

export interface AdvanceDayOptions {
  /**
   * Only process this day. When the clock is no longer at `expectedDay` (another caller got
   * there first) the call is a no-op. Defaults to the clock's day observed before locking, which
   * makes N concurrent calls advance exactly one day.
   */
  expectedDay?: number;
  /** Return `skipped` (reason 'paused') instead of ticking when the clock is paused. */
  skipIfPaused?: boolean;
  /**
   * Fault injection for tests: throw after every step has run but before COMMIT, proving the
   * day is applied atomically (all or nothing).
   */
  failBeforeCommit?: boolean;
}

/** Everything a tick step needs. All writes go through `client` (the tick's transaction). */
export interface TickContext {
  deps: CoreDeps;
  client: DbClient;
  regionId: string;
  regionSeed: number;
  climate: RegionClimate;
  rulesetVersion: string;
  /** Day being processed (D). */
  day: number;
  date: GameDate;
  weather: DailyWeather;
  stats: TickStats;
  /** Companies whose cash/escrow changed during the tick (get a `company.updated` event). */
  touchedCompanies: Set<string>;
}
