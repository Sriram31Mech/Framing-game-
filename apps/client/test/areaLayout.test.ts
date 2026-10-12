import { describe, expect, it } from 'vitest';
import { pointInPolygon } from '../src/lib/geometry';
import { biomeFor, normalizeOutline, plotCells, scatter } from '../src/world/area/layout';

const L = [
  { x: 1000, y: 1000 },
  { x: 5000, y: 1000 },
  { x: 5000, y: 3000 },
  { x: 3000, y: 3000 },
  { x: 3000, y: 5000 },
  { x: 1000, y: 5000 },
];

describe('area layout', () => {
  it('maps zones to biomes', () => {
    expect(biomeFor('Hilly Zone')).toBe('hills');
    expect(biomeFor('Cauvery Delta Zone')).toBe('delta');
    expect(biomeFor('North Western Zone')).toBe('dry');
    expect(biomeFor('Western Zone')).toBe('plain');
    expect(biomeFor('whatever', 'nilgiris')).toBe('hills');
  });

  it('packs n non-overlapping cells inside the outline', () => {
    const { outline } = normalizeOutline(L);
    for (const n of [1, 3, 7, 12]) {
      const { cells, size } = plotCells(outline, n);
      expect(cells).toHaveLength(n);
      for (const c of cells) expect(pointInPolygon(c, outline)).toBe(true);
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const a = cells[i]!;
          const b = cells[j]!;
          expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))).toBeGreaterThanOrEqual(
            size - 1e-6,
          );
        }
    }
  });

  it('scatters deterministically and clear of plots', () => {
    const { outline } = normalizeOutline(L);
    const { cells, size } = plotCells(outline, 4);
    const a = scatter(outline, cells, size, 20, 'seg');
    expect(a).toEqual(scatter(outline, cells, size, 20, 'seg'));
    for (const p of a) expect(pointInPolygon(p, outline)).toBe(true);
  });
});
