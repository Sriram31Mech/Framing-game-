/**
 * Mutable per-frame camera state shared between the rig, the sun/shadow follower and fog.
 * Deliberately outside React to avoid re-rendering at 60 fps.
 */
export const cameraState = {
  targetX: 0,
  targetY: 0,
  targetZ: 0,
  distance: 1000,
  yaw: 0,
  /** Set when the rig moved this frame (lights/shadows follow). */
  moved: true,
};

export const perfStats = {
  fps: 0,
  frameMs: 0,
  calls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  instances: 0,
  layoutMs: 0,
};

/** Camera pitch (radians above horizon) for a zoom distance: lower when close, steeper far out. */
export function pitchForDistance(distance: number, min: number, max: number): number {
  const t = Math.max(0, Math.min(1, (distance - min) / (max - min)));
  const lo = (27 * Math.PI) / 180;
  const hi = (52 * Math.PI) / 180;
  return lo + (hi - lo) * Math.sqrt(t);
}
