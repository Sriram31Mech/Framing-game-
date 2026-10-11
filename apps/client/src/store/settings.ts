/**
 * Player preferences (persisted locally): graphics quality and debug overlays.
 */
import { create } from 'zustand';

export type GraphicsQuality = 'low' | 'medium' | 'high';

export interface QualityProfile {
  shadows: boolean;
  shadowMapSize: number;
  maxPixelRatio: number;
  antialias: boolean;
  /** Multiplier on crop row spacing (higher = fewer instances). */
  cropSpacingScale: number;
  /** Max crop row instances per crop type. */
  maxCropInstances: number;
  /** Fraction of decorative trees to keep. */
  treeDensity: number;
  /** Continuous rendering for water/vehicle animation; 'demand' otherwise. */
  animate: boolean;
  environmentLighting: boolean;
}

export const QUALITY_PROFILES: Record<GraphicsQuality, QualityProfile> = {
  low: {
    shadows: false,
    shadowMapSize: 0,
    maxPixelRatio: 1,
    antialias: false,
    cropSpacingScale: 2,
    maxCropInstances: 8_000,
    treeDensity: 0.45,
    animate: false,
    environmentLighting: false,
  },
  medium: {
    shadows: true,
    shadowMapSize: 1024,
    maxPixelRatio: 1.5,
    antialias: true,
    cropSpacingScale: 1.4,
    maxCropInstances: 20_000,
    treeDensity: 0.75,
    animate: true,
    environmentLighting: true,
  },
  high: {
    shadows: true,
    shadowMapSize: 2048,
    maxPixelRatio: 2,
    antialias: true,
    cropSpacingScale: 1,
    maxCropInstances: 45_000,
    treeDensity: 1,
    animate: true,
    environmentLighting: true,
  },
};

const STORAGE_KEY = 'bh.settings.v1';

interface Persisted {
  quality: GraphicsQuality;
  showPerf: boolean;
}

interface SettingsState extends Persisted {
  setQuality: (q: GraphicsQuality) => void;
  setShowPerf: (v: boolean) => void;
}

function load(): Persisted {
  const fallback: Persisted = { quality: 'medium', showPerf: false };
  try {
    const raw = (typeof window === 'undefined' ? undefined : window.localStorage)?.getItem(
      STORAGE_KEY,
    );
    if (!raw) return fallback;
    const v = JSON.parse(raw) as Partial<Persisted>;
    return {
      quality:
        v.quality === 'low' || v.quality === 'medium' || v.quality === 'high'
          ? v.quality
          : fallback.quality,
      showPerf: typeof v.showPerf === 'boolean' ? v.showPerf : false,
    };
  } catch {
    return fallback;
  }
}

function save(p: Persisted): void {
  try {
    (typeof window === 'undefined' ? undefined : window.localStorage)?.setItem(
      STORAGE_KEY,
      JSON.stringify(p),
    );
  } catch {
    // ignore
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...load(),
  setQuality: (quality) => {
    set({ quality });
    save({ quality, showPerf: get().showPerf });
  },
  setShowPerf: (showPerf) => {
    set({ showPerf });
    save({ quality: get().quality, showPerf });
  },
}));

export function useQualityProfile(): QualityProfile {
  return QUALITY_PROFILES[useSettingsStore((s) => s.quality)];
}
