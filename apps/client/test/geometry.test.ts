import { describe, expect, it } from 'vitest';
import {
  clipPolygonToRect,
  densify,
  pointAlong,
  pointInPolygon,
  polygonArea,
  polygonSignedArea,
  polylineCumulative,
  PolygonIndex,
  sampleCropRows,
} from '../src/lib/geometry';

const square = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];
const lShape = [
  { x: 0, y: 0 },
  { x: 200, y: 0 },
  { x: 200, y: 60 },
  { x: 60, y: 60 },
  { x: 60, y: 200 },
  { x: 0, y: 200 },
];

describe('polygon helpers', () => {
  it('point in polygon handles convex and concave shapes', () => {
    expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
    expect(pointInPolygon({ x: 30, y: 150 }, lShape)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 150 }, lShape)).toBe(false);
  });
  it('area and orientation', () => {
    expect(polygonArea(square)).toBe(10_000);
    expect(polygonArea(lShape)).toBe(200 * 60 + 60 * 140);
    expect(Math.sign(polygonSignedArea(square))).toBe(
      -Math.sign(polygonSignedArea([...square].reverse())),
    );
  });
  it('clips to a rectangle (Sutherland–Hodgman)', () => {
    const clipped = clipPolygonToRect(square, { minX: 50, minY: 50, maxX: 150, maxY: 150 });
    expect(polygonArea(clipped)).toBeCloseTo(2500);
    expect(clipPolygonToRect(square, { minX: 200, minY: 200, maxX: 300, maxY: 300 })).toHaveLength(
      0,
    );
  });
  it('densifies without exceeding the step', () => {
    const d = densify(square, 30, true);
    for (let i = 0; i < d.length; i++) {
      const a = d[i]!;
      const b = d[(i + 1) % d.length]!;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(30 + 1e-9);
    }
  });
  it('walks along a polyline', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const cum = polylineCumulative(pts);
    expect(cum).toEqual([0, 10, 20]);
    expect(pointAlong(pts, cum, 15)).toMatchObject({ x: 10, y: 5 });
  });
  it('indexes polygons for lookups', () => {
    const idx = new PolygonIndex([square, lShape.map((p) => ({ x: p.x + 500, y: p.y }))]);
    expect(idx.find({ x: 10, y: 10 })).toBe(0);
    expect(idx.find({ x: 520, y: 150 })).toBe(1);
    expect(idx.find({ x: 400, y: 400 })).toBe(-1);
  });
});

describe('crop row sampling', () => {
  it('fills the field at roughly area / (spacing × segment) and stays inside', () => {
    const rows = sampleCropRows(square, { rowSpacing: 4, segmentLength: 10, margin: 2, angle: 0 });
    const inner = (100 - 4) * (100 - 4);
    expect(rows.length).toBeGreaterThan((inner / 40) * 0.8);
    expect(rows.length).toBeLessThan((inner / 40) * 1.2);
    for (const r of rows) expect(pointInPolygon(r, square)).toBe(true);
  });
  it('is deterministic for the same seed and handles concave fields', () => {
    const a = sampleCropRows(lShape, { rowSpacing: 3, segmentLength: 6, margin: 2, seed: 'HV-1' });
    const b = sampleCropRows(lShape, { rowSpacing: 3, segmentLength: 6, margin: 2, seed: 'HV-1' });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(500);
    for (const r of a) expect(pointInPolygon(r, lShape)).toBe(true);
  });
  it('respects maxSamples and rotates rows along the longest edge by default', () => {
    expect(
      sampleCropRows(square, { rowSpacing: 2, segmentLength: 4, margin: 1, maxSamples: 50 }),
    ).toHaveLength(50);
    const rows = sampleCropRows(lShape, { rowSpacing: 5, segmentLength: 10, margin: 2 });
    expect(rows[0]!.angle).toBeCloseTo(0);
  });
});
