/**
 * Scene colour palette (linear-space conversion handled by THREE.Color). Warm, slightly
 * desaturated "architectural model" tones with Indian regional accents.
 */
import type { CropId } from '@bh/domain';
import { Color } from 'three';
import { CROP_META } from '../lib/cropMeta';

export const SKY = '#d9ccb4';
export const FOG = '#d6c8ae';

export const TERRAIN = {
  valley: new Color('#6f8f45'),
  meadow: new Color('#8a9a52'),
  upland: new Color('#9c9459'),
  hill: new Color('#5f7a3c'),
  laterite: new Color('#a45a37'),
  sand: new Color('#c9b48a'),
  bank: new Color('#7b6a4a'),
  skirtTop: new Color('#6b4a32'),
  skirtBottom: new Color('#3a2a1e'),
};

export const SOIL: Record<string, Color> = {
  laterite: new Color('#9e4b2e'),
  clay: new Color('#6d4934'),
  clay_loam: new Color('#7c5537'),
  loam: new Color('#876543'),
  sandy_loam: new Color('#a1845b'),
  sandy: new Color('#b89d72'),
};
export const SOIL_FALLBACK = new Color('#876543');
export const FALLOW = new Color('#8f8c55');

export const OWNERSHIP = {
  mine: new Color('#ffad33'),
  other: new Color('#b3a68f'),
  ai: new Color('#6f8fe0'),
  forSale: new Color('#f3eee2'),
  forSaleGap: new Color('#9a8a6c'),
  reserved: new Color('#8f8676'),
  hover: new Color('#fff1c9'),
  selected: new Color('#ffcf5c'),
};

export const ROAD = {
  asphalt: new Color('#4e4c4a'),
  asphaltLight: new Color('#5d5a56'),
  kerb: new Color('#c9c0ad'),
  dirt: new Color('#a0693f'),
  track: new Color('#b0855a'),
  marking: new Color('#efe7d2'),
};

export const WATER = { deep: '#2f6f7a', shallow: '#5c9c94' };

export interface CropLook {
  /** Colour keyframes over growth progress 0..1. */
  stops: [number, Color][];
  /** Height at maturity, metres. */
  maxHeight: number;
  /** Row ridge width, metres. */
  width: number;
  rowSpacing: number;
  segmentLength: number;
  kind: 'ridge' | 'stalk' | 'bush';
  label: string;
  swatch: string;
}

export const CROP_LOOK: Record<CropId, CropLook> = {
  rice: {
    stops: [
      [0, new Color('#9bd05a')],
      [0.5, new Color('#4f9a2c')],
      [0.78, new Color('#8fae3a')],
      [1, new Color('#d9b648')],
    ],
    maxHeight: 1.0,
    width: 1.5,
    rowSpacing: 2.2,
    segmentLength: 6,
    kind: 'ridge',
    label: CROP_META.rice.label,
    swatch: CROP_META.rice.swatch,
  },
  ragi: {
    stops: [
      [0, new Color('#8cc457')],
      [0.6, new Color('#5c8f34')],
      [1, new Color('#9a5a34')],
    ],
    maxHeight: 0.9,
    width: 1.3,
    rowSpacing: 2.4,
    segmentLength: 6,
    kind: 'ridge',
    label: CROP_META.ragi.label,
    swatch: CROP_META.ragi.swatch,
  },
  maize: {
    stops: [
      [0, new Color('#8fcf5c')],
      [0.55, new Color('#3f8a2e')],
      [0.85, new Color('#9aa045')],
      [1, new Color('#d2b673')],
    ],
    maxHeight: 2.4,
    width: 1.1,
    rowSpacing: 3,
    segmentLength: 6,
    kind: 'stalk',
    label: CROP_META.maize.label,
    swatch: CROP_META.maize.swatch,
  },
  sugarcane: {
    stops: [
      [0, new Color('#7fc95a')],
      [0.5, new Color('#3d8f3a')],
      [1, new Color('#86a447')],
    ],
    maxHeight: 3.6,
    width: 1.6,
    rowSpacing: 3.4,
    segmentLength: 7,
    kind: 'stalk',
    label: CROP_META.sugarcane.label,
    swatch: CROP_META.sugarcane.swatch,
  },
  tomato: {
    stops: [
      [0, new Color('#7cbf55')],
      [0.6, new Color('#2f6f2a')],
      [1, new Color('#3c6a2a')],
    ],
    maxHeight: 0.85,
    width: 1.2,
    rowSpacing: 3,
    segmentLength: 5,
    kind: 'bush',
    label: CROP_META.tomato.label,
    swatch: CROP_META.tomato.swatch,
  },
  chickpea: {
    stops: [
      [0, new Color('#a5c86a')],
      [0.6, new Color('#7a9a55')],
      [1, new Color('#c2a565')],
    ],
    maxHeight: 0.55,
    width: 1.1,
    rowSpacing: 2.2,
    segmentLength: 5,
    kind: 'bush',
    label: CROP_META.chickpea.label,
    swatch: CROP_META.chickpea.swatch,
  },
};

export const CROP_FAILED = new Color('#6e5c3e');
export const CROP_STRESSED = new Color('#9a8648');
export const PADDY_WATER = new Color('#5f7f72');
export const TOMATO_FRUIT = new Color('#d8432f');

const tmp = new Color();

/** Colour at growth progress `p` from keyframes. */
export function sampleStops(stops: [number, Color][], p: number, out: Color = new Color()): Color {
  if (p <= stops[0]![0]) return out.copy(stops[0]![1]);
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i]!;
    if (p <= t1) {
      const [t0, c0] = stops[i - 1]!;
      return out.copy(c0).lerp(c1, (p - t0) / (t1 - t0 || 1));
    }
  }
  return out.copy(stops[stops.length - 1]![1]);
}

/** Canopy colour for a crop given progress, health (0..1) and status. */
export function cropCanopyColor(
  cropId: CropId,
  progress: number,
  health: number,
  status: 'growing' | 'ready' | 'failed',
  out: Color = new Color(),
): Color {
  if (status === 'failed') return out.copy(CROP_FAILED);
  sampleStops(CROP_LOOK[cropId].stops, status === 'ready' ? 1 : progress, out);
  const stress = Math.max(0, Math.min(1, 1 - health));
  if (stress > 0.05) out.lerp(tmp.copy(CROP_STRESSED), stress * 0.7);
  return out;
}

/** Health values arrive as 0..1 (domain) — tolerate 0..100 defensively. */
export function unitHealth(v: number): number {
  const n = v > 1.0001 ? v / 100 : v;
  return Math.max(0, Math.min(1, n));
}
