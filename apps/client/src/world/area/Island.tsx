/**
 * The area as a Tiny Swords-style island: the segment outline is a grass plateau with stone
 * cliffs standing in teal water, ringed by breathing foam, with small islets and rocks offshore.
 */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  CanvasTexture,
  type Group,
  type MeshBasicMaterial,
  RepeatWrapping,
  Shape,
  SRGBColorSpace,
  Vector2,
} from 'three';
import type { Pt } from '../../lib/geometry';
import { rngFrom } from '../../lib/random';
import { Instanced, type Item } from './Instanced';
import { AREA_RADIUS } from './layout';

export const WATER = '#47aba9';
const FOAM = '#e9fbf4';
const CLIFF = '#7d8796';
/** Top of the grass; plots and props stand on it. */
export const GROUND_Y = 0.3;
const WATER_Y = -1.4;
const CLIFF_DEPTH = 3.4;
/** Islets sit a little lower than the main island. */
const ISLET_TOP = GROUND_Y - 0.45;

const shapeOf = (outline: readonly Pt[], k = 1) =>
  new Shape(outline.map((p) => new Vector2(p.x * k, -p.y * k)));

/** Stone blocks: vertical joints and a darker band at the waterline. */
function cliffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#c9ced8';
  for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 3, 64);
  g.fillStyle = '#e8ebf0';
  for (let x = 6; x < 64; x += 16) g.fillRect(x, 0, 4, 64);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(0.25, 0.3);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export function Island({ outline, grass }: { outline: Pt[]; grass: string }) {
  const { body, lip } = useMemo(
    () => ({ body: shapeOf(outline), lip: shapeOf(outline, 1.012) }),
    [outline],
  );
  const stone = useMemo(cliffTexture, []);
  return (
    <>
      {/* group 0 = top/bottom caps (grass), group 1 = sides (cliff) */}
      <mesh rotation-x={-Math.PI / 2} position-y={GROUND_Y - CLIFF_DEPTH} receiveShadow castShadow>
        <extrudeGeometry args={[body, { depth: CLIFF_DEPTH, bevelEnabled: false }]} />
        <meshStandardMaterial attach="material-0" color={grass} roughness={1} />
        <meshStandardMaterial attach="material-1" color={CLIFF} map={stone} roughness={1} />
      </mesh>
      {/* the grass overhang along the cliff edge */}
      <mesh rotation-x={-Math.PI / 2} position-y={GROUND_Y - 0.55}>
        <extrudeGeometry args={[lip, { depth: 0.54, bevelEnabled: false }]} />
        <meshStandardMaterial color={grass} roughness={1} />
      </mesh>
      <Water />
      <Foam shape={outline} />
    </>
  );
}

function Water() {
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={WATER_Y} receiveShadow>
      <planeGeometry args={[AREA_RADIUS * 16, AREA_RADIUS * 16]} />
      <meshStandardMaterial color={WATER} roughness={0.55} />
    </mesh>
  );
}

/** White band at the waterline that swells and fades like surf. */
function Foam({ shape }: { shape: Pt[] }) {
  const geo = useMemo(() => shapeOf(shape, 1.05), [shape]);
  const ref = useRef<Group>(null);
  const mat = useRef<MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    ref.current?.scale.setScalar(1 + Math.sin(t * 1.4) * 0.012);
    if (mat.current) mat.current.opacity = 0.55 + Math.sin(t * 1.4) * 0.2;
  });
  return (
    <group ref={ref}>
      <mesh rotation-x={-Math.PI / 2} position-y={WATER_Y + 0.05}>
        <shapeGeometry args={[geo]} />
        <meshBasicMaterial ref={mat} color={FOAM} transparent depthWrite={false} />
      </mesh>
    </group>
  );
}

interface Islet {
  x: number;
  z: number;
  r: number;
}

/** Little islets and surf-washed rocks around the main island, each with its own foam. */
export function Offshore({ seed, trees }: { seed: string; trees: string[] }) {
  const { islets, rocks, flora } = useMemo(() => {
    const rnd = rngFrom('offshore', seed);
    const islets: Islet[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + rnd() * 0.6;
      const d = AREA_RADIUS * (1.32 + rnd() * 0.35);
      islets.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: 5 + rnd() * 6 });
    }
    const rocks: Item[] = Array.from({ length: 12 }, () => {
      const a = rnd() * Math.PI * 2;
      const d = AREA_RADIUS * (1.12 + rnd() * 0.7);
      return {
        x: Math.cos(a) * d,
        z: Math.sin(a) * d,
        y: WATER_Y - 0.3,
        s: 2 + rnd() * 2.5,
        ry: rnd() * 6,
      };
    });
    const flora = new Map<string, Item[]>();
    const add = (m: string, it: Item) => flora.set(m, [...(flora.get(m) ?? []), it]);
    for (const isl of islets) {
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const a = rnd() * Math.PI * 2;
        const d = rnd() * isl.r * 0.5;
        add(trees[k % trees.length]!, {
          x: isl.x + Math.cos(a) * d,
          z: isl.z + Math.sin(a) * d,
          y: ISLET_TOP,
          s: 6 + rnd() * 5,
          ry: rnd() * 6,
        });
      }
      add('bush', { x: isl.x + isl.r * 0.4, z: isl.z, y: ISLET_TOP, s: 1.8, ry: rnd() * 6 });
    }
    return { islets, rocks, flora: [...flora] };
  }, [seed, trees]);

  const foam = useRef<Group>(null);
  useFrame(({ clock }) => {
    foam.current?.children.forEach((c, i) => {
      c.scale.setScalar(1 + Math.sin(clock.elapsedTime * 1.4 + i) * 0.06);
    });
  });

  return (
    <>
      {islets.map((isl, i) => (
        <group key={i} position={[isl.x, 0, isl.z]}>
          <mesh position-y={ISLET_TOP - 0.3 - CLIFF_DEPTH / 2} castShadow receiveShadow>
            <cylinderGeometry args={[isl.r, isl.r * 1.06, CLIFF_DEPTH, 9]} />
            <meshStandardMaterial color={CLIFF} roughness={1} flatShading />
          </mesh>
          <mesh position-y={ISLET_TOP - 0.15} receiveShadow>
            <cylinderGeometry args={[isl.r * 1.02, isl.r * 1.02, 0.3, 9]} />
            <meshStandardMaterial color="#79b84a" roughness={1} flatShading />
          </mesh>
        </group>
      ))}
      <group ref={foam}>
        {[
          ...islets.map((i) => ({ x: i.x, z: i.z, r: i.r * 1.25 })),
          ...rocks.map((r) => ({ x: r.x, z: r.z, r: r.s * 0.75 })),
        ].map((f, i) => (
          <mesh key={i} position={[f.x, WATER_Y + 0.04, f.z]} rotation-x={-Math.PI / 2}>
            <circleGeometry args={[f.r, 18]} />
            <meshBasicMaterial color={FOAM} transparent opacity={0.6} depthWrite={false} />
          </mesh>
        ))}
      </group>
      <Instanced model="rock" items={rocks} />
      {flora.map(([model, items]) => (
        <Instanced key={model} model={model} items={items} sway={model === 'bush' ? 0 : 0.02} />
      ))}
    </>
  );
}
