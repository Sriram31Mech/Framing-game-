/**
 * Close-up 3D scene of one map segment, styled like a Tiny Swords island: the outline is a grass
 * plateau with stone cliffs in teal water (Island.tsx), every holding a tilled plot showing its
 * state (for sale, yours, growing, ready, other farmers'), and a little life — a farmer walking
 * the fields, a tractor on the farm track, grazing cattle, bouncing sheep, birds, a channel.
 * Lazy-loaded; clicking a plot opens the land inspector so the game is playable from here.
 */
import type { SegmentDetailResponse } from '@bh/contracts';
import { Edges, Html, OrbitControls, useAnimations, useGLTF } from '@react-three/drei';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import {
  Box3,
  CanvasTexture,
  type Group,
  type Mesh,
  type MeshStandardMaterial,
  NoToneMapping,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useCompanyId, useSegment } from '../../api/queries';
import { ErrorBoundary } from '../../app/ErrorBoundary';
import { CROP_META } from '../../lib/cropMeta';
import { formatHa, moneyCompact } from '../../lib/format';
import type { Pt } from '../../lib/geometry';
import { rngFrom } from '../../lib/random';
import { useUiStore } from '../../store/ui';
import { Instanced, modelUrl, type Animate, type Item } from './Instanced';
import { GROUND_Y, Island, Offshore, WATER } from './Island';
import { AREA_RADIUS, biomeFor, normalizeOutline, plotCells, scatter, type Biome } from './layout';
import { CROP_LOOK } from './props';

type Holding = SegmentDetailResponse['holdings'][number];
type Kind = 'mine' | 'sale' | 'ai' | 'other' | 'reserved';

const LOOK: Record<
  Biome,
  {
    ground: string;
    trees: string[];
    deco: string;
    animal: string;
    trackColor: string;
  }
> = {
  hills: {
    ground: '#62b44a',
    trees: ['pine', 'pine', 'tree2'],
    deco: 'bush',
    animal: 'cow',
    trackColor: '#d6b77e',
  },
  delta: {
    ground: '#78c44a',
    trees: ['palm', 'palm', 'tree1'],
    deco: 'grass',
    animal: 'cow',
    trackColor: '#dcc08a',
  },
  dry: {
    ground: '#9cc04e',
    trees: ['acacia', 'acacia', 'tree1'],
    deco: 'rock',
    animal: 'goat',
    trackColor: '#d39a62',
  },
  plain: {
    ground: '#86c24c',
    trees: ['tree1', 'treeCube', 'palm'],
    deco: 'bush2',
    animal: 'cow',
    trackColor: '#dcc08a',
  },
};

const SOIL: Record<string, string> = {
  sandy: '#d9b77a',
  sandy_loam: '#c4925a',
  loam: '#9a6a3e',
  clay_loam: '#7d5536',
  clay: '#5e4433',
  laterite: '#b4553a',
};

const KIND_COLOR: Record<Kind, string> = {
  mine: '#d86f12',
  sale: '#2e8b47',
  ai: '#7a52c7',
  other: '#2f6fb8',
  reserved: '#8a8478',
};

// High three-quarter view, like a strategy game board.
const START: [number, number, number] = [0, 230, 120];
const END: [number, number, number] = [0, 92, 66];

function CameraRig() {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const t0 = useRef<number | null>(null);
  useFrame(({ camera, clock }) => {
    t0.current ??= clock.elapsedTime;
    const k = Math.min(1, (clock.elapsedTime - t0.current) / 1.8);
    if (k < 1) {
      const e = 1 - (1 - k) ** 3;
      camera.position.set(
        START[0] + (END[0] - START[0]) * e,
        START[1] + (END[1] - START[1]) * e,
        START[2] + (END[2] - START[2]) * e,
      );
      camera.lookAt(0, 0, 0);
    }
    const target = controls.current?.target;
    if (target && target.length() > AREA_RADIUS) target.setLength(AREA_RADIUS);
  });
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      zoomToCursor
      minDistance={24}
      maxDistance={220}
      maxPolarAngle={1.1}
    />
  );
}

function Mist() {
  const group = useRef<Group>(null);
  useFrame(({ clock }) => {
    group.current?.children.forEach((c, i) => {
      c.position.x = Math.sin(clock.elapsedTime * 0.05 + i * 1.7) * AREA_RADIUS;
    });
  });
  return (
    <group ref={group}>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[0, 9 + i * 3, -40 + i * 25]} scale={[38, 4, 18]}>
          <sphereGeometry args={[1, 12, 8]} />
          <meshBasicMaterial
            color="#ffffff"
            transparent
            opacity={0.22}
            depthWrite={false}
            fog={false}
          />
        </mesh>
      ))}
    </group>
  );
}

interface PlotInfo {
  h: Holding;
  kind: Kind;
  x: number;
  z: number;
  side: number;
}

function Fence({ side, color }: { side: number; color: string }) {
  const mat = useRef<MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (mat.current) mat.current.emissiveIntensity = 0.35 + Math.sin(clock.elapsedTime * 3) * 0.25;
  });
  const half = side / 2 + 0.3;
  const rails: [number, number, number, number][] = [
    [0, -half, side + 0.6, 0.12],
    [0, half, side + 0.6, 0.12],
    [-half, 0, 0.12, side + 0.6],
    [half, 0, 0.12, side + 0.6],
  ];
  return (
    <group>
      {rails.map(([x, z, w, d], i) => (
        <mesh key={i} position={[x, 0.9, z]} castShadow>
          <boxGeometry args={[w, 0.14, d]} />
          <meshStandardMaterial
            ref={i === 0 ? mat : undefined}
            color={color}
            emissive={color}
            emissiveIntensity={0.4}
          />
        </mesh>
      ))}
      {[-half, 0, half].flatMap((x) =>
        [-half, half].map((z) => (
          <mesh key={`${x}:${z}`} position={[x, 0.55, z]} castShadow>
            <boxGeometry args={[0.2, 1.1, 0.2]} />
            <meshStandardMaterial color="#7a5230" />
          </mesh>
        )),
      )}
    </group>
  );
}

function SaleSign({ side, price }: { side: number; price: string }) {
  const flag = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (flag.current) flag.current.rotation.y = Math.sin(clock.elapsedTime * 4) * 0.35;
  });
  const p = -side / 2 + 0.8;
  return (
    <group position={[p, 0, p]}>
      <mesh position={[0, 1.6, 0]} castShadow>
        <cylinderGeometry args={[0.09, 0.09, 3.2, 6]} />
        <meshStandardMaterial color="#7a5230" />
      </mesh>
      <mesh position={[0.9, 1.6, 0]} castShadow>
        <boxGeometry args={[1.8, 0.9, 0.08]} />
        <meshStandardMaterial color="#f5e7c4" />
      </mesh>
      <group ref={flag} position={[0, 3.1, 0]}>
        <mesh position={[0.55, 0, 0]}>
          <planeGeometry args={[1.1, 0.6]} />
          <meshStandardMaterial color={KIND_COLOR.sale} side={2} />
        </mesh>
      </group>
      <Html center position={[0.9, 4, 0]} distanceFactor={90} zIndexRange={[20, 0]}>
        <div className="area-tag area-tag-sale">{price}</div>
      </Html>
    </group>
  );
}

function Banner({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 1.2, 0]}>
        <cylinderGeometry args={[0.06, 0.06, 2.4, 5]} />
        <meshStandardMaterial color="#6b4a2c" />
      </mesh>
      <mesh position={[0.35, 2.1, 0]}>
        <boxGeometry args={[0.7, 0.45, 0.04]} />
        <meshStandardMaterial color={color} />
      </mesh>
    </group>
  );
}

function HarvestIcon() {
  const ref = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.position.y = 4.2 + Math.abs(Math.sin(clock.elapsedTime * 3)) * 1.2;
    ref.current.rotation.y = clock.elapsedTime * 1.5;
  });
  return (
    <group ref={ref}>
      <mesh castShadow>
        <octahedronGeometry args={[0.7, 0]} />
        <meshStandardMaterial
          color="#f2c14e"
          emissive="#f2a81e"
          emissiveIntensity={0.6}
          metalness={0.3}
        />
      </mesh>
    </group>
  );
}

function Ring({ value }: { value: number }) {
  const c = 2 * Math.PI * 13;
  return (
    <svg viewBox="0 0 32 32" className="area-ring" aria-hidden="true">
      <circle cx="16" cy="16" r="13" />
      <circle
        cx="16"
        cy="16"
        r="13"
        strokeDasharray={`${c * value} ${c}`}
        transform="rotate(-90 16 16)"
      />
    </svg>
  );
}

/** Floating chip over the player's own plots: crop + progress, or a call to action. */
function MyChip({ h }: { h: Holding }) {
  const crop = h.crop;
  const ui = useUiStore.getState;
  const label = !crop
    ? 'Plant'
    : crop.status === 'ready'
      ? 'Harvest!'
      : crop.status === 'failed'
        ? 'Failed'
        : `${Math.round(crop.progress * 100)}%`;
  return (
    <button
      type="button"
      className={`area-chip${crop?.status === 'ready' ? ' area-chip-ready' : ''}${crop ? '' : ' area-chip-plant'}`}
      onClick={() => (crop ? ui().selectParcel(h.id) : ui().openPlant(h.id))}
      data-testid={`area-chip-${h.id}`}
      title={crop ? CROP_META[crop.cropId].label : 'Plant a crop here'}
    >
      {crop ? (
        <>
          <span className="area-chip-dot" style={{ background: CROP_META[crop.cropId].swatch }} />
          <Ring value={crop.status === 'growing' ? crop.progress : 1} />
        </>
      ) : (
        <span aria-hidden="true">+</span>
      )}
      <span>{label}</span>
    </button>
  );
}

/** Tilled-soil furrows, tinted per plot by the material colour. */
let furrows: CanvasTexture | null = null;
function furrowTexture() {
  if (furrows) return furrows;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = '#8c8174';
  for (let y = 0; y < 32; y += 8) g.fillRect(0, y, 32, 3);
  furrows = new CanvasTexture(c);
  furrows.wrapS = furrows.wrapT = RepeatWrapping;
  furrows.colorSpace = SRGBColorSpace;
  return furrows;
}

function Plot({
  p,
  hovered,
  onHover,
}: {
  p: PlotInfo;
  hovered: boolean;
  onHover: (id: string | null) => void;
}) {
  const { h, kind, side } = p;
  const soil = SOIL[h.soilTexture] ?? '#8f6a45';
  const flooded = h.crop?.cropId === 'rice' && h.crop.status === 'growing';
  // Land for sale lies fallow (grassy); worked land shows its tilled soil.
  const fallow = kind === 'sale' && !h.crop;
  const color = flooded ? '#5f9fa0' : fallow ? '#b4d36e' : soil;
  const map = useMemo(() => {
    const t = furrowTexture().clone();
    t.repeat.set(1, Math.max(2, Math.round(side / 1.6)));
    t.needsUpdate = true;
    return t;
  }, [side]);
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    useUiStore.getState().selectParcel(h.id);
  };
  return (
    <group position={[p.x, GROUND_Y, p.z]}>
      <mesh
        position-y={0.18}
        castShadow
        receiveShadow
        onClick={click}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHover(h.id);
        }}
        onPointerOut={() => onHover(null)}
      >
        <boxGeometry args={[side, 0.36, side]} />
        <meshStandardMaterial
          color={color}
          map={flooded || fallow ? null : map}
          roughness={flooded ? 0.35 : 1}
          emissive={hovered ? '#ffb35c' : '#000000'}
          emissiveIntensity={hovered ? 0.35 : 0}
        />
        <Edges color="#2a2638" threshold={30} />
      </mesh>
      {kind === 'mine' ? <Fence side={side} color={KIND_COLOR.mine} /> : null}
      {kind === 'sale' ? (
        <SaleSign side={side} price={moneyCompact(h.listPricePaise ?? h.basePricePaise)} />
      ) : null}
      {kind === 'ai' || kind === 'other' ? (
        <group position={[-side / 2 + 0.5, 0, -side / 2 + 0.5]}>
          <Banner color={KIND_COLOR[kind]} />
        </group>
      ) : null}
      {h.crop?.status === 'ready' ? <HarvestIcon /> : null}
      {kind === 'mine' ? (
        <Html center position={[0, 7, 0]} distanceFactor={90} zIndexRange={[20, 0]}>
          <MyChip h={h} />
        </Html>
      ) : null}
      {hovered ? (
        <Html
          center
          position={[0, 2.5, side / 2 + 1]}
          zIndexRange={[21, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="area-tag">
            <strong>{formatHa(h.areaHa)}</strong>{' '}
            {kind === 'mine'
              ? 'Your plot'
              : kind === 'sale'
                ? 'For sale'
                : kind === 'reserved'
                  ? 'Starter plot'
                  : `${h.ownerName ?? 'Leased'}${kind === 'ai' ? ' (AI)' : ''}`}
            {h.crop ? ` · ${CROP_META[h.crop.cropId].label}` : ''}
          </div>
        </Html>
      ) : null}
    </group>
  );
}

/** Instanced crops across all plots, one batch per model; height follows growth progress. */
function Crops({ plots }: { plots: PlotInfo[] }) {
  const byModel = useMemo(() => {
    const out = new Map<string, Item[]>();
    for (const p of plots) {
      const crop = p.h.crop;
      if (!crop) continue;
      const look = CROP_LOOK[crop.cropId];
      const rnd = rngFrom('crop', p.h.id);
      const k = Math.max(3, Math.floor(p.side / 1.7));
      const step = (p.side - 1) / k;
      const height =
        look.height *
        (crop.status === 'growing' ? 0.2 + 0.8 * crop.progress : 1) *
        (crop.status === 'failed' ? 0.55 : 1);
      const color =
        crop.status === 'ready' ? '#f2c14e' : crop.status === 'failed' ? '#8a6a43' : undefined;
      const list = out.get(look.model) ?? [];
      for (let i = 0; i < k; i++)
        for (let j = 0; j < k; j++)
          list.push({
            x: p.x - p.side / 2 + 0.5 + step * (i + 0.5) + (rnd() - 0.5) * 0.3,
            y: GROUND_Y + 0.36,
            z: p.z - p.side / 2 + 0.5 + step * (j + 0.5) + (rnd() - 0.5) * 0.3,
            s: height * (0.85 + rnd() * 0.3),
            ry: rnd() * Math.PI * 2,
            phase: p.x * 0.3 + p.z * 0.2 + rnd(),
            color,
          });
      out.set(look.model, list);
    }
    return [...out];
  }, [plots]);
  return (
    <>
      {byModel.map(([model, items]) => (
        <Instanced key={model} model={model} items={items} sway={0.12} />
      ))}
    </>
  );
}

function Scenery({
  outline,
  cells,
  size,
  biome,
  seed,
}: {
  outline: Pt[];
  cells: Pt[];
  size: number;
  biome: Biome;
  seed: string;
}) {
  const look = LOOK[biome];
  const groups = useMemo(() => {
    const rnd = rngFrom('scenery', seed);
    const out = new Map<string, Item[]>();
    const add = (model: string, it: Item) => out.set(model, [...(out.get(model) ?? []), it]);
    const inside = scatter(outline, cells, size, biome === 'hills' ? 70 : 45, seed);
    // Ground cover: tufts, bushes and flowers so the grass between fields feels alive.
    scatter(outline, cells, size, 140, `${seed}-cover`).forEach((p, i) =>
      add(i % 7 === 0 ? 'flowers' : i % 3 === 0 ? 'bush2' : 'grass', {
        x: p.x,
        z: p.y,
        y: GROUND_Y,
        s: i % 3 === 0 ? 1.3 + rnd() * 0.8 : 0.9 + rnd() * 0.6,
        ry: rnd() * 6,
      }),
    );
    const [home, well] = inside.splice(0, 2);
    if (home) add('farmhouse', { x: home.x, z: home.y, y: GROUND_Y, s: 8, ry: rnd() * 6 });
    if (well) add('well', { x: well.x, z: well.y, y: GROUND_Y, s: 2.4 });
    inside.forEach((p, i) => {
      const deco = i % 3 !== 0 || biome === 'hills';
      if (deco && i % 2 === 0)
        add(look.trees[i % look.trees.length]!, {
          x: p.x,
          z: p.y,
          y: GROUND_Y,
          s: 6 + rnd() * 4,
          ry: rnd() * 6,
        });
      else
        add(look.deco, {
          x: p.x,
          z: p.y,
          y: GROUND_Y,
          s: look.deco === 'rock' ? 1.5 + rnd() * 2 : 1.4 + rnd(),
          ry: rnd() * 6,
        });
    });
    return [...out];
  }, [outline, cells, size, biome, seed, look]);
  return (
    <>
      {groups.map(([model, items]) => (
        <Instanced
          key={model}
          model={model}
          items={items}
          sway={look.trees.includes(model) ? 0.02 : 0}
        />
      ))}
    </>
  );
}

function Animals({
  outline,
  cells,
  size,
  biome,
  seed,
}: {
  outline: Pt[];
  cells: Pt[];
  size: number;
  biome: Biome;
  seed: string;
}) {
  const { herd, flock } = useMemo(() => {
    const pts = scatter(outline, cells, size, 8, `${seed}-animals`);
    return {
      herd: pts.slice(0, 4).map((p, i) => ({
        x: p.x,
        z: p.y,
        phase: i * 2.1,
        // every farm keeps a few sheep (the goat model is a sheep); cattle or goats lead
        model: i < 2 || biome === 'dry' ? LOOK[biome].animal : 'goat',
      })),
      flock: pts.slice(4).flatMap((p, i) =>
        [0, 1, 2].map((k) => ({
          x: p.x + k * 0.9,
          z: p.y + (k % 2) * 0.8,
          y: 0.3,
          s: 0.7,
          phase: i * 3 + k,
        })),
      ),
    };
  }, [outline, cells, size, seed, biome]);
  const peck: Animate = (i, t, o) => {
    const ph = flock[i]?.phase ?? 0;
    o.position.x += Math.sin(t * 0.5 + ph) * 0.8;
    o.rotation.y = t * 0.5 + ph;
    o.rotation.z = Math.max(0, Math.sin(t * 5 + ph)) * 0.5;
  };
  const birds = useMemo(
    () => [0, 1, 2, 3, 4].map((i) => ({ x: 0, z: 0, y: 26, s: 1.4, phase: i })),
    [],
  );
  const fly: Animate = (i, t, o) => {
    const a = t * 0.25 + i * 0.35;
    const r = 35 + i * 3;
    o.position.set(Math.cos(a) * r, 24 + i * 1.5 + Math.sin(t * 2 + i) * 0.6, Math.sin(a) * r);
    o.rotation.set(0, -a, 0);
    o.scale.y *= 0.6 + Math.abs(Math.sin(t * 8 + i)) * 0.8; // wing flap
  };
  return (
    <>
      {herd.map((h, i) => (
        <Grazer key={i} {...h} />
      ))}
      <Instanced model="chicken" items={flock} animate={peck} />
      <Instanced model="bird" items={birds} animate={fly} />
    </>
  );
}

/** Rectangle around the plot block: the farm track the tractor drives. */
function blockRect(cells: Pt[], size: number) {
  const pad = size / 2 + 2.2;
  const xs = cells.map((c) => c.x);
  const zs = cells.map((c) => c.y);
  return {
    x0: Math.min(...xs) - pad,
    x1: Math.max(...xs) + pad,
    z0: Math.min(...zs) - pad,
    z1: Math.max(...zs) + pad,
  };
}

function Track({ rect, look }: { rect: ReturnType<typeof blockRect>; look: (typeof LOOK)[Biome] }) {
  const { x0, x1, z0, z1 } = rect;
  const w = x1 - x0;
  const d = z1 - z0;
  const strips: [number, number, number, number][] = [
    [(x0 + x1) / 2, z0, w + 1.4, 1.4],
    [(x0 + x1) / 2, z1, w + 1.4, 1.4],
    [x0, (z0 + z1) / 2, 1.4, d],
    [x1, (z0 + z1) / 2, 1.4, d],
  ];
  return (
    <>
      {strips.map(([x, z, sw, sd], i) => (
        <mesh key={i} position={[x, 0.32, z]} rotation-x={-Math.PI / 2} receiveShadow>
          <planeGeometry args={[sw, sd]} />
          <meshStandardMaterial color={look.trackColor} roughness={1} />
        </mesh>
      ))}
    </>
  );
}

function Tractor({ rect }: { rect: ReturnType<typeof blockRect> }) {
  const items = useMemo(() => [{ x: 0, z: 0, y: 0.3, s: 3.2 }], []);
  const drive: Animate = (_i, t, o) => {
    const { x0, x1, z0, z1 } = rect;
    const w = x1 - x0;
    const d = z1 - z0;
    let u = (t * 5) % (2 * (w + d));
    let x: number, z: number, ry: number;
    if (u < w) [x, z, ry] = [x0 + u, z1, 0];
    else if ((u -= w) < d) [x, z, ry] = [x1, z1 - u, Math.PI / 2];
    else if ((u -= d) < w) [x, z, ry] = [x1 - u, z0, Math.PI];
    else [x, z, ry] = [x0, z0 + (u - w), -Math.PI / 2];
    o.position.set(x, 0.3 + Math.abs(Math.sin(t * 9)) * 0.05, z);
    o.rotation.set(0, ry, 0);
  };
  return <Instanced model="tractor" items={items} animate={drive} />;
}

function Channel({ rect }: { rect: ReturnType<typeof blockRect> }) {
  const mat = useRef<MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (mat.current) mat.current.emissiveIntensity = 0.25 + Math.sin(clock.elapsedTime * 2) * 0.1;
  });
  return (
    <mesh position={[(rect.x0 + rect.x1) / 2, 0.33, rect.z1 + 2.2]} rotation-x={-Math.PI / 2}>
      <planeGeometry args={[rect.x1 - rect.x0 + 2, 1.6]} />
      <meshStandardMaterial
        ref={mat}
        color="#3b8fc4"
        emissive="#5fb4e8"
        roughness={0.15}
        metalness={0.2}
      />
    </mesh>
  );
}

// Characters read a little larger than life so they are visible from the board view.
const FARMER_HEIGHT = 3.4;

/** One animated glTF character (skinned, so cloned per use); walks or idles per `moving`. */
function GltfActor({
  url,
  height,
  moving,
}: {
  url: string;
  height: number;
  moving: { current: boolean };
}) {
  const { scene, animations } = useGLTF(url);
  const ref = useRef<Group>(null);
  const model = useMemo(() => {
    const m = cloneSkinned(scene);
    const box = new Box3().setFromObject(m);
    m.scale.setScalar(height / Math.max(box.max.y - box.min.y, 1e-6));
    return m;
  }, [scene, height]);
  const { actions, names } = useAnimations(animations, ref);
  const current = useRef<string | undefined>(undefined);
  useFrame(() => {
    const want =
      (moving.current
        ? (names.find((n) => /walk$/i.test(n)) ?? names.find((n) => /jump$/i.test(n)))
        : names.find((n) => /idle$/i.test(n))) ?? names[0];
    if (want === current.current) return;
    if (current.current) actions[current.current]?.fadeOut(0.3);
    if (want) actions[want]?.reset().fadeIn(0.3).play();
    current.current = want;
  });
  return (
    // glTF characters face +z; the movers steer a +x-facing body
    <group ref={ref} rotation-y={Math.PI / 2}>
      <primitive object={model} />
    </group>
  );
}

/** Animated model when available, else a static primitive of the same size. */
function Actor({
  model,
  height,
  moving,
}: {
  model: string;
  height: number;
  moving: { current: boolean };
}) {
  const items = useMemo(() => [{ x: 0, z: 0, s: height }], [height]);
  const url = modelUrl(model);
  const fallback = <Instanced model={model} items={items} />;
  if (!url) return fallback;
  return (
    <ErrorBoundary fallback={() => fallback}>
      <Suspense fallback={fallback}>
        <GltfActor url={url} height={height} moving={moving} />
      </Suspense>
    </ErrorBoundary>
  );
}

/** Wanders a slow loop around its home spot, stopping now and then to graze. */
function Grazer({ model, x, z, phase }: { model: string; x: number; z: number; phase: number }) {
  const ref = useRef<Group>(null);
  const moving = useRef(true);
  const a = useRef(phase);
  useFrame(({ clock }, dt) => {
    const g = ref.current;
    if (!g) return;
    moving.current = Math.sin(clock.elapsedTime * 0.3 + phase) > -0.2;
    if (moving.current) a.current += dt * 0.15;
    const t = a.current;
    g.position.set(x + Math.sin(t) * 3, 0.3, z + Math.cos(t * 0.7) * 2);
    // heading = direction of travel (derivative of the loop)
    g.rotation.y = -Math.atan2(-Math.sin(t * 0.7) * 1.4, Math.cos(t) * 3);
  });
  return (
    <group ref={ref} position={[x, 0.3, z]}>
      <Actor model={model} height={model === 'goat' ? 2.4 : 3} moving={moving} />
    </group>
  );
}

/** Walks from plot to plot (the player's own first), pausing at each. */
function Farmer({ stops }: { stops: Pt[] }) {
  const ref = useRef<Group>(null);
  const state = useRef({ i: 0, t: 0, pause: 0 });
  const moving = useRef(false);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g || stops.length === 0) return;
    const s = state.current;
    const to = stops[(s.i + 1) % stops.length]!;
    moving.current = s.pause <= 0;
    if (s.pause > 0) {
      s.pause -= dt;
      return;
    }
    const dx = to.x - g.position.x;
    const dz = to.y - g.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.2) {
      s.i = (s.i + 1) % stops.length;
      s.pause = 2.5;
      return;
    }
    const step = Math.min(dist, dt * 2.2);
    g.position.x += (dx / dist) * step;
    g.position.z += (dz / dist) * step;
    g.rotation.y = Math.atan2(dx, dz) - Math.PI / 2;
    g.position.y = 0.3 + Math.abs(Math.sin(performance.now() / 160)) * 0.12;
  });
  return (
    <group ref={ref} position={[stops[0]?.x ?? 0, 0.3, stops[0]?.y ?? 0]}>
      <Actor model="farmer" height={FARMER_HEIGHT} moving={moving} />
    </group>
  );
}

function World({
  data,
  myCompanyId,
  aiIds,
}: {
  data: SegmentDetailResponse;
  myCompanyId: string | null;
  aiIds: ReadonlySet<string>;
}) {
  const biome = biomeFor(`${data.district.zone} ${data.district.zoneLabel}`, data.district.id);
  const look = LOOK[biome];
  const seed = data.segment.id;
  const { outline } = useMemo(() => normalizeOutline(data.segment.polygon), [data.segment.polygon]);
  const holdings = useMemo(
    // Keep the real north→south / west→east order so the layout echoes the geography.
    () =>
      [...data.holdings].sort((a, b) => a.centroid.y - b.centroid.y || a.centroid.x - b.centroid.x),
    [data.holdings],
  );
  const { cells, size } = useMemo(
    () => plotCells(outline, holdings.length),
    [outline, holdings.length],
  );
  const plots = useMemo<PlotInfo[]>(() => {
    const maxHa = Math.max(...holdings.map((h) => h.areaHa), 1e-6);
    return holdings.map((h, i) => {
      const op = h.operatorCompanyId;
      const kind: Kind =
        op && op === myCompanyId
          ? 'mine'
          : h.status === 'for_sale'
            ? 'sale'
            : h.status === 'reserved'
              ? 'reserved'
              : op && aiIds.has(op)
                ? 'ai'
                : 'other';
      const c = cells[i]!;
      const side =
        Math.min(size * 0.84, 18) * Math.min(1, Math.max(0.65, Math.sqrt(h.areaHa / maxHa)));
      return { h, kind, x: c.x, z: c.y, side };
    });
  }, [holdings, cells, size, myCompanyId, aiIds]);
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => {
    document.body.style.cursor = hovered ? 'var(--cursor-hand)' : '';
  }, [hovered]);
  useEffect(() => () => void (document.body.style.cursor = ''), []);
  const rect = cells.length ? blockRect(cells, size) : null;
  const stops = useMemo(() => {
    const mine = plots.filter((p) => p.kind === 'mine');
    return (mine.length >= 2 ? mine : plots).map((p) => ({ x: p.x, y: p.z + p.side / 2 + 1 }));
  }, [plots]);

  return (
    <>
      <color attach="background" args={[WATER]} />
      <fog attach="fog" args={[WATER, 260, 520]} />
      <hemisphereLight args={['#ffffff', '#5aa59a', 1.25]} />
      <directionalLight
        position={[60, 90, 40]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-90}
        shadow-camera-right={90}
        shadow-camera-top={90}
        shadow-camera-bottom={-90}
      />
      <CameraRig />
      <Island outline={outline} grass={look.ground} />
      <Offshore seed={seed} trees={look.trees} />
      {biome === 'hills' ? <Mist /> : null}
      {plots.map((p) => (
        <Plot key={p.h.id} p={p} hovered={hovered === p.h.id} onHover={setHovered} />
      ))}
      <Crops plots={plots} />
      <Scenery outline={outline} cells={cells} size={size} biome={biome} seed={seed} />
      <Animals outline={outline} cells={cells} size={size} biome={biome} seed={seed} />
      {rect ? (
        <>
          <Track rect={rect} look={look} />
          <Tractor rect={rect} />
          {biome !== 'dry' || data.holdings.some((h) => h.waterAccess !== 'none') ? (
            <Channel rect={rect} />
          ) : null}
        </>
      ) : null}
      <Farmer stops={stops} />
    </>
  );
}

export default function AreaScene({
  segmentId,
  aiIds,
}: {
  segmentId: string;
  aiIds: ReadonlySet<string>;
}) {
  const q = useSegment(segmentId);
  const myCompanyId = useCompanyId();
  return (
    <div className="area-stage">
      {q.data ? (
        <Canvas
          shadows
          dpr={[1, 2]}
          camera={{ fov: 40, near: 0.5, far: 1200, position: START }}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          onCreated={({ gl }) => {
            // no filmic curve: keep the bright, saturated storybook palette
            gl.toneMapping = NoToneMapping;
            gl.outputColorSpace = SRGBColorSpace;
          }}
          data-testid="area-view"
        >
          <World data={q.data} myCompanyId={myCompanyId} aiIds={aiIds} />
        </Canvas>
      ) : (
        <div className="area-loading" role="status">
          <span className="bh-spinner" aria-hidden="true" />{' '}
          {q.isError ? 'Could not load this area.' : 'Walking into the fields…'}
        </div>
      )}
      <div className="area-fade" aria-hidden="true" />
    </div>
  );
}
