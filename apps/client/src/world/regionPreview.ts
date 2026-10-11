/**
 * Landing-screen backdrop: the region is generated client-side from the shared deterministic
 * domain generator (no auth needed), with decorative crops so the valley looks lived-in.
 * Purely cosmetic — never used for gameplay decisions.
 */
import type { RegionMapResponse } from '@bh/contracts';
import { CROP_IDS, DEFAULT_REGION_ID, DEFAULT_REGION_SEED, generateRegion } from '@bh/domain';
import { rngFrom } from '../lib/random';

export function previewRegionMap(): RegionMapResponse | null {
  try {
    const region = generateRegion(DEFAULT_REGION_SEED, DEFAULT_REGION_ID);
    const rand = rngFrom('landing', region.seed);
    return {
      region: { id: region.id, name: region.name, seed: region.seed, halfSizeM: region.halfSizeM },
      parcels: region.parcels.map((p, i) => {
        const planted = rand() < 0.62;
        const cropId = CROP_IDS[Math.floor(rand() * CROP_IDS.length)]!;
        const progress = rand();
        const owned = rand() < 0.45;
        return {
          id: p.id,
          polygon: p.polygon,
          centroid: p.centroid,
          areaHa: p.env.areaHa,
          status: p.isStarterPlot ? 'reserved' : owned ? 'owned' : 'for_sale',
          ownerCompanyId: null,
          ownerName: null,
          operatorCompanyId: null,
          listPricePaise: owned ? null : p.basePricePaise,
          isStarterPlot: p.isStarterPlot,
          soilTexture: p.env.soilTexture,
          waterAccess: p.env.waterAccess,
          elevationM: p.env.elevationM,
          version: 1 + (i % 3),
          crop: planted
            ? { cropId, status: progress > 0.95 ? 'ready' : 'growing', progress, health: 0.9 }
            : null,
        };
      }),
      roads: region.roads,
      river: region.river,
      features: region.features,
      markets: region.markets,
    };
  } catch {
    // Domain generator unavailable — the landing falls back to a painted backdrop.
    return null;
  }
}
