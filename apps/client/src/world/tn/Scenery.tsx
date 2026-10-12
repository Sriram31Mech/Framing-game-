/**
 * Ambient life on the state map: trees, palms and hills (static, deterministic), drifting clouds
 * with ground shadows, bird flocks, lorries on the highways, boats and glints along the coast,
 * and a flowing Cauvery. Every system is a handful of InstancedMeshes driven by one useFrame.
 */
import { Line } from '@react-three/drei';
import { useMemo, useRef } from 'react';
import { Color, Object3D } from 'three';
import { RIVER } from './colors';
import { pointAlong, pointInPolygon, polygonArea, polylineCumulative } from '../../lib/geometry';
import { rngFrom } from '../../lib/random';
import { KM, LAND_TOP, scatterInRings, toScene, type MapPointLike } from './geometry';
import { makeBuffers, Prop, useTick } from './Instanced';
import {
  BIRD,
  birdMat,
  BOAT,
  CLOUD,
  cloudMat,
  DISC,
  GLINT,
  glintMat,
  HILL,
  PALM,
  shadowMat,
  solid,
  TREE,
  TRUCK,
} from './parts';

export const SEA_LEVEL = -2.7;

export interface SceneryDistrict {
  id: string;
  name: string;
  zone: string;
  polygons: MapPointLike[][];
  centroid: MapPointLike;
}

const dummy = new Object3D();
const tmp = new Color();
function put(arr: Float32Array, i: number) {
  dummy.updateMatrix();
  dummy.matrix.toArray(arr, i * 16);
}

function zoneMix(zone: string): { density: number; palm: number; tint: string } {
  const z = zone.toLowerCase();
  if (z.includes('hill')) return { density: 2.4, palm: 0.08, tint: '#3f7d45' };
  if (z.includes('rainfall')) return { density: 1.8, palm: 0.55, tint: '#4f9a4a' };
  if (z.includes('delta')) return { density: 1.3, palm: 0.6, tint: '#5aa24c' };
  if (z.includes('north western') || z.includes('north_western'))
    return { density: 0.8, palm: 0.2, tint: '#73924a' };
  if (z.includes('western')) return { density: 0.9, palm: 0.5, tint: '#6f9a45' };
  if (z.includes('southern')) return { density: 0.6, palm: 0.35, tint: '#86964a' };
  return { density: 1, palm: 0.35, tint: '#6a9c48' };
}

type HillPlan = {
  count: number;
  r: [number, number];
  h: [number, number];
  west?: number;
  tint: string;
};
function hillPlan(d: SceneryDistrict): HillPlan | null {
  const key = `${d.id} ${d.name}`.toLowerCase();
  if (key.includes('nilgiri')) return { count: 70, r: [4, 9], h: [4, 11], tint: '#3f6e44' };
  // Western Ghats run down the western edge of these districts.
  if (
    /coimbatore|theni|dindigul|tirunelveli|kanniyakumari|virudhunagar|tiruppur|tenkasi/.test(key)
  ) {
    return { count: 26, r: [3, 7], h: [3, 8], west: 0.35, tint: '#4e7d4a' };
  }
  // Eastern Ghats / scattered hills (Shevaroys, Javadhu, Kolli, Yelagiri).
  if (
    /salem|dharmapuri|krishnagiri|vellore|namakkal|tiruvannamalai|erode|tirupattur|kallakurichi/.test(
      key,
    )
  ) {
    return { count: 9, r: [2.5, 5], h: [2, 4.5], tint: '#6b7f4a' };
  }
  return null;
}

/** Trees, palms and hills, placed once per map (deterministic). */
export function Vegetation({
  districts,
  density,
}: {
  districts: SceneryDistrict[];
  density: number;
}) {
  const { trees, palms, hills } = useMemo(() => {
    const treeArr: number[][] = [];
    const palmArr: number[][] = [];
    const hillArr: number[][] = [];
    for (const d of districts) {
      const rand = rngFrom(`veg:${d.id}`);
      const mix = zoneMix(d.zone);
      const areaKm2 = d.polygons.reduce((s, r) => s + polygonArea(r), 0) / 1e6;
      const n = Math.round(areaKm2 * 0.05 * mix.density * density);
      const base = new Color(mix.tint);
      for (const p of scatterInRings(d.polygons, n, rand)) {
        const palm = rand() < mix.palm;
        const h = palm ? 2.2 + rand() * 1.2 : 1.5 + rand() * 1.3;
        tmp
          .copy(base)
          .offsetHSL((rand() - 0.5) * 0.04, (rand() - 0.5) * 0.1, (rand() - 0.5) * 0.12);
        (palm ? palmArr : treeArr).push([
          p.x * KM,
          p.y * KM,
          h,
          rand() * Math.PI * 2,
          tmp.r,
          tmp.g,
          tmp.b,
        ]);
      }
      const plan = hillPlan(d);
      if (plan) {
        const accept = plan.west
          ? (p: MapPointLike, b: { minX: number; maxX: number }) =>
              p.x < b.minX + plan.west! * (b.maxX - b.minX)
          : undefined;
        const hb = new Color(plan.tint);
        for (const p of scatterInRings(d.polygons, plan.count, rand, accept)) {
          const r = plan.r[0] + rand() * (plan.r[1] - plan.r[0]);
          const h = plan.h[0] + rand() * (plan.h[1] - plan.h[0]);
          tmp.copy(hb).offsetHSL(0, 0, (rand() - 0.5) * 0.1);
          hillArr.push([p.x * KM, p.y * KM, r, h, rand() * Math.PI, tmp.r, tmp.g, tmp.b]);
        }
      }
    }
    const fill = (rows: number[][], hill: boolean) => {
      const b = makeBuffers(rows.length, true);
      rows.forEach((row, i) => {
        const [x, z, a, bb, c, r, g, bl] = row as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        dummy.position.set(x, LAND_TOP - 0.05, z);
        if (hill) {
          dummy.rotation.set(0, c, 0);
          dummy.scale.set(a, bb, a * 0.8);
          b.colors!.setXYZ(i, r, g, bl);
        } else {
          dummy.rotation.set(0, bb, 0);
          dummy.scale.set(a, a, a);
          b.colors!.setXYZ(i, c, r, g);
        }
        put(b.matrices.array as Float32Array, i);
      });
      return b;
    };
    return { trees: fill(treeArr, false), palms: fill(palmArr, false), hills: fill(hillArr, true) };
  }, [districts, density]);

  return (
    <group>
      <Prop modelKey="tree1" buffers={trees} geometry={TREE} material={solid} />
      <Prop modelKey="palm" buffers={palms} geometry={PALM} material={solid} />
      <Prop buffers={hills} geometry={HILL} material={solid} />
    </group>
  );
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function sceneBounds(districts: SceneryDistrict[]): Bounds {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const d of districts)
    for (const r of d.polygons)
      for (const p of r) {
        b.minX = Math.min(b.minX, p.x * KM);
        b.maxX = Math.max(b.maxX, p.x * KM);
        b.minZ = Math.min(b.minZ, p.y * KM);
        b.maxZ = Math.max(b.maxZ, p.y * KM);
      }
  return b;
}

const wrap = (v: number, min: number, size: number) => min + ((((v - min) % size) + size) % size);

/** Clouds drifting on the monsoon wind with soft shadows below, plus circling bird flocks. */
export function Sky({ districts, motion }: { districts: SceneryDistrict[]; motion: boolean }) {
  const sys = useMemo(() => {
    const rand = rngFrom('sky');
    const b = sceneBounds(districts);
    const pad = 80;
    const box = {
      x: b.minX - pad,
      z: b.minZ - pad,
      w: b.maxX - b.minX + pad * 2,
      d: b.maxZ - b.minZ + pad * 2,
    };
    const clouds = Array.from({ length: 18 }, () => ({
      x: box.x + rand() * box.w,
      z: box.z + rand() * box.d,
      y: 45 + rand() * 30,
      s: 8 + rand() * 9,
      speed: 2.5 + rand() * 2,
      rot: rand() * Math.PI,
    }));
    const flocks = Array.from({ length: Math.min(7, districts.length) }, (_, f) => {
      const c = districts[Math.floor(rand() * districts.length)]!.centroid;
      return {
        cx: c.x * KM + (rand() - 0.5) * 30,
        cz: c.y * KM + (rand() - 0.5) * 30,
        r: 18 + rand() * 30,
        w: (0.06 + rand() * 0.06) * (f % 2 ? 1 : -1),
        y: 14 + rand() * 8,
        a0: rand() * Math.PI * 2,
        n: 5 + Math.floor(rand() * 5),
      };
    });
    const birdCount = flocks.reduce((s, f) => s + f.n, 0);
    return {
      box,
      clouds,
      flocks,
      cloudBuf: makeBuffers(clouds.length),
      shadowBuf: makeBuffers(clouds.length),
      birdBuf: makeBuffers(birdCount),
    };
  }, [districts]);

  useTick((t) => {
    const { box, clouds, flocks, cloudBuf, shadowBuf, birdBuf } = sys;
    const ca = cloudBuf.matrices.array as Float32Array;
    const sa = shadowBuf.matrices.array as Float32Array;
    clouds.forEach((c, i) => {
      // Wind from the south-west (monsoon), drifting north-east.
      const x = wrap(c.x + c.speed * t, box.x, box.w);
      const z = wrap(c.z - c.speed * 0.35 * t, box.z, box.d);
      dummy.position.set(x, c.y, z);
      dummy.rotation.set(0, c.rot, 0);
      dummy.scale.set(c.s, c.s * 0.7, c.s * 0.8);
      put(ca, i);
      dummy.position.set(x + 6, LAND_TOP + 0.25, z + 3);
      dummy.scale.set(c.s * 1.05, 1, c.s * 0.8);
      put(sa, i);
    });
    const ba = birdBuf.matrices.array as Float32Array;
    let k = 0;
    for (const f of flocks) {
      const a = f.a0 + f.w * t;
      const cx = f.cx + Math.cos(a) * f.r;
      const cz = f.cz + Math.sin(a) * f.r;
      // Tangent of the circle = flight direction.
      const hx = -Math.sin(a) * Math.sign(f.w);
      const hz = Math.cos(a) * Math.sign(f.w);
      const heading = Math.atan2(hx, hz);
      for (let i = 0; i < f.n; i++) {
        const row = Math.ceil(i / 2);
        const side = i % 2 ? 1 : -1;
        const back = row * 1.6;
        const lat = side * row * 1.4;
        // Local (lat, back) → world: right = (hz, -hx), forward = (hx, hz).
        dummy.position.set(
          cx + hz * lat - hx * back,
          f.y + Math.sin(t * 0.8 + i) * 0.4,
          cz - hx * lat - hz * back,
        );
        dummy.rotation.set(0, heading, 0);
        const flap = motion ? Math.sin(t * 9 + i * 0.7) : 0.6;
        dummy.scale.set(2.4, 2.4 * flap, 2.4);
        put(ba, k++);
      }
    }
    cloudBuf.matrices.needsUpdate = true;
    shadowBuf.matrices.needsUpdate = true;
    birdBuf.matrices.needsUpdate = true;
  }, motion);

  return (
    <group>
      <Prop buffers={sys.shadowBuf} geometry={DISC} material={shadowMat} />
      <Prop buffers={sys.cloudBuf} geometry={CLOUD} material={cloudMat} />
      <Prop buffers={sys.birdBuf} geometry={BIRD} material={birdMat} />
    </group>
  );
}

const TRUCK_COLORS = ['#f2b134', '#d9482b', '#2f7fb8', '#3f9a4f', '#e86f2d', '#f4ead8'];

/** Lorries and carts trundling along the highways between mandis (driving on the left). */
export function Traffic({ roads, motion }: { roads: MapPointLike[][]; motion: boolean }) {
  const sys = useMemo(() => {
    const rand = rngFrom('traffic');
    const lines = roads
      .map((r) => {
        const pts = r.map((p) => ({ x: p.x * KM, y: p.y * KM }));
        const cum = polylineCumulative(pts);
        return { pts, cum, len: cum[cum.length - 1] ?? 0 };
      })
      .filter((l) => l.len > 20);
    const total = lines.reduce((s, l) => s + l.len, 0);
    const n = Math.min(48, Math.round(total / 22));
    const trucks = Array.from({ length: n }, () => {
      let pick = rand() * total;
      const line = lines.find((l) => (pick -= l.len) <= 0) ?? lines[lines.length - 1]!;
      return { line, s0: rand() * line.len * 2, speed: 4 + rand() * 4 };
    });
    const buf = makeBuffers(trucks.length, true);
    trucks.forEach((_, i) => {
      tmp.set(TRUCK_COLORS[i % TRUCK_COLORS.length]!);
      buf.colors!.setXYZ(i, tmp.r, tmp.g, tmp.b);
    });
    return { trucks, buf };
  }, [roads]);

  useTick((t) => {
    const arr = sys.buf.matrices.array as Float32Array;
    sys.trucks.forEach((tr, i) => {
      const { pts, cum, len } = tr.line;
      // Ping-pong along the road: out on one lap, back on the next.
      const d = (tr.s0 + tr.speed * t) % (len * 2);
      const back = d > len;
      const p = pointAlong(pts, cum, back ? len * 2 - d : d);
      const dx = Math.cos(p.angle) * (back ? -1 : 1);
      const dz = Math.sin(p.angle) * (back ? -1 : 1);
      dummy.position.set(p.x + dz * 0.7, LAND_TOP + 0.1, p.y - dx * 0.7);
      dummy.rotation.set(0, Math.atan2(-dz, dx), 0);
      dummy.scale.set(2.6, 2.6, 2.6);
      put(arr, i);
    });
    sys.buf.matrices.needsUpdate = true;
  }, motion);

  return <Prop modelKey="truck" buffers={sys.buf} geometry={TRUCK} material={solid} castShadow />;
}

/**
 * Coastal points in the sea next to Tamil Nadu.
 * shortcut: "is this the TN coast" is a fixed east/south box test (other states aren't drawn);
 * upgrade to a real coastline polyline if the map ever shows neighbours.
 */
function coastalPoints(
  districts: SceneryDistrict[],
  n: number,
  rand: () => number,
  maxOff: number,
) {
  const rings = districts.flatMap((d) => d.polygons);
  const verts = rings.flat();
  const out: [number, number][] = [];
  for (let tries = 0; out.length < n && tries < n * 60 && verts.length; tries++) {
    const v = verts[Math.floor(rand() * verts.length)]!;
    const a = rand() * Math.PI * 2;
    const off = (4 + rand() * maxOff) / KM;
    const x = v.x + Math.cos(a) * off;
    const y = v.y + Math.sin(a) * off;
    const sx = x * KM;
    const sz = y * KM;
    const coast = (sx > 120 && sz > -290) || (sz > 120 && sx > -90);
    if (!coast || rings.some((r) => pointInPolygon({ x, y }, r))) continue;
    out.push([sx, sz]);
  }
  return out;
}

/** Kattumaram boats bobbing off the coast and sunlight glinting on the Bay of Bengal. */
export function Coast({ districts, motion }: { districts: SceneryDistrict[]; motion: boolean }) {
  const sys = useMemo(() => {
    const rand = rngFrom('coast');
    const boats = coastalPoints(districts, 22, rand, 22).map(([x, z]) => ({
      x,
      z,
      r: 2 + rand() * 4,
      w: (0.05 + rand() * 0.08) * (rand() < 0.5 ? 1 : -1),
      a0: rand() * Math.PI * 2,
    }));
    const glints = coastalPoints(districts, 320, rand, 60).map(([x, z]) => ({
      x,
      z,
      p: rand() * Math.PI * 2,
      f: 0.8 + rand() * 1.4,
      rot: rand() * Math.PI,
    }));
    return {
      boats,
      glints,
      boatBuf: makeBuffers(boats.length),
      glintBuf: makeBuffers(glints.length),
    };
  }, [districts]);

  useTick((t) => {
    const ba = sys.boatBuf.matrices.array as Float32Array;
    sys.boats.forEach((b, i) => {
      const a = b.a0 + b.w * t;
      dummy.position.set(
        b.x + Math.cos(a) * b.r,
        SEA_LEVEL + 0.05 + Math.sin(t * 1.6 + i) * 0.08,
        b.z + Math.sin(a) * b.r,
      );
      const hx = -Math.sin(a) * Math.sign(b.w);
      const hz = Math.cos(a) * Math.sign(b.w);
      dummy.rotation.set(Math.sin(t * 1.3 + i) * 0.08, Math.atan2(-hz, hx), 0);
      dummy.scale.set(3.6, 3.6, 3.6);
      put(ba, i);
    });
    const ga = sys.glintBuf.matrices.array as Float32Array;
    sys.glints.forEach((g, i) => {
      const s = motion ? Math.max(0, Math.sin(t * g.f + g.p)) ** 6 * 1.3 : 0.5;
      dummy.position.set(g.x, SEA_LEVEL + 0.02, g.z);
      dummy.rotation.set(0, g.rot, 0);
      dummy.scale.set(s, s, s);
      put(ga, i);
    });
    sys.boatBuf.matrices.needsUpdate = true;
    sys.glintBuf.matrices.needsUpdate = true;
  }, motion);

  return (
    <group>
      <Prop modelKey="boat" buffers={sys.boatBuf} geometry={BOAT} material={solid} />
      <Prop buffers={sys.glintBuf} geometry={GLINT} material={glintMat} />
    </group>
  );
}

/** River line with a lighter dashed overlay whose dashes travel downstream. */
export function RiverFlow({ river, motion }: { river: MapPointLike[]; motion: boolean }) {
  const points = useMemo(() => river.map((p) => toScene(p, LAND_TOP + 0.1)), [river]);
  const flowRef = useRef<{ material: { dashOffset: number } } | null>(null);
  // The Cauvery flows west → east: move dashes towards whichever end is further east.
  const dir = river.length > 1 && river[river.length - 1]!.x > river[0]!.x ? -1 : 1;
  useTick((_, dt) => {
    if (flowRef.current) flowRef.current.material.dashOffset += dir * dt * 5;
  }, motion);
  if (river.length < 2) return null;
  return (
    <group>
      <Line points={points} color={RIVER} lineWidth={4} />
      <Line
        ref={flowRef as never}
        points={points.map(([x, , z]) => [x, LAND_TOP + 0.13, z] as [number, number, number])}
        color="#d6f0ff"
        lineWidth={2}
        dashed
        dashSize={2.5}
        gapSize={5}
        transparent
        opacity={0.85}
      />
    </group>
  );
}
