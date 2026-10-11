/**
 * Ribbon meshes along polylines: roads (with kerbs, centre markings and bridge decks) and the river.
 */
import { BufferAttribute, BufferGeometry, Color } from 'three';
import { densify, distanceToPolyline, polylineCumulative, type Pt } from '../../lib/geometry';
import { ROAD } from '../palette';
import type { TerrainSampler } from '../terrain';

class RibbonAccumulator {
  pos: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  index: number[] = [];

  /**
   * Adds a strip between lateral offsets `offA` → `offB` (metres, + = left of travel direction).
   * `height(i, x, y)` gives the surface height for vertex i; `color(i)` its colour.
   */
  strip(
    pts: Pt[],
    offA: number,
    offB: number,
    height: (i: number, x: number, y: number) => number,
    color: (i: number) => Color,
    include: (i: number) => boolean = () => true,
  ): void {
    const m = pts.length;
    if (m < 2) return;
    const cum = polylineCumulative(pts);
    let prevBase = -1;
    for (let i = 0; i < m; i++) {
      const a = pts[Math.max(0, i - 1)]!;
      const b = pts[Math.min(m - 1, i + 1)]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l;
      const ny = dx / l;
      if (!include(i)) {
        prevBase = -1;
        continue;
      }
      const base = this.pos.length / 3;
      const c = color(i);
      for (const off of [offA, offB]) {
        const x = pts[i]!.x + nx * off;
        const y = pts[i]!.y + ny * off;
        this.pos.push(x, height(i, x, y), y);
        this.col.push(c.r, c.g, c.b);
        this.uv.push(off, cum[i]!);
      }
      if (prevBase >= 0) {
        // Vertices: prevBase(A), prevBase+1(B), base(A'), base+1(B'). Offsets increase to the left,
        // so (A, A', B) winds counter-clockwise seen from above when offA < offB.
        this.index.push(prevBase, prevBase + 1, base, base, prevBase + 1, base + 1);
      }
      prevBase = base;
    }
  }

  toGeometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setIndex(this.index);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

export interface RoadInput {
  id: string;
  kind: 'highway' | 'district' | 'village' | 'farm_track';
  points: Pt[];
  widthM: number;
}

export interface RiverInput {
  points: Pt[];
  widthM: number;
}

/** Ensures upward-facing triangles regardless of polyline direction conventions. */
function fixWinding(g: BufferGeometry): void {
  const idx = g.getIndex();
  const pos = g.getAttribute('position');
  if (!idx || idx.count < 3) return;
  const arr = idx.array as Uint16Array | Uint32Array;
  for (let t = 0; t < arr.length; t += 3) {
    const a = arr[t]!;
    const b = arr[t + 1]!;
    const c = arr[t + 2]!;
    const abx = pos.getX(b) - pos.getX(a);
    const abz = pos.getZ(b) - pos.getZ(a);
    const acx = pos.getX(c) - pos.getX(a);
    const acz = pos.getZ(c) - pos.getZ(a);
    // y component of (b-a) × (c-a)
    const ny = abz * acx - abx * acz;
    if (ny < 0) {
      arr[t + 1] = c;
      arr[t + 2] = b;
    }
  }
  idx.needsUpdate = true;
  g.computeVertexNormals();
}

export function buildRoads(
  roads: readonly RoadInput[],
  sampler: TerrainSampler,
  river: RiverInput | null,
  riverLevels: number[] | null,
): BufferGeometry {
  const acc = new RibbonAccumulator();
  const riverPts = river?.points ?? [];
  const riverReach = (river?.widthM ?? 0) / 2 + 26;
  const sorted = [...roads].sort((a, b) => order(a.kind) - order(b.kind));
  for (const road of sorted) {
    const pts = densify(road.points, 8, false);
    const hw = road.widthM / 2;
    const paved = road.kind === 'highway' || road.kind === 'district';
    const lift = road.kind === 'highway' ? 0.45 : road.kind === 'district' ? 0.4 : 0.32;
    // Bridge deck over the river: flat at water + clearance.
    const deck = pts.map((p) => {
      if (riverPts.length < 2 || !riverLevels) return null;
      const d = distanceToPolyline(p, riverPts);
      if (d > riverReach) return null;
      let best = 0;
      let bestD = Infinity;
      riverPts.forEach((rp, i) => {
        const dd = Math.hypot(rp.x - p.x, rp.y - p.y);
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      });
      return riverLevels[best]! + 3.2;
    });
    const h = (i: number, x: number, y: number) => {
      const ground = sampler.heightAt(x, y) + lift;
      const dk = deck[i];
      return dk != null ? Math.max(ground, dk) : ground;
    };
    const base = paved
      ? road.kind === 'highway'
        ? ROAD.asphalt
        : ROAD.asphaltLight
      : road.kind === 'village'
        ? ROAD.dirt
        : ROAD.track;
    if (paved) {
      const kerb = Math.min(0.9, hw * 0.18);
      acc.strip(
        pts,
        -hw,
        -hw + kerb,
        (i, x, y) => h(i, x, y) + 0.05,
        () => ROAD.kerb,
      );
      acc.strip(pts, -hw + kerb, hw - kerb, h, () => base);
      acc.strip(
        pts,
        hw - kerb,
        hw,
        (i, x, y) => h(i, x, y) + 0.05,
        () => ROAD.kerb,
      );
      if (road.kind === 'highway') {
        // Dashed centre line.
        acc.strip(
          pts,
          -0.18,
          0.18,
          (i, x, y) => h(i, x, y) + 0.04,
          () => ROAD.marking,
          (i) => Math.floor(i / 1.5) % 2 === 0,
        );
      }
    } else {
      acc.strip(pts, -hw, hw, h, () => base);
    }
    // Bridge parapets.
    if (deck.some((d) => d != null)) {
      const isDeck = (i: number) => deck[i] != null;
      acc.strip(
        pts,
        hw - 0.1,
        hw + 0.35,
        (i, x, y) => h(i, x, y) + 1.1,
        () => ROAD.kerb,
        isDeck,
      );
      acc.strip(
        pts,
        -hw - 0.35,
        -hw + 0.1,
        (i, x, y) => h(i, x, y) + 1.1,
        () => ROAD.kerb,
        isDeck,
      );
    }
  }
  const g = acc.toGeometry();
  fixWinding(g);
  return g;
}

function order(kind: RoadInput['kind']): number {
  return kind === 'farm_track' ? 0 : kind === 'village' ? 1 : kind === 'district' ? 2 : 3;
}

/** River surface ribbon; uv.x = across (m), uv.y = along (m) for the animated water shader. */
export function buildRiver(river: RiverInput, levels: number[], extraWidth = 10): BufferGeometry {
  const acc = new RibbonAccumulator();
  const hw = river.widthM / 2 + extraWidth / 2;
  const white = new Color(1, 1, 1);
  acc.strip(
    river.points,
    -hw,
    hw,
    (i) => levels[i]!,
    () => white,
  );
  const g = acc.toGeometry();
  fixWinding(g);
  return g;
}
