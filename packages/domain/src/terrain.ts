/**
 * Deterministic terrain height field shared by server (parcel elevation) and client (mesh).
 * Returns metres above sea level at map position (x, y). Smooth (value noise / fbm), with the
 * river valley carved lower and gentle hills rising toward the west (Malnad ghats side).
 */
export function terrainHeightM(seed: number, x: number, y: number): number {
  void seed;
  void x;
  void y;
  throw new Error('not implemented');
}

/** Slope percentage at (x, y) estimated by finite differences. */
export function terrainSlopePct(seed: number, x: number, y: number): number {
  void seed;
  void x;
  void y;
  throw new Error('not implemented');
}
