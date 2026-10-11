import type { CropInfoDto, ParcelDetailResponse, SuitabilityDto } from '@bh/contracts';
import type { CropId } from '@bh/domain';
import { monthName } from '../../lib/format';
import { CROP_META as CROP_LOOK } from '../../lib/cropMeta';

export type ParcelDetail = ParcelDetailResponse['parcel'];

export function cropName(id: CropId, crops?: readonly CropInfoDto[]): string {
  const info = crops?.find((c) => c.id === id);
  return info ? info.name : CROP_LOOK[id].label;
}

export function cropLocalName(id: CropId, crops?: readonly CropInfoDto[]): string | null {
  return crops?.find((c) => c.id === id)?.localName ?? null;
}

export function sowingWindowText(s: SuitabilityDto): string {
  if (s.sowingOpen) return 'Sowing open now';
  return `Opens in ${monthName(s.nextSowingMonth, true)}`;
}

export function sowingMonthsText(crop?: CropInfoDto): string {
  if (!crop || crop.sowingMonths.length === 0) return '—';
  return crop.sowingMonths.map((m) => monthName(m)).join(', ');
}

export function statusLabel(status: ParcelDetail['status']): string {
  switch (status) {
    case 'for_sale':
      return 'For sale';
    case 'owned':
      return 'Owned';
    case 'leased':
      return 'Leased';
    default:
      return 'Reserved';
  }
}

export function gradeTone(score: number): 'success' | 'warning' | 'danger' | undefined {
  if (score >= 0.75) return 'success';
  if (score >= 0.45) return 'warning';
  return 'danger';
}
