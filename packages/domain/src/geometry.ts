import type { MapPoint } from './types';

/** Planar geometry helpers for map polygons (metres). Polygons are rings without a repeated first point. */

/** Shoelace signed area: positive for counter-clockwise rings (x right, y up convention). */
export function signedPolygonArea(ring: MapPoint[]): number {
  let twiceArea = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return twiceArea / 2;
}

export function polygonArea(ring: MapPoint[]): number {
  return Math.abs(signedPolygonArea(ring));
}

/** Area-weighted centroid of a simple polygon. */
export function polygonCentroid(ring: MapPoint[]): MapPoint {
  const area = signedPolygonArea(ring);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const cross = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

/** True if every turn has the same orientation (strictly convex, no collinear corners). */
export function isConvexPolygon(ring: MapPoint[]): boolean {
  if (ring.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const c = ring[(i + 2) % ring.length]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(point: MapPoint, ring: MapPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > point.y !== b.y > point.y) {
      const xCross = a.x + ((point.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (point.x < xCross) inside = !inside;
    }
  }
  return inside;
}

export function distance(a: MapPoint, b: MapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance from a point to segment ab. */
export function pointSegmentDistance(p: MapPoint, a: MapPoint, b: MapPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function orientation(a: MapPoint, b: MapPoint, c: MapPoint): number {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

/** True if segments ab and cd properly or improperly intersect. */
export function segmentsIntersect(a: MapPoint, b: MapPoint, c: MapPoint, d: MapPoint): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  // Collinear overlap cases.
  return (
    (o1 === 0 && pointSegmentDistance(c, a, b) === 0) ||
    (o2 === 0 && pointSegmentDistance(d, a, b) === 0) ||
    (o3 === 0 && pointSegmentDistance(a, c, d) === 0) ||
    (o4 === 0 && pointSegmentDistance(b, c, d) === 0)
  );
}

export function segmentDistance(a: MapPoint, b: MapPoint, c: MapPoint, d: MapPoint): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

/** Distance from a point to an open polyline. */
export function pointPolylineDistance(p: MapPoint, line: MapPoint[]): number {
  if (line.length === 1) return distance(p, line[0]!);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < line.length; i++) {
    best = Math.min(best, pointSegmentDistance(p, line[i]!, line[i + 1]!));
  }
  return best;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundingBox(points: MapPoint[]): BoundingBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function boxesWithin(a: BoundingBox, b: BoundingBox, margin: number): boolean {
  return (
    a.minX - margin <= b.maxX &&
    b.minX - margin <= a.maxX &&
    a.minY - margin <= b.maxY &&
    b.minY - margin <= a.maxY
  );
}

/**
 * Minimum distance between a polygon (as a filled area) and a polyline; 0 if they touch or
 * the polyline enters the polygon. Distances beyond `cutoff` may be reported as `cutoff`.
 */
export function polygonPolylineDistance(
  ring: MapPoint[],
  line: MapPoint[],
  cutoff = Number.POSITIVE_INFINITY,
): number {
  const box = boundingBox(ring);
  if (line[0] && pointInPolygon(line[0], ring)) return 0;
  let best = cutoff;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const segmentBox = {
      minX: Math.min(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxX: Math.max(a.x, b.x),
      maxY: Math.max(a.y, b.y),
    };
    if (!boxesWithin(box, segmentBox, best)) continue;
    for (let j = 0; j < ring.length; j++) {
      best = Math.min(best, segmentDistance(ring[j]!, ring[(j + 1) % ring.length]!, a, b));
      if (best === 0) return 0;
    }
  }
  return best;
}

/** Distance from a point to a polygon's area (0 inside). */
export function pointPolygonDistance(p: MapPoint, ring: MapPoint[]): number {
  if (pointInPolygon(p, ring)) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i++) {
    best = Math.min(best, pointSegmentDistance(p, ring[i]!, ring[(i + 1) % ring.length]!));
  }
  return best;
}

/**
 * Separating-axis test for two convex polygons. Returns true when they are closer than `gap`
 * metres along every edge normal (i.e. they overlap, or are separated by less than `gap`).
 */
export function convexPolygonsOverlap(a: MapPoint[], b: MapPoint[], gap = 0): boolean {
  for (const ring of [a, b]) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      if (length === 0) continue;
      const nx = -(q.y - p.y) / length;
      const ny = (q.x - p.x) / length;
      let minA = Number.POSITIVE_INFINITY;
      let maxA = Number.NEGATIVE_INFINITY;
      let minB = Number.POSITIVE_INFINITY;
      let maxB = Number.NEGATIVE_INFINITY;
      for (const v of a) {
        const d = v.x * nx + v.y * ny;
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      for (const v of b) {
        const d = v.x * nx + v.y * ny;
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      if (minB - maxA >= gap || minA - maxB >= gap) return false;
    }
  }
  return true;
}
