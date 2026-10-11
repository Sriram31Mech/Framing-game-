/** Ownership classification for parcel tinting (pure; shared by the 3D view and 2D map). */
import type { ParcelSummaryDto } from '@bh/contracts';

export interface ParcelVisualContext {
  myCompanyId: string | null;
  aiCompanyIds: ReadonlySet<string>;
}

export type OwnershipClass = 'mine' | 'ai' | 'other' | 'forSale' | 'reserved';

export function ownershipClass(p: ParcelSummaryDto, ctx: ParcelVisualContext): OwnershipClass {
  const my = ctx.myCompanyId;
  if (my && (p.ownerCompanyId === my || p.operatorCompanyId === my)) return 'mine';
  if (p.status === 'for_sale') return 'forSale';
  const who = p.operatorCompanyId ?? p.ownerCompanyId;
  if (who && ctx.aiCompanyIds.has(who)) return 'ai';
  if (p.status === 'reserved') return 'reserved';
  return 'other';
}
