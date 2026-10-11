/**
 * Static world layout derived from the region map (terrain, roads, river, parcel meshes,
 * architecture, vegetation). Rebuilt only when the map *geometry* changes — ownership and crop
 * updates are applied on top without touching geometry.
 */
import type { RegionMapResponse } from '@bh/contracts';
import type { BufferGeometry } from 'three';
import { densify, type Pt } from '../lib/geometry';
import { hashString } from '../lib/random';
import { buildRiver, buildRoads } from './builders/linearGeometry';
import {
  buildBunds,
  buildParcelFill,
  buildPickMesh,
  type BundMesh,
  type ParcelFill,
  type PickMesh,
} from './builders/parcelGeometry';
import { buildScenery, type Scenery } from './builders/scenery';
import { buildTerrainGeometry } from './builders/terrainGeometry';
import { TerrainSampler } from './terrain';

export interface WorldLayout {
  key: string;
  seed: number;
  halfSize: number;
  sampler: TerrainSampler;
  terrain: BufferGeometry;
  roads: BufferGeometry;
  river: { geometry: BufferGeometry; points: Pt[]; widthM: number } | null;
  parcelIds: string[];
  parcelIndex: Map<string, number>;
  fill: ParcelFill;
  bunds: BundMesh;
  pick: PickMesh;
  roadPaths: { kind: string; points: Pt[]; widthM: number }[];
  buildMs: number;
}

/** Stable key for the static part of the map (region + parcel ids + road count). */
export function layoutKey(map: RegionMapResponse): string {
  const ids = map.parcels.map((p) => p.id).join(',');
  return `${map.region.id}:${map.region.seed}:${map.region.halfSizeM}:${map.roads.length}:${hashString(ids)}`;
}

export function buildWorldLayout(map: RegionMapResponse, terrainSegments = 200): WorldLayout {
  const t0 = performance.now();
  const { seed, halfSizeM } = map.region;
  const sampler = new TerrainSampler(seed, halfSizeM, terrainSegments);
  let river: WorldLayout['river'] = null;
  let riverLevels: number[] | null = null;
  let riverPts: Pt[] = [];
  if (map.river.points.length > 1) {
    riverPts = densify(map.river.points, 20, false);
    riverLevels = sampler.carveRiver(riverPts, map.river.widthM);
  }
  const terrain = buildTerrainGeometry(
    sampler,
    riverPts.length > 1 ? { points: riverPts, widthM: map.river.widthM } : null,
  );
  if (riverLevels) {
    river = {
      geometry: buildRiver({ points: riverPts, widthM: map.river.widthM }, riverLevels),
      points: riverPts,
      widthM: map.river.widthM,
    };
  }
  const roadPaths = map.roads.map((r) => ({ kind: r.kind, points: r.points, widthM: r.widthM }));
  const roads = buildRoads(
    map.roads,
    sampler,
    river ? { points: riverPts, widthM: map.river.widthM } : null,
    riverLevels,
  );
  const shapes = map.parcels.map((p) => ({ id: p.id, polygon: p.polygon }));
  const fill = buildParcelFill(shapes, sampler);
  const bunds = buildBunds(shapes, sampler);
  const pick = buildPickMesh(shapes, sampler);
  const parcelIds = map.parcels.map((p) => p.id);
  return {
    key: layoutKey(map),
    seed,
    halfSize: halfSizeM,
    sampler,
    terrain,
    roads,
    river,
    parcelIds,
    parcelIndex: new Map(parcelIds.map((id, i) => [id, i])),
    fill,
    bunds,
    pick,
    roadPaths,
    buildMs: performance.now() - t0,
  };
}

export function buildWorldScenery(
  map: RegionMapResponse,
  layout: WorldLayout,
  density: number,
): Scenery {
  return buildScenery(
    {
      seed: layout.seed,
      halfSize: layout.halfSize,
      parcels: map.parcels.map((p) => p.polygon),
      roads: layout.roadPaths,
      river: layout.river ? { points: layout.river.points, widthM: layout.river.widthM } : null,
      features: map.features,
      markets: map.markets,
      sampler: layout.sampler,
    },
    density,
  );
}

export function disposeLayout(layout: WorldLayout): void {
  layout.terrain.dispose();
  layout.roads.dispose();
  layout.river?.geometry.dispose();
  layout.fill.geometry.dispose();
  layout.bunds.geometry.dispose();
  layout.pick.geometry.dispose();
}
