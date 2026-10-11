import { BufferAttribute, BufferGeometry, Color } from 'three';
import { distanceToPolyline, type Pt } from '../../lib/geometry';
import { hashString } from '../../lib/random';
import { TERRAIN } from '../palette';
import type { TerrainSampler } from '../terrain';

/** Smooth 2D value noise in [0,1] (cosmetic only). */
export function valueNoise2(seed: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const h = (a: number, b: number) => {
    let v = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ seed;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h(ix, iy);
  const b = h(ix + 1, iy);
  const c = h(ix, iy + 1);
  const d = h(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * Terrain grid mesh + diorama skirt (the region reads as a crafted model slab).
 * Triangulation matches `TerrainSampler.heightAt`.
 */
export function buildTerrainGeometry(
  sampler: TerrainSampler,
  river: { points: Pt[]; widthM: number } | null,
): BufferGeometry {
  const n = sampler.segments;
  const n1 = n + 1;
  const half = sampler.halfSize;
  const cell = sampler.cell;
  const skirtBottom = sampler.minY - 28;
  const gridVerts = n1 * n1;
  const skirtVerts = 4 * n1 * 2;
  const positions = new Float32Array((gridVerts + skirtVerts) * 3);
  const colors = new Float32Array((gridVerts + skirtVerts) * 3);
  const seed = hashString(`terrain-${sampler.seed}`);
  const span = Math.max(1, sampler.maxY - sampler.minY);
  const c = new Color();
  const tmp = new Color();
  const riverPts = river?.points ?? [];
  const riverHalf = (river?.widthM ?? 0) / 2;

  for (let iy = 0; iy < n1; iy++) {
    const y = -half + iy * cell;
    for (let ix = 0; ix < n1; ix++) {
      const x = -half + ix * cell;
      const i = iy * n1 + ix;
      const h = sampler.heights[i]!;
      positions[i * 3] = x;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = y;

      const t = (h - sampler.minY) / span;
      c.copy(TERRAIN.valley).lerp(TERRAIN.meadow, Math.min(1, t * 1.6));
      if (t > 0.55) c.lerp(TERRAIN.upland, Math.min(1, (t - 0.55) * 2.2));
      const slope = sampler.slopeAt(x, y);
      if (slope > 0.06) c.lerp(TERRAIN.hill, Math.min(0.75, (slope - 0.06) * 6));
      const lat =
        valueNoise2(seed, x / 380, y / 380) * 0.65 +
        valueNoise2(seed ^ 0x9e37, x / 140, y / 140) * 0.35;
      if (lat > 0.58) c.lerp(TERRAIN.laterite, Math.min(0.55, (lat - 0.58) * 2.6));
      const speck = valueNoise2(seed ^ 0x51ed, x / 45, y / 45);
      c.multiplyScalar(0.94 + speck * 0.12);
      if (riverPts.length > 1) {
        const d = distanceToPolyline({ x, y }, riverPts);
        if (d < riverHalf + 40) {
          const k = 1 - Math.max(0, (d - riverHalf) / 40);
          c.lerp(tmp.copy(d < riverHalf + 12 ? TERRAIN.sand : TERRAIN.bank), Math.min(0.85, k));
        }
      }
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
  }

  const index: number[] = [];
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const a = iy * n1 + ix;
      const b = (iy + 1) * n1 + ix;
      const cc = (iy + 1) * n1 + ix + 1;
      const d = iy * n1 + ix + 1;
      index.push(a, b, d, b, cc, d);
    }
  }

  // Skirt: four vertical walls from the terrain edge down to a flat base.
  let v = gridVerts;
  const edges: { idx: (k: number) => number; outward: 'n' | 's' | 'e' | 'w' }[] = [
    { idx: (k) => k, outward: 'n' }, // iy = 0 (north edge, y = -half)
    { idx: (k) => n * n1 + k, outward: 's' },
    { idx: (k) => k * n1, outward: 'w' },
    { idx: (k) => k * n1 + n, outward: 'e' },
  ];
  for (const edge of edges) {
    const start = v;
    for (let k = 0; k < n1; k++) {
      const gi = edge.idx(k);
      const px = positions[gi * 3]!;
      const py = positions[gi * 3 + 1]!;
      const pz = positions[gi * 3 + 2]!;
      positions.set([px, py, pz], v * 3);
      colors.set([TERRAIN.skirtTop.r, TERRAIN.skirtTop.g, TERRAIN.skirtTop.b], v * 3);
      positions.set([px, skirtBottom, pz], (v + 1) * 3);
      colors.set(
        [TERRAIN.skirtBottom.r, TERRAIN.skirtBottom.g, TERRAIN.skirtBottom.b],
        (v + 1) * 3,
      );
      v += 2;
    }
    for (let k = 0; k < n; k++) {
      const top0 = start + k * 2;
      const bot0 = top0 + 1;
      const top1 = top0 + 2;
      const bot1 = top0 + 3;
      // Wind so the face points outward.
      if (edge.outward === 'n' || edge.outward === 'e')
        index.push(top0, top1, bot0, top1, bot1, bot0);
      else index.push(top0, bot0, top1, top1, bot0, bot1);
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setAttribute('color', new BufferAttribute(colors, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
