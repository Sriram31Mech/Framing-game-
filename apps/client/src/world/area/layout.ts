/**
 * Pure layout for the area close-up: the segment outline scaled to scene units, plot cells
 * packed inside it, and a deterministic scatter of decorations around them.
 */
import { pointInPolygon, polygonBounds, type Pt } from '../../lib/geometry';
import { rngFrom } from '../../lib/random';

export type Biome = 'hills' | 'delta' | 'dry' | 'plain';

/** Works with either zone ids ('hilly') or labels ('Hilly Zone'). */
export function biomeFor(zone: string, districtId?: string | null): Biome {
  const z = zone.toLowerCase();
  if (z.includes('hill') || districtId === 'nilgiris') return 'hills';
  if (z.includes('delta') || z.includes('rainfall')) return 'delta';
  if (z.includes('north western') || z.includes('north_western') || z.includes('southern'))
    return 'dry';
  return 'plain';
}

/** Scene radius of the scaled-up segment outline. */
export const AREA_RADIUS = 60;

/** Map metres (x east, y south) → scene units centred on the outline; scene z = map y. */
export function normalizeOutline(poly: readonly Pt[], radius = AREA_RADIUS) {
  const b = polygonBounds(poly);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const k = (2 * radius) / Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-6);
  const toScene = (p: Pt): Pt => ({ x: (p.x - cx) * k, y: (p.y - cy) * k });
  return { outline: poly.map(toScene), toScene };
}

/**
 * Square cells fully inside `outline`, as large as possible while fitting `n` of them, picked
 * nearest the middle and returned in raster order (north→south, west→east).
 */
export function plotCells(outline: readonly Pt[], n: number): { cells: Pt[]; size: number } {
  if (n <= 0) return { cells: [], size: 0 };
  const b = polygonBounds(outline);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const mid = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  let size = Math.max(w, h) / Math.ceil(Math.sqrt(n));
  for (let iter = 0; iter < 60; iter++, size *= 0.92) {
    const found: Pt[] = [];
    const inset = size * 0.45;
    for (let y = b.minY + size / 2; y < b.maxY; y += size) {
      for (let x = b.minX + size / 2; x < b.maxX; x += size) {
        const corners = [
          { x, y },
          { x: x - inset, y: y - inset },
          { x: x + inset, y: y - inset },
          { x: x - inset, y: y + inset },
          { x: x + inset, y: y + inset },
        ];
        if (corners.every((c) => pointInPolygon(c, outline))) found.push({ x, y });
      }
    }
    if (found.length >= n) {
      const d = (p: Pt) => Math.hypot(p.x - mid.x, p.y - mid.y);
      const cells = found
        .sort((a, c) => d(a) - d(c))
        .slice(0, n)
        .sort((a, c) => a.y - c.y || a.x - c.x);
      return { cells, size };
    }
  }
  // shortcut: degenerate outline (sliver) — fall back to a centred grid that may overhang it.
  const cols = Math.ceil(Math.sqrt(n));
  size = Math.max(w, h, 10) / (cols + 1);
  const cells = Array.from({ length: n }, (_, i) => ({
    x: mid.x + ((i % cols) - (cols - 1) / 2) * size,
    y: mid.y + (Math.floor(i / cols) - (cols - 1) / 2) * size,
  }));
  return { cells, size };
}

/** Random points inside `outline` but clear of every plot cell (cells are squares of `size`). */
export function scatter(
  outline: readonly Pt[],
  cells: readonly Pt[],
  size: number,
  count: number,
  seed: string,
): Pt[] {
  const rnd = rngFrom('area-scatter', seed);
  const b = polygonBounds(outline);
  const clear = size * 0.62;
  const out: Pt[] = [];
  for (let tries = 0; out.length < count && tries < count * 30; tries++) {
    const p = { x: b.minX + rnd() * (b.maxX - b.minX), y: b.minY + rnd() * (b.maxY - b.minY) };
    if (!pointInPolygon(p, outline)) continue;
    if (cells.some((c) => Math.abs(c.x - p.x) < clear && Math.abs(c.y - p.y) < clear)) continue;
    out.push(p);
  }
  return out;
}
