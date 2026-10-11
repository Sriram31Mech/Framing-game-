/**
 * The validated command layer interface. HTTP handlers (humans) and the AI scheduler (AI
 * companies) both submit commands through `executeCommand` (commands/execute.ts) — there is no
 * other write path for gameplay state.
 */
import type { ErrorCode } from '@bh/contracts';
import type { CropId, ItemId, MachineryType } from '@bh/domain';
import type { Logger } from 'pino';
import type { AppConfig } from '../config';
import type { DbPool } from '../db/pool';

export interface CoreDeps {
  pool: DbPool;
  config: AppConfig;
  logger: Logger;
}

export interface Actor {
  /** The company on whose behalf the command runs (always derived server-side). */
  companyId: string;
  /** Human account, or null for AI/system actors. */
  accountId: string | null;
  kind: 'human' | 'ai' | 'system';
  regionId: string;
}

export type GameCommand =
  | {
      type: 'purchase_parcel';
      parcelId: string;
      expectedVersion: number;
      expectedPricePaise: number;
    }
  | {
      type: 'lease_parcel';
      parcelId: string;
      expectedVersion: number;
      seasons: number;
      expectedRentPaise: number;
    }
  | { type: 'list_parcel'; parcelId: string; pricePaise: number }
  | { type: 'delist_parcel'; parcelId: string }
  | {
      type: 'sell_parcel_to_state';
      parcelId: string;
      expectedVersion: number;
      expectedPricePaise: number;
    }
  | {
      type: 'plant';
      parcelId: string;
      cropId: CropId;
      irrigate: boolean;
      fertilize: boolean;
      expectedCostPaise: number;
    }
  | {
      type: 'plot_operation';
      plotId: string;
      op: 'irrigation_on' | 'irrigation_off' | 'fertilize' | 'pest_control';
    }
  | { type: 'harvest'; plotId: string }
  | { type: 'clear_plot'; plotId: string }
  | {
      type: 'sell_to_market';
      marketId: string;
      itemId: ItemId;
      quantityKg: number;
      minNetUnitPricePaise: number;
    }
  | {
      type: 'create_listing';
      itemId: ItemId;
      quantityKg: number;
      unitPricePaise: number;
      durationDays: number;
      lotId?: string;
    }
  | { type: 'buy_listing'; listingId: string; quantityKg: number; expectedUnitPricePaise: number }
  | { type: 'cancel_listing'; listingId: string }
  | {
      type: 'create_contract';
      itemId: ItemId;
      quantityKg: number;
      minQuality: number;
      unitPricePaise: number;
      deliveryWithinDays: number;
    }
  | { type: 'accept_contract'; contractId: string; expectedVersion: number; termsHash: string }
  | { type: 'deliver_contract'; contractId: string }
  | { type: 'cancel_contract'; contractId: string }
  | { type: 'take_loan'; principalPaise: number; termMonths: number; expectedRateBps: number }
  | { type: 'repay_loan'; loanId: string; amountPaise: number }
  | { type: 'buy_machinery'; machineryType: MachineryType; expectedPricePaise: number }
  | { type: 'sell_machinery'; assetId: string }
  | { type: 'mark_notifications_read'; ids?: string[]; all?: boolean };

export type GameCommandType = GameCommand['type'];

export type CommandOutcome =
  | { ok: true; gameDay: number; result: unknown; replayed: boolean }
  | {
      ok: false;
      status: number;
      error: { code: ErrorCode; message: string; details?: unknown };
      replayed: boolean;
    };

export interface ExecuteOptions {
  /**
   * Required for human commands. Stored with the outcome in `idempotency_keys` in the same
   * transaction as the state change, so a retry returns the original outcome exactly once.
   */
  idempotencyKey?: string;
}
