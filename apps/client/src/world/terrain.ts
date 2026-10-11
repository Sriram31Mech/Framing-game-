/**
 * Rendered terrain height field.
 *
 * The domain `terrainHeightM(seed, x, y)` is sampled once on a regular grid; everything placed
 * on the ground (parcels, roads, crops, buildings) then uses `heightAt`, which interpolates
 * exactly the same triangles the GPU draws — so nothing floats or sinks between grid vertices.
 *
 * Map frame: x east, y south (metres). three.js frame: x → x, y(map) → z, height → y.
 */
import { terrainHeightM } from '@bh/domain';

/** Vertical exaggeration for the miniature-world look (relief is only ~80 m over 4 km). */
export const VERTICAL_EXAGGERATION = 1.6;

export class TerrainSampler {
  /** Rendered heights (already offset and exaggerated), row-major (iy * (n+1) + ix). */
  readonly heights: Float32Array;
  readonly segments: number;
  readonly halfSize: number;
  readonly cell: number;
  /** Lowest real elevation on the grid (maps to rendered y = 0). */
  readonly baseM: number;
  minY: number;
  readonly maxY: number;

  constructor(
    readonly seed: number,
    halfSize: number,
    segments: number,
    heightFn: (seed: number, x: number, y: number) => number = terrainHeightM,
  ) {
    this.halfSize = halfSize;
    this.segments = segments;
    this.cell = (halfSize * 2) / segments;
    const n1 = segments + 1;
    const raw = new Float64Array(n1 * n1);
    let min = Infinity;
    for (let iy = 0; iy < n1; iy++) {
      const y = -halfSize + iy * this.cell;
      for (let ix = 0; ix < n1; ix++) {
        const h = heightFn(seed, -halfSize + ix * this.cell, y);
        raw[iy * n1 + ix] = h;
        if (h < min) min = h;
      }
    }
    this.baseM = Number.isFinite(min) ? min : 0;
    this.heights = new Float32Array(n1 * n1);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < raw.length; i++) {
      const v = (raw[i]! - this.baseM) * VERTICAL_EXAGGERATION;
      this.heights[i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    this.minY = lo;
    this.maxY = hi;
  }

  /**
   * Carve the river channel into the rendered grid so water is always visible at this mesh
   * resolution. Returns the rendered water level for each river point.
   */
  carveRiver(points: readonly { x: number; y: number }[], widthM: number): number[] {
    const levels = points.map((p) => this.heightAt(p.x, p.y) + 0.2);
    // Smooth the water level along the river (it should never step up/down abruptly).
    const smoothed = levels.map((_, i) => {
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, i - 3); k <= Math.min(levels.length - 1, i + 3); k++) {
        sum += levels[k]!;
        count++;
      }
      return sum / count;
    });
    const n1 = this.segments + 1;
    const reach = widthM / 2 + this.cell * 0.75;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const minX = Math.min(a.x, b.x) - reach;
      const maxX = Math.max(a.x, b.x) + reach;
      const minY = Math.min(a.y, b.y) - reach;
      const maxY = Math.max(a.y, b.y) + reach;
      const ix0 = Math.max(0, Math.floor((minX + this.halfSize) / this.cell));
      const ix1 = Math.min(this.segments, Math.ceil((maxX + this.halfSize) / this.cell));
      const iy0 = Math.max(0, Math.floor((minY + this.halfSize) / this.cell));
      const iy1 = Math.min(this.segments, Math.ceil((maxY + this.halfSize) / this.cell));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = -this.halfSize + ix * this.cell;
          const y = -this.halfSize + iy * this.cell;
          const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
          const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
          if (d > reach) continue;
          const water = smoothed[i]! + (smoothed[i + 1]! - smoothed[i]!) * t;
          // Bed sits below the water; banks blend back to the original surface.
          const k = d / reach;
          const target = water - 1.6 * (1 - k * k);
          const idx = iy * n1 + ix;
          if (this.heights[idx]! > target) this.heights[idx] = target;
        }
      }
    }
    let lo = Infinity;
    for (let i = 0; i < this.heights.length; i++) if (this.heights[i]! < lo) lo = this.heights[i]!;
    this.minY = lo;
    return smoothed;
  }

  /** Rendered height for a real elevation in metres. */
  toRenderedHeight(elevationM: number): number {
    return (elevationM - this.baseM) * VERTICAL_EXAGGERATION;
  }

  private h(ix: number, iy: number): number {
    const n1 = this.segments + 1;
    const cx = ix < 0 ? 0 : ix > this.segments ? this.segments : ix;
    const cy = iy < 0 ? 0 : iy > this.segments ? this.segments : iy;
    return this.heights[cy * n1 + cx]!;
  }

  /**
   * Height of the rendered surface at map (x, y). Matches the grid triangulation used by
   * `buildTerrainGeometry`: cell (ix, iy) is split along the diagonal from (ix, iy+1) to (ix+1, iy).
   */
  heightAt(x: number, y: number): number {
    const fx = (x + this.halfSize) / this.cell;
    const fy = (y + this.halfSize) / this.cell;
    let ix = Math.floor(fx);
    let iy = Math.floor(fy);
    if (ix < 0) ix = 0;
    if (iy < 0) iy = 0;
    if (ix > this.segments - 1) ix = this.segments - 1;
    if (iy > this.segments - 1) iy = this.segments - 1;
    const u = Math.min(1, Math.max(0, fx - ix));
    const v = Math.min(1, Math.max(0, fy - iy));
    const ha = this.h(ix, iy);
    const hb = this.h(ix, iy + 1);
    const hc = this.h(ix + 1, iy + 1);
    const hd = this.h(ix + 1, iy);
    if (u + v <= 1) return ha + (hd - ha) * u + (hb - ha) * v;
    return hc + (hb - hc) * (1 - u) + (hd - hc) * (1 - v);
  }

  /** Approximate surface normal (map frame gradient) for slope-based colouring. */
  slopeAt(x: number, y: number): number {
    const d = this.cell * 0.5;
    const dx = (this.heightAt(x + d, y) - this.heightAt(x - d, y)) / (2 * d);
    const dy = (this.heightAt(x, y + d) - this.heightAt(x, y - d)) / (2 * d);
    return Math.hypot(dx, dy);
  }
}
