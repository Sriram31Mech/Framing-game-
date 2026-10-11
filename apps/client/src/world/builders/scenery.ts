/**
 * Places architecture and vegetation around the map features deterministically, avoiding
 * parcels, roads, the river and each other. Architecture is merged into one geometry; trees are
 * returned as instance placements per species.
 */
import type { BufferGeometry } from 'three';
import { distanceToSegment, PolygonIndex, type Pt } from '../../lib/geometry';
import { hashString, mulberry32 } from '../../lib/random';
import type { TerrainSampler } from '../terrain';
import { MeshBuilder } from './meshBuilder';
import {
  house,
  grainSilo,
  mandi,
  processingShed,
  school,
  temple,
  warehouse,
  waterTank,
} from './props';

export interface FeatureInput {
  id: string;
  kind: 'village' | 'warehouse' | 'temple' | 'water_tank' | 'tree_cluster' | 'school';
  x: number;
  y: number;
  rotation: number;
  scale: number;
}

export interface SceneryInput {
  seed: number;
  halfSize: number;
  parcels: Pt[][];
  roads: { kind: string; points: Pt[]; widthM: number }[];
  river: { points: Pt[]; widthM: number } | null;
  features: FeatureInput[];
  markets: { id: string; x: number; y: number; demandScale: number }[];
  sampler: TerrainSampler;
}

export interface Placement {
  x: number;
  y: number;
  z: number;
  ry: number;
  s: number;
  /** 0..1 tint variation. */
  tint: number;
}

export interface Scenery {
  architecture: BufferGeometry;
  architectureTriangles: number;
  broadleaf: Placement[];
  coconut: Placement[];
  areca: Placement[];
  banana: Placement[];
}

/** Segment buckets for fast "near a road / river" checks. */
class SegmentIndex {
  private cells = new Map<number, { a: Pt; b: Pt; pad: number }[]>();
  constructor(private cell = 80) {}
  private key(cx: number, cy: number) {
    return (cx + 4096) * 8192 + (cy + 4096);
  }
  add(points: Pt[], pad: number) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const minX = Math.floor((Math.min(a.x, b.x) - pad) / this.cell);
      const maxX = Math.floor((Math.max(a.x, b.x) + pad) / this.cell);
      const minY = Math.floor((Math.min(a.y, b.y) - pad) / this.cell);
      const maxY = Math.floor((Math.max(a.y, b.y) + pad) / this.cell);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cy = minY; cy <= maxY; cy++) {
          const k = this.key(cx, cy);
          const list = this.cells.get(k);
          const seg = { a, b, pad };
          if (list) list.push(seg);
          else this.cells.set(k, [seg]);
        }
      }
    }
  }
  hits(p: Pt, extra = 0): boolean {
    const list = this.cells.get(this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell)));
    if (!list) return false;
    return list.some((s) => distanceToSegment(p, s.a, s.b) < s.pad + extra);
  }
}

export function buildScenery(input: SceneryInput, density: number): Scenery {
  const { sampler, halfSize } = input;
  const rand = mulberry32(hashString(`scenery-${input.seed}`));
  const parcelIdx = new PolygonIndex(input.parcels, 120);
  const linear = new SegmentIndex();
  for (const r of input.roads) linear.add(r.points, r.widthM / 2 + 2.5);
  const riverIdx = new SegmentIndex();
  if (input.river) riverIdx.add(input.river.points, input.river.widthM / 2 + 4);
  const occupied: { x: number; y: number; r: number }[] = [];

  const inBounds = (p: Pt, m = 12) => Math.abs(p.x) < halfSize - m && Math.abs(p.y) < halfSize - m;
  const blockedBy = (p: Pt, r: number) =>
    occupied.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < o.r + r);
  const free = (p: Pt, r: number) =>
    inBounds(p) &&
    parcelIdx.find(p, r) < 0 &&
    !linear.hits(p, r) &&
    !riverIdx.hits(p, r) &&
    !blockedBy(p, r);
  const groundMin = (p: Pt, r: number) =>
    Math.min(
      sampler.heightAt(p.x, p.y),
      sampler.heightAt(p.x + r, p.y),
      sampler.heightAt(p.x - r, p.y),
      sampler.heightAt(p.x, p.y + r),
      sampler.heightAt(p.x, p.y - r),
    );

  const b = new MeshBuilder();
  const place = (p: Pt, rotation: number, r: number, draw: () => void) => {
    const y = groundMin(p, r * 0.7);
    b.with({ x: p.x, y, z: p.y, ry: -rotation }, draw);
    occupied.push({ x: p.x, y: p.y, r });
  };

  const broadleaf: Placement[] = [];
  const coconut: Placement[] = [];
  const areca: Placement[] = [];
  const banana: Placement[] = [];
  const addTree = (list: Placement[], p: Pt, s: number, r = 2.5) => {
    if (!free(p, r)) return false;
    list.push({
      x: p.x,
      y: sampler.heightAt(p.x, p.y),
      z: p.y,
      ry: rand() * Math.PI * 2,
      s,
      tint: rand(),
    });
    occupied.push({ x: p.x, y: p.y, r: r * 0.6 });
    return true;
  };

  // Markets first (largest footprints).
  for (const m of input.markets) {
    const s = m.demandScale > 1.05 ? 1.25 : 1;
    place({ x: m.x, y: m.y }, 0, 42 * s, () => mandi(b, s));
    // Processing shed offset from the main market.
    const shedP = { x: m.x + 80 * s, y: m.y };
    if (free(shedP, 26)) place(shedP, 0, 26, () => processingShed(b));
  }
  for (const f of input.features) {
    const p = { x: f.x, y: f.y };
    switch (f.kind) {
      case 'temple':
        place(p, f.rotation, 22, () => temple(b));
        break;
      case 'school':
        place(p, f.rotation, 22, () => school(b));
        break;
      case 'water_tank':
        place(p, f.rotation, 7, () => waterTank(b));
        break;
      case 'warehouse':
        place(p, f.rotation, 24 * Math.max(0.8, f.scale), () =>
          warehouse(b, Math.max(0.8, Math.min(1.5, f.scale))),
        );
        // Add a grain silo cluster beside each warehouse.
        {
          const siloOffset = 32 * Math.max(0.8, f.scale);
          const sp = {
            x: f.x + Math.cos(f.rotation + Math.PI / 2) * siloOffset,
            y: f.y + Math.sin(f.rotation + Math.PI / 2) * siloOffset,
          };
          if (free(sp, 16)) place(sp, f.rotation, 16, () => grainSilo(b));
        }
        break;
      default:
        break;
    }
  }
  // Villages: clustered houses facing the lane/centre, with backyard palms and bananas.
  for (const f of input.features.filter((x) => x.kind === 'village')) {
    const count = Math.max(5, Math.min(20, Math.round(10 * f.scale)));
    const spread = 55 * Math.sqrt(Math.max(0.5, f.scale)) + 25;
    let placed = 0;
    for (let tries = 0; tries < count * 8 && placed < count; tries++) {
      const a = rand() * Math.PI * 2;
      const rr = 14 + Math.sqrt(rand()) * spread;
      const p = { x: f.x + Math.cos(a) * rr, y: f.y + Math.sin(a) * rr };
      if (!free(p, 7)) continue;
      const facing = Math.atan2(f.y - p.y, f.x - p.x);
      // Snap orientation to the village grid with a little irregularity.
      const grid = f.rotation + Math.round((facing - f.rotation) / (Math.PI / 2)) * (Math.PI / 2);
      const rot = grid + (rand() - 0.5) * 0.2 - Math.PI / 2;
      const hr = mulberry32(hashString(`${f.id}-${placed}`));
      place(p, rot, 7.5, () => house(b, hr));
      placed++;
      for (let k = 0; k < 2; k++) {
        const ta = rand() * Math.PI * 2;
        const tp = {
          x: p.x + Math.cos(ta) * (10 + rand() * 6),
          y: p.y + Math.sin(ta) * (10 + rand() * 6),
        };
        if (rand() < density)
          addTree(
            rand() < 0.5 ? coconut : rand() < 0.5 ? areca : banana,
            tp,
            0.85 + rand() * 0.3,
            2,
          );
      }
    }
  }

  // Tree clusters (groves).
  for (const f of input.features.filter((x) => x.kind === 'tree_cluster')) {
    const count = Math.round(Math.max(6, Math.min(40, 16 * f.scale)) * density);
    const radius = 30 + 35 * f.scale;
    for (let i = 0, tries = 0; i < count && tries < count * 5; tries++) {
      const a = rand() * Math.PI * 2;
      const rr = Math.sqrt(rand()) * radius;
      const p = { x: f.x + Math.cos(a) * rr, y: f.y + Math.sin(a) * rr };
      const nearWater = riverIdx.hits(p, 160);
      const roll = rand();
      const list = nearWater
        ? roll < 0.55
          ? coconut
          : roll < 0.75
            ? areca
            : broadleaf
        : roll < 0.7
          ? broadleaf
          : roll < 0.85
            ? areca
            : coconut;
      if (addTree(list, p, 0.8 + rand() * 0.45, 3)) i++;
    }
  }

  // River banks: coconut palms and mango trees.
  if (input.river) {
    const pts = input.river.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const c = pts[i + 1]!;
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      const nx = -(c.y - a.y) / (len || 1);
      const ny = (c.x - a.x) / (len || 1);
      for (let t = 0; t < len; t += 26) {
        for (const side of [-1, 1]) {
          if (rand() > 0.6 * density) continue;
          const off = input.river.widthM / 2 + 9 + rand() * 30;
          const k = t / len;
          const p = {
            x: a.x + (c.x - a.x) * k + nx * off * side,
            y: a.y + (c.y - a.y) * k + ny * off * side,
          };
          addTree(rand() < 0.62 ? coconut : broadleaf, p, 0.85 + rand() * 0.3, 2.5);
        }
      }
    }
  }

  // Avenue trees along paved roads.
  for (const r of input.roads) {
    if (r.kind !== 'highway' && r.kind !== 'district') continue;
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i]!;
      const c = r.points[i + 1]!;
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      const nx = -(c.y - a.y) / (len || 1);
      const ny = (c.x - a.x) / (len || 1);
      for (let t = 10; t < len; t += 30) {
        for (const side of [-1, 1]) {
          if (rand() > 0.5 * density) continue;
          const off = r.widthM / 2 + 5.5;
          const k = t / len;
          addTree(
            broadleaf,
            {
              x: a.x + (c.x - a.x) * k + nx * off * side,
              y: a.y + (c.y - a.y) * k + ny * off * side,
            },
            0.9 + rand() * 0.3,
            2,
          );
        }
      }
    }
  }

  // Scattered trees on unfarmed land; hills get more broadleaf cover.
  const scatter = Math.round(((halfSize * 2) ** 2 / 9000) * density);
  for (let i = 0; i < scatter; i++) {
    const p = { x: (rand() * 2 - 1) * halfSize, y: (rand() * 2 - 1) * halfSize };
    const hT =
      (sampler.heightAt(p.x, p.y) - sampler.minY) / Math.max(1, sampler.maxY - sampler.minY);
    const roll = rand();
    if (hT > 0.6) addTree(broadleaf, p, 0.8 + rand() * 0.5, 3);
    else addTree(roll < 0.6 ? broadleaf : roll < 0.8 ? coconut : areca, p, 0.75 + rand() * 0.4, 3);
  }

  return {
    architecture: b.toGeometry(),
    architectureTriangles: b.triangleCount,
    broadleaf,
    coconut,
    areca,
    banana,
  };
}
