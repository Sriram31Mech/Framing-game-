/**
 * Geometry for the Tamil Nadu map. Scene units are kilometres: x east, z south (map y), y up.
 * All segment fills are merged into one BufferGeometry (one draw call) with per-vertex colours;
 * `triangleOwner` maps a raycast faceIndex back to its segment.
 */
import type { Color } from 'three';
import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2 } from 'three';
import { type Bounds, pointInPolygon, polygonArea, polygonBounds } from '../../lib/geometry';

export interface MapPointLike {
  x: number;
  y: number;
}

export const LAND_TOP = 0.6;
export const LAND_BOTTOM = -2.5;
export const KM = 1 / 1000;

export const toScene = (p: MapPointLike, h = LAND_TOP): [number, number, number] => [
  p.x * KM,
  h,
  p.y * KM,
];

/** Triangulated fills for many rings, merged; returns triangle → ring index map. */
export function buildMergedFill(
  rings: MapPointLike[][],
  colorOf: (index: number) => Color,
  height = LAND_TOP,
): { geometry: BufferGeometry; triangleOwner: Int32Array } {
  const positions: number[] = [];
  const colors: number[] = [];
  const owners: number[] = [];
  rings.forEach((ring, ringIndex) => {
    if (ring.length < 3) return;
    const contour = ring.map((p) => new Vector2(p.x * KM, p.y * KM));
    const tris = ShapeUtils.triangulateShape(contour, []);
    const c = colorOf(ringIndex);
    for (const tri of tris) {
      // Reverse the winding so faces point up (+y) when viewed from above with z south.
      for (const i of [tri[2]!, tri[1]!, tri[0]!]) {
        const v = contour[i]!;
        positions.push(v.x, height, v.y);
        colors.push(c.r, c.g, c.b);
      }
      owners.push(ringIndex);
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.computeVertexNormals();
  return { geometry, triangleOwner: Int32Array.from(owners) };
}

/** Recolour an existing merged fill in place (avoids rebuilding geometry on layer change). */
export function recolourFill(
  geometry: BufferGeometry,
  triangleOwner: Int32Array,
  colorOf: (index: number) => Color,
): void {
  const attr = geometry.getAttribute('color') as BufferAttribute;
  const cache = new Map<number, Color>();
  for (let t = 0; t < triangleOwner.length; t++) {
    const owner = triangleOwner[t]!;
    let c = cache.get(owner);
    if (!c) {
      c = colorOf(owner);
      cache.set(owner, c);
    }
    for (let k = 0; k < 3; k++) attr.setXYZ(t * 3 + k, c.r, c.g, c.b);
  }
  attr.needsUpdate = true;
}

/** Vertical walls under outer rings, giving the state a carved-slab silhouette. */
export function buildWalls(rings: MapPointLike[][]): BufferGeometry {
  const positions: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const [ax, , az] = toScene(a);
      const [bx, , bz] = toScene(b);
      positions.push(
        ax,
        LAND_TOP,
        az,
        bx,
        LAND_TOP,
        bz,
        bx,
        LAND_BOTTOM,
        bz,
        ax,
        LAND_TOP,
        az,
        bx,
        LAND_BOTTOM,
        bz,
        ax,
        LAND_BOTTOM,
        az,
      );
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Closed outline points (scene coords) for drei <Line>. */
export function outlinePoints(
  ring: MapPointLike[],
  h = LAND_TOP + 0.05,
): [number, number, number][] {
  const pts = ring.map((p) => toScene(p, h));
  if (pts.length) pts.push(pts[0]!);
  return pts;
}

/** All segment outlines as one LineSegments geometry (thin, single draw call). */
export function buildOutlineSegments(rings: MapPointLike[][], h = LAND_TOP + 0.03): BufferGeometry {
  const positions: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      positions.push(a.x * KM, h, a.y * KM, b.x * KM, h, b.y * KM);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  return geometry;
}

/**
 * Deterministic random points inside the given rings (rejection sampling in each ring's bbox),
 * spread over rings by area. `accept` can bias placement (e.g. only a district's western edge).
 */
export function scatterInRings(
  rings: MapPointLike[][],
  count: number,
  rand: () => number,
  accept?: (p: MapPointLike, bounds: Bounds) => boolean,
): MapPointLike[] {
  const out: MapPointLike[] = [];
  const total = rings.reduce((s, r) => s + polygonArea(r), 0);
  if (total <= 0 || count <= 0) return out;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const want = Math.round((count * polygonArea(ring)) / total);
    const b = polygonBounds(ring);
    for (let got = 0, tries = 0; got < want && tries < want * 30; tries++) {
      const p = { x: b.minX + rand() * (b.maxX - b.minX), y: b.minY + rand() * (b.maxY - b.minY) };
      if (pointInPolygon(p, ring) && (!accept || accept(p, b))) {
        out.push(p);
        got++;
      }
    }
  }
  return out;
}
