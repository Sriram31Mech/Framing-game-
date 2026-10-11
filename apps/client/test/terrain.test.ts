import { describe, expect, it } from 'vitest';
import { TerrainSampler, VERTICAL_EXAGGERATION } from '../src/world/terrain';

describe('TerrainSampler', () => {
  const plane = (_s: number, x: number, y: number) => 900 + x * 0.01 + y * 0.02;
  const sampler = new TerrainSampler(1, 100, 10, plane);

  it('reproduces grid vertices and interpolates planes exactly', () => {
    expect(sampler.heightAt(-100, -100)).toBeCloseTo(0);
    const expected = (x: number, y: number) =>
      (plane(1, x, y) - sampler.baseM) * VERTICAL_EXAGGERATION;
    for (const [x, y] of [
      [0, 0],
      [13.7, -42.1],
      [99, 99],
      [-55.5, 12.25],
    ] as const) {
      expect(sampler.heightAt(x, y)).toBeCloseTo(expected(x, y), 6);
    }
  });

  it('clamps outside the map', () => {
    expect(sampler.heightAt(-500, -500)).toBeCloseTo(sampler.heightAt(-100, -100));
  });

  it('carves a river channel below the original surface', () => {
    const s = new TerrainSampler(1, 100, 20, () => 900);
    const before = s.heightAt(0, 0);
    s.carveRiver(
      [
        { x: 0, y: -100 },
        { x: 0, y: 100 },
      ],
      10,
    );
    expect(s.heightAt(0, 0)).toBeLessThan(before);
    expect(s.heightAt(80, 0)).toBeCloseTo(before);
  });
});
