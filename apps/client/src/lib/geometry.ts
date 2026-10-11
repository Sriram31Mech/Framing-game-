/**
 * 2D geometry on the map plane (metres; x east, y south). Pure and deterministic so the
 * 3D scene is stable across reloads and the helpers are unit-testable.
 */
import { mulberry32, hashString } from './random';

export interface Pt {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Even-odd ray casting. Points exactly on an edge may fall either way. */
export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y) {
      const xCross = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Signed shoelace area (positive for counter-clockwise in a y-up frame). */
export function polygonSignedArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j]!.x + poly[i]!.x) * (poly[j]!.y - poly[i]!.y);
  }
  return -a / 2;
}

export function polygonArea(poly: readonly Pt[]): number {
  return Math.abs(polygonSignedArea(poly));
}

export function polygonBounds(poly: readonly Pt[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Angle (radians, atan2(dy, dx)) of the polygon's longest edge — fields are ploughed along it. */
export function longestEdgeAngle(poly: readonly Pt[]): number {
  let best = 0;
  let angle = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best) {
      best = len;
      angle = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  return angle;
}

/**
 * Sutherland–Hodgman clip of an arbitrary polygon against an axis-aligned rectangle (convex clipper).
 * Returns the clipped ring (possibly empty).
 */
export function clipPolygonToRect(poly: readonly Pt[], r: Bounds): Pt[] {
  type Edge = (p: Pt) => boolean;
  type Cut = (a: Pt, b: Pt) => Pt;
  const lerpX = (a: Pt, b: Pt, x: number): Pt => ({
    x,
    y: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x),
  });
  const lerpY = (a: Pt, b: Pt, y: number): Pt => ({
    x: a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y),
    y,
  });
  const planes: [Edge, Cut][] = [
    [(p) => p.x >= r.minX, (a, b) => lerpX(a, b, r.minX)],
    [(p) => p.x <= r.maxX, (a, b) => lerpX(a, b, r.maxX)],
    [(p) => p.y >= r.minY, (a, b) => lerpY(a, b, r.minY)],
    [(p) => p.y <= r.maxY, (a, b) => lerpY(a, b, r.maxY)],
  ];
  let out: Pt[] = poly.slice();
  for (const [inside, cut] of planes) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!;
      const prev = input[(i + input.length - 1) % input.length]!;
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) out.push(cut(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(cut(prev, cur));
      }
    }
  }
  return out;
}

/** Inserts points so that no segment is longer than `step`. Closed rings when `closed`. */
export function densify(points: readonly Pt[], step: number, closed: boolean): Pt[] {
  const out: Pt[] = [];
  const n = points.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < k; s++) {
      const t = s / k;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  if (!closed && n > 0) out.push({ ...points[n - 1]! });
  return out;
}

export function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

export function distanceToPolyline(p: Pt, pts: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distanceToSegment(p, pts[i]!, pts[i + 1]!);
    if (d < best) best = d;
  }
  return best;
}

/** Cumulative arc length per vertex (first = 0). */
export function polylineCumulative(pts: readonly Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) {
    out.push(out[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  }
  return out;
}

/** Point and heading at arc length `s` along a polyline (clamped). */
export function pointAlong(
  pts: readonly Pt[],
  cumulative: readonly number[],
  s: number,
): Pt & { angle: number } {
  const total = cumulative[cumulative.length - 1] ?? 0;
  const d = Math.max(0, Math.min(total, s));
  let i = 1;
  while (i < cumulative.length - 1 && cumulative[i]! < d) i++;
  const a = pts[i - 1]!;
  const b = pts[i] ?? a;
  const segLen = cumulative[i]! - cumulative[i - 1]! || 1;
  const t = (d - cumulative[i - 1]!) / segLen;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

export interface CropRowSample {
  x: number;
  y: number;
  /** Heading of the row (radians, map frame). */
  angle: number;
  /** Segment length along the row, metres. */
  length: number;
  /** 0..1 deterministic per-sample variation. */
  variation: number;
}

export interface CropRowOptions {
  rowSpacing: number;
  segmentLength: number;
  /** Keep rows this far from the bund (polygon edge). */
  margin: number;
  /** Row heading; defaults to the longest edge. */
  angle?: number;
  /** Seed for per-sample variation (does not affect positions). */
  seed?: string;
  /** Hard cap on returned samples. */
  maxSamples?: number;
}

/**
 * Lays out crop row segments inside a polygon: scanlines parallel to `angle`, spaced
 * `rowSpacing`, split into `segmentLength` pieces, inset by `margin`. Deterministic.
 */
export function sampleCropRows(poly: readonly Pt[], opts: CropRowOptions): CropRowSample[] {
  if (poly.length < 3) return [];
  const angle = opts.angle ?? longestEdgeAngle(poly);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Rotate polygon into row frame: u along rows, v across.
  const local = poly.map((p) => ({ u: p.x * cos + p.y * sin, v: -p.x * sin + p.y * cos }));
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of local) {
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }
  const rand = mulberry32(hashString(opts.seed ?? 'rows'));
  const out: CropRowSample[] = [];
  const max = opts.maxSamples ?? Infinity;
  const startV = vMin + opts.margin + opts.rowSpacing / 2;
  for (let v = startV; v <= vMax - opts.margin; v += opts.rowSpacing) {
    // Intersections of the scanline with every edge.
    const xs: number[] = [];
    for (let i = 0, j = local.length - 1; i < local.length; j = i++) {
      const a = local[i]!;
      const b = local[j]!;
      if (a.v > v !== b.v > v) xs.push(a.u + ((v - a.v) * (b.u - a.u)) / (b.v - a.v));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const u0 = xs[k]! + opts.margin;
      const u1 = xs[k + 1]! - opts.margin;
      const span = u1 - u0;
      if (span < opts.segmentLength * 0.5) continue;
      const count = Math.max(1, Math.round(span / opts.segmentLength));
      const len = span / count;
      for (let s = 0; s < count; s++) {
        if (out.length >= max) return out;
        const u = u0 + len * (s + 0.5);
        out.push({
          x: u * cos - v * sin,
          y: u * sin + v * cos,
          angle,
          length: len,
          variation: rand(),
        });
      }
    }
  }
  return out;
}

/**
 * Uniform grid index of polygons for fast "is this point inside any parcel" queries
 * during scenery placement.
 */
export class PolygonIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly bounds: Bounds[];

  constructor(
    private readonly polys: readonly (readonly Pt[])[],
    private readonly cellSize = 100,
  ) {
    this.bounds = polys.map((p) => polygonBounds(p));
    this.bounds.forEach((b, i) => {
      for (let cx = Math.floor(b.minX / cellSize); cx <= Math.floor(b.maxX / cellSize); cx++) {
        for (let cy = Math.floor(b.minY / cellSize); cy <= Math.floor(b.maxY / cellSize); cy++) {
          const key = this.key(cx, cy);
          const list = this.cells.get(key);
          if (list) list.push(i);
          else this.cells.set(key, [i]);
        }
      }
    });
  }

  private key(cx: number, cy: number): number {
    return (cx + 4096) * 8192 + (cy + 4096);
  }

  /** Index of the polygon containing `p`, or -1. */
  find(p: Pt, pad = 0): number {
    const list = this.cells.get(
      this.key(Math.floor(p.x / this.cellSize), Math.floor(p.y / this.cellSize)),
    );
    if (!list) return -1;
    for (const i of list) {
      const b = this.bounds[i]!;
      if (p.x < b.minX - pad || p.x > b.maxX + pad || p.y < b.minY - pad || p.y > b.maxY + pad)
        continue;
      if (pointInPolygon(p, this.polys[i]!)) return i;
      if (pad > 0) {
        const poly = this.polys[i]!;
        for (let k = 0; k < poly.length; k++) {
          if (distanceToSegment(p, poly[k]!, poly[(k + 1) % poly.length]!) < pad) return i;
        }
      }
    }
    return -1;
  }
}
