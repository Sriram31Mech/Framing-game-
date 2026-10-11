import { z } from 'zod';
import { CROP_IDS, ITEM_IDS, MACHINERY_TYPES } from '@bh/domain';

export const PAISE = z.number().int().refine(Number.isSafeInteger, 'must be a safe integer');
export const POSITIVE_PAISE = PAISE.refine((v) => v > 0, 'must be positive');
export const KG = z.number().int().min(0).refine(Number.isSafeInteger, 'must be a safe integer');
export const POSITIVE_KG = z.number().int().min(1).max(100_000_000);
export const GAME_DAY = z.number().int().min(0);
export const CROP_ID = z.enum(CROP_IDS);
export const ITEM_ID = z.enum(ITEM_IDS);
export const MACHINERY_TYPE = z.enum(MACHINERY_TYPES);
export const AI_PERSONALITIES = ['cautious', 'expansionist', 'trader'] as const;

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IdempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_\-:.]+$/);
