/**
 * Parcel field patches (terrain-following fill), bunds (raised earthen borders, coloured by
 * ownership) and a light picking mesh. Geometry is built once per map layout; ownership/crop
 * changes only rewrite the colour attributes.
 */
import type { Color } from 'three';
import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2 } from 'three';
import {
  clipPolygonToRect,
  densify,
  pointInPolygon,
  polygonBounds,
  polygonSignedArea,
  type Pt,
} from '../../lib/geometry';
import type { TerrainSampler } from '../terrain';

export const FILL_LIFT = 0.35;
export const BUND_LIFT = 0.9;

export interface ParcelShape {
  id: string;
  polygon: Pt[];
}

export interface ParcelFill {
  geometry: BufferGeometry;
  /** Parcel index for every vertex (used to recolour). */
  vertexParcel: Uint16Array;
}

function triangulate(ring: Pt[]): number[][] {
  const contour = ring.map((p) => new Vector2(p.x, p.y));
  return ShapeUtils.triangulateShape(contour, []);
}

/**
 * Terrain-following fill: the polygon is clipped against a regular grid (`cell` metres) and each
 * piece triangulated, so the patch bends with the ground instead of cutting through hills.
 */
export function buildParcelFill(
  parcels: readonly ParcelShape[],
  sampler: TerrainSampler,
  cell = 14,
  lift = FILL_LIFT,
): ParcelFill {
  const pos: number[] = [];
  const owner: number[] = [];
  const index: number[] = [];
  parcels.forEach((parcel, pi) => {
    const poly = parcel.polygon;
    if (poly.length < 3) return;
    const b = polygonBounds(poly);
    for (let cx = Math.floor(b.minX / cell); cx * cell < b.maxX; cx++) {
      for (let cy = Math.floor(b.minY / cell); cy * cell < b.maxY; cy++) {
        const r = {
          minX: cx * cell,
          minY: cy * cell,
          maxX: (cx + 1) * cell,
          maxY: (cy + 1) * cell,
        };
        const corners: Pt[] = [
          { x: r.minX, y: r.minY },
          { x: r.maxX, y: r.minY },
          { x: r.maxX, y: r.maxY },
          { x: r.minX, y: r.maxY },
        ];
        const allIn = corners.every((c) => pointInPolygon(c, poly));
        const vertexInside =
          allIn && poly.some((p) => p.x > r.minX && p.x < r.maxX && p.y > r.minY && p.y < r.maxY);
        let ring: Pt[];
        if (allIn && !vertexInside) ring = corners;
        else ring = clipPolygonToRect(poly, r);
        if (ring.length < 3 || Math.abs(polygonSignedArea(ring)) < 0.01) continue;
        const base = pos.length / 3;
        for (const p of ring) {
          pos.push(p.x, sampler.heightAt(p.x, p.y) + lift, p.y);
          owner.push(pi);
        }
        const tris =
          ring === corners
            ? [
                [0, 1, 2],
                [0, 2, 3],
              ]
            : triangulate(ring);
        for (const t of tris) {
          // Map y → three z flips handedness; order so faces point up (+y).
          const a = ring[t[0]!]!;
          const bb = ring[t[1]!]!;
          const c = ring[t[2]!]!;
          const cross = (bb.x - a.x) * (c.y - a.y) - (bb.y - a.y) * (c.x - a.x);
          if (cross > 0) index.push(base + t[0]!, base + t[2]!, base + t[1]!);
          else index.push(base + t[0]!, base + t[1]!, base + t[2]!);
        }
      }
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(pos.length), 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { geometry, vertexParcel: Uint16Array.from(owner) };
}

export interface BundMesh {
  geometry: BufferGeometry;
  vertexParcel: Uint16Array;
  /** Alternating 0/1 per segment for the dashed "for sale" look. */
  vertexDash: Uint8Array;
}

/**
 * Raised bund ribbons along every parcel edge: outer-low, top-outer, top-inner, inner-low.
 */
export function buildBunds(
  parcels: readonly ParcelShape[],
  sampler: TerrainSampler,
  opts: { width?: number; height?: number; step?: number; dash?: number; lift?: number } = {},
): BundMesh {
  const width = opts.width ?? 2.2;
  const height = opts.height ?? BUND_LIFT;
  const step = opts.step ?? 8;
  const dash = opts.dash ?? 10;
  const lift = opts.lift ?? 0.15;
  const pos: number[] = [];
  const owner: number[] = [];
  const dashArr: number[] = [];
  const index: number[] = [];
  parcels.forEach((parcel, pi) => {
    if (parcel.polygon.length < 3) return;
    // Orient ring CCW in map coordinates so "inside" is consistently to the left.
    const ring =
      polygonSignedArea(parcel.polygon) >= 0 ? parcel.polygon : [...parcel.polygon].reverse();
    const pts = densify(ring, step, true);
    const m = pts.length;
    let along = 0;
    const base = pos.length / 3;
    for (let i = 0; i < m; i++) {
      const prev = pts[(i - 1 + m) % m]!;
      const cur = pts[i]!;
      const next = pts[(i + 1) % m]!;
      // Averaged edge normal (map frame).
      const d1x = cur.x - prev.x;
      const d1y = cur.y - prev.y;
      const d2x = next.x - cur.x;
      const d2y = next.y - cur.y;
      const l1 = Math.hypot(d1x, d1y) || 1;
      const l2 = Math.hypot(d2x, d2y) || 1;
      let nx = -(d1y / l1 + d2y / l2);
      let ny = d1x / l1 + d2x / l2;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      const hw = width / 2;
      const ground = sampler.heightAt(cur.x, cur.y) + lift;
      const top = ground + height - lift;
      const dashBit = Math.floor(along / dash) % 2;
      along += l2;
      const verts: [number, number, number][] = [
        [cur.x - nx * hw, ground, cur.y - ny * hw],
        [cur.x - nx * hw * 0.45, top, cur.y - ny * hw * 0.45],
        [cur.x + nx * hw * 0.45, top, cur.y + ny * hw * 0.45],
        [cur.x + nx * hw, ground, cur.y + ny * hw],
      ];
      for (const v of verts) {
        pos.push(v[0], v[1], v[2]);
        owner.push(pi);
        dashArr.push(dashBit);
      }
    }
    for (let i = 0; i < m; i++) {
      const a = base + i * 4;
      const b = base + ((i + 1) % m) * 4;
      for (let k = 0; k < 3; k++) {
        // Quad between cross-section i (a) and i+1 (b), strip k; wound so faces point up/out.
        index.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
      }
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(pos.length), 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { geometry, vertexParcel: Uint16Array.from(owner), vertexDash: Uint8Array.from(dashArr) };
}

export interface PickMesh {
  geometry: BufferGeometry;
  /** Parcel index for each triangle (faceIndex → parcel). */
  triangleParcel: Uint16Array;
}

/** Coarse polygon triangulation used only for raycasting (never drawn). */
export function buildPickMesh(parcels: readonly ParcelShape[], sampler: TerrainSampler): PickMesh {
  const pos: number[] = [];
  const index: number[] = [];
  const triOwner: number[] = [];
  parcels.forEach((parcel, pi) => {
    const ring = densify(parcel.polygon, 40, true);
    if (ring.length < 3) return;
    const base = pos.length / 3;
    for (const p of ring) pos.push(p.x, sampler.heightAt(p.x, p.y) + FILL_LIFT, p.y);
    for (const t of triangulate(ring)) {
      index.push(base + t[0]!, base + t[1]!, base + t[2]!);
      triOwner.push(pi);
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return { geometry, triangleParcel: Uint16Array.from(triOwner) };
}

/** Write per-parcel colours into a colour attribute using a vertex→parcel map. */
export function applyParcelColors(
  geometry: BufferGeometry,
  vertexParcel: Uint16Array,
  colorFor: (parcelIndex: number, vertex: number) => Color,
): void {
  const attr = geometry.getAttribute('color') as BufferAttribute;
  const arr = attr.array as Float32Array;
  for (let v = 0; v < vertexParcel.length; v++) {
    const c = colorFor(vertexParcel[v]!, v);
    arr[v * 3] = c.r;
    arr[v * 3 + 1] = c.g;
    arr[v * 3 + 2] = c.b;
  }
  attr.needsUpdate = true;
}
