/**
 * The 3D map of Tamil Nadu: real district and segment (assembly-constituency) outlines as a
 * carved slab over the sea, coloured by the active layer, with the Cauvery, highways, district
 * mandis and pins for operated holdings. Lazy-loaded (three.js lives in its own chunk).
 */
import { Line, MapControls, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Color,
  DoubleSide,
  type Group,
  type Mesh,
  type MeshBasicMaterial,
  NoToneMapping,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { useQualityProfile } from '../../store/settings';
import {
  landColor,
  mineColor,
  rainColor,
  ROAD,
  SEA,
  SELECT,
  vary,
  WALL,
  zoneColor,
  type MapLayer,
} from './colors';
import {
  buildMergedFill,
  buildOutlineSegments,
  buildWalls,
  KM,
  LAND_TOP,
  outlinePoints,
  recolourFill,
  toScene,
  type MapPointLike,
} from './geometry';
import { Holdings, Markets } from './Holdings';
import { useMotion, useTick } from './Instanced';
import { RIPPLE } from './parts';
import { perfStats } from './perf';
import { Coast, RiverFlow, Sky, Traffic, Vegetation } from './Scenery';

export interface MapDistrict {
  id: string;
  name: string;
  tamilName: string;
  zone: string;
  polygons: MapPointLike[][];
  centroid: MapPointLike;
  annualRainMm: number;
}
export interface MapSegment {
  id: string;
  name: string;
  districtId: string;
  polygon: MapPointLike[];
  centroid: MapPointLike;
  holdingsForSale?: number;
  mine?: number;
}
export interface MapPin {
  id: string;
  x: number;
  y: number;
  kind: 'mine' | 'ready' | 'ai' | 'other';
}
export interface MapMarket {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface TamilNaduMapProps {
  mode: 'game' | 'landing';
  districts: MapDistrict[];
  segments: MapSegment[];
  layer?: MapLayer;
  river?: MapPointLike[];
  roads?: MapPointLike[][];
  markets?: MapMarket[];
  pins?: MapPin[];
  selectedSegmentId?: string | null;
  hoveredSegmentId?: string | null;
  focusSegmentId?: string | null;
  /** Bump to re-focus the same segment. */
  focusNonce?: number;
  onHoverSegment?: (id: string | null, clientX: number, clientY: number) => void;
  onSelectSegment?: (id: string) => void;
  onSelectPin?: (id: string) => void;
  showLabels?: boolean;
  /** Internal: DOM layer for labels (set by the wrapper). */
  labelLayer?: HTMLDivElement | null;
}

function segmentColor(layer: MapLayer, s: MapSegment, d: MapDistrict | undefined, i: number) {
  switch (layer) {
    case 'rain':
      return vary(rainColor(d?.annualRainMm ?? 900), i);
    case 'land':
      return vary(landColor(s.holdingsForSale ?? 0), i);
    case 'mine':
      return mineColor(s.mine ?? 0);
    default:
      return vary(zoneColor(d?.zone ?? ''), i);
  }
}

function Land({
  districts,
  segments,
  layer,
  onHoverSegment,
  onSelectSegment,
  onRipple,
  interactive,
}: {
  districts: MapDistrict[];
  segments: MapSegment[];
  layer: MapLayer;
  onHoverSegment?: TamilNaduMapProps['onHoverSegment'];
  onSelectSegment?: TamilNaduMapProps['onSelectSegment'];
  onRipple?: (x: number, z: number) => void;
  interactive: boolean;
}) {
  const byDistrict = useMemo(() => new Map(districts.map((d) => [d.id, d])), [districts]);
  const segmentKey = segments.map((s) => s.id).join(',');
  const fill = useMemo(
    () =>
      buildMergedFill(
        segments.map((s) => s.polygon),
        (i) => segmentColor(layer, segments[i]!, byDistrict.get(segments[i]!.districtId), i),
      ),
    // Geometry depends only on the segment outlines; colours are updated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [segmentKey],
  );
  useEffect(() => {
    recolourFill(fill.geometry, fill.triangleOwner, (i) =>
      segmentColor(layer, segments[i]!, byDistrict.get(segments[i]!.districtId), i),
    );
  }, [fill, layer, segments, byDistrict]);
  const walls = useMemo(() => buildWalls(districts.flatMap((d) => d.polygons)), [districts]);
  const outlines = useMemo(
    () => buildOutlineSegments(segments.map((s) => s.polygon)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [segmentKey],
  );
  useEffect(
    () => () => {
      fill.geometry.dispose();
      walls.dispose();
      outlines.dispose();
    },
    [fill, walls, outlines],
  );

  const ownerAt = (e: ThreeEvent<PointerEvent | MouseEvent>) =>
    e.faceIndex != null ? segments[fill.triangleOwner[e.faceIndex] ?? -1] : undefined;

  return (
    <group>
      <mesh
        geometry={fill.geometry}
        receiveShadow
        onPointerMove={
          interactive
            ? (e) => {
                e.stopPropagation();
                onHoverSegment?.(ownerAt(e)?.id ?? null, e.clientX, e.clientY);
              }
            : undefined
        }
        onPointerOut={interactive ? (e) => onHoverSegment?.(null, e.clientX, e.clientY) : undefined}
        onClick={
          interactive
            ? (e) => {
                e.stopPropagation();
                const s = ownerAt(e);
                if (s) {
                  onRipple?.(e.point.x, e.point.z);
                  onSelectSegment?.(s.id);
                }
              }
            : undefined
        }
      >
        <meshStandardMaterial vertexColors roughness={0.92} metalness={0} />
      </mesh>
      <mesh geometry={walls}>
        <meshStandardMaterial color={WALL} roughness={1} side={DoubleSide} />
      </mesh>
      <lineSegments geometry={outlines}>
        <lineBasicMaterial color="#ffffff" transparent opacity={0.35} />
      </lineSegments>
      {districts.map((d) =>
        d.polygons.map((ring, i) => (
          <Line
            key={`${d.id}-${i}`}
            points={outlinePoints(ring, LAND_TOP + 0.08)}
            color="#fffaf0"
            lineWidth={1.4}
            transparent
            opacity={0.9}
          />
        )),
      )}
    </group>
  );
}

/** Selected/hovered segment: tinted fill + outline; the hovered one lifts and glows. */
function SegmentHighlight({
  segment,
  color,
  width,
  lift = false,
  motion = false,
}: {
  segment: MapSegment;
  color: string;
  width: number;
  lift?: boolean;
  motion?: boolean;
}) {
  const fill = useMemo(
    () => buildMergedFill([segment.polygon], () => new Color(color), LAND_TOP + 0.12),
    [segment, color],
  );
  useEffect(() => () => fill.geometry.dispose(), [fill]);
  const group = useRef<Group>(null);
  const mat = useRef<MeshBasicMaterial>(null);
  useEffect(() => {
    if (group.current) group.current.position.y = 0;
  }, [segment]);
  useTick((t, dt) => {
    if (!lift || !group.current) return;
    const g = group.current;
    g.position.y += (0.9 - g.position.y) * (motion ? 1 - Math.exp(-dt * 10) : 1);
    if (mat.current) mat.current.opacity = 0.3 + (motion ? Math.sin(t * 4) * 0.1 : 0);
  }, motion || lift);
  return (
    <group ref={group}>
      <mesh geometry={fill.geometry}>
        <meshBasicMaterial ref={mat} color={color} transparent opacity={0.28} depthWrite={false} />
      </mesh>
      <Line
        points={outlinePoints(segment.polygon, LAND_TOP + 0.16)}
        color={color}
        lineWidth={width}
      />
    </group>
  );
}

/** Expanding ring where the player clicked. */
function Ripple({
  at,
  motion,
}: {
  at: { current: { x: number; z: number; t0: number } | null };
  motion: boolean;
}) {
  const ref = useRef<Mesh>(null);
  const mat = useRef<MeshBasicMaterial>(null);
  useFrame((state) => {
    const mesh = ref.current;
    const r = at.current;
    if (!mesh) return;
    const age = r ? state.clock.elapsedTime - r.t0 : Infinity;
    mesh.visible = motion && age < 0.9;
    if (!mesh.visible || !r) return;
    const k = age / 0.9;
    mesh.position.set(r.x, LAND_TOP + 0.3, r.z);
    mesh.scale.setScalar(2 + k * 22);
    if (mat.current) mat.current.opacity = 0.8 * (1 - k);
  });
  return (
    <mesh ref={ref} geometry={RIPPLE} visible={false}>
      <meshBasicMaterial
        ref={mat}
        color="#fffaf0"
        transparent
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

/**
 * District names as a plain DOM overlay positioned each frame (no React portals, so no
 * unmount races between the R3F and DOM renderers).
 */
function DistrictLabels({
  districts,
  container,
}: {
  districts: MapDistrict[];
  container: HTMLDivElement | null;
}) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const nodes = useRef<{ el: HTMLDivElement; pos: Vector3 }[]>([]);
  useEffect(() => {
    if (!container) return;
    nodes.current = districts.map((d) => {
      const el = document.createElement('div');
      el.className = 'tn-district-label';
      const name = document.createElement('span');
      name.textContent = d.name;
      const ta = document.createElement('small');
      ta.lang = 'ta';
      ta.textContent = d.tamilName;
      el.append(name, ta);
      container.append(el);
      const [x, y, z] = toScene(d.centroid, LAND_TOP + 0.5);
      return { el, pos: new Vector3(x, y, z) };
    });
    return () => {
      for (const n of nodes.current) n.el.remove();
      nodes.current = [];
    };
  }, [districts, container]);
  const v = useMemo(() => new Vector3(), []);
  useFrame(() => {
    for (const n of nodes.current) {
      v.copy(n.pos).project(camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      n.el.style.display = visible ? '' : 'none';
      if (visible) {
        const x = ((v.x + 1) / 2) * size.width;
        const y = ((1 - v.y) / 2) * size.height;
        n.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      }
    }
  });
  return null;
}

function PerfProbe() {
  const gl = useThree((s) => s.gl);
  useFrame((_, dt) => {
    perfStats.frameMs = perfStats.frameMs * 0.9 + dt * 1000 * 0.1;
    perfStats.fps = perfStats.frameMs > 0 ? 1000 / perfStats.frameMs : 0;
    perfStats.calls = gl.info.render.calls;
    perfStats.triangles = gl.info.render.triangles;
    perfStats.geometries = gl.info.memory.geometries;
    perfStats.textures = gl.info.memory.textures;
  });
  return null;
}

/** Smoothly re-targets the controls on a newly focused segment. */
function FocusRig({ target, nonce }: { target: MapPointLike | null; nonce: number }) {
  const controls = useThree((s) => s.controls) as unknown as {
    target: Vector3;
    update: () => void;
  } | null;
  const goal = useRef<Vector3 | null>(null);
  useEffect(() => {
    goal.current = target ? new Vector3(target.x * KM, LAND_TOP, target.y * KM) : null;
  }, [target, nonce]);
  useFrame((state, dt) => {
    if (!controls || !goal.current) return;
    const t = 1 - Math.exp(-dt * 4);
    const delta = goal.current.clone().sub(controls.target).multiplyScalar(t);
    controls.target.add(delta);
    state.camera.position.add(delta);
    // Ease in to a regional view so the focused area fills the screen.
    const offset = state.camera.position.clone().sub(controls.target);
    const dist = offset.length();
    if (dist > FOCUS_DISTANCE) {
      offset.setLength(dist + (FOCUS_DISTANCE - dist) * t);
      state.camera.position.copy(controls.target).add(offset);
    }
    controls.update();
    if (goal.current.distanceTo(controls.target) < 0.05 && dist <= FOCUS_DISTANCE + 1) {
      goal.current = null;
    }
  });
  return null;
}

function Scene(props: TamilNaduMapProps) {
  const {
    mode,
    districts,
    segments,
    layer = 'zone',
    river = [],
    roads = [],
    markets = [],
    pins = [],
    selectedSegmentId,
    hoveredSegmentId,
    focusSegmentId,
    focusNonce = 0,
    showLabels = true,
  } = props;
  const game = mode === 'game';
  const byId = useMemo(() => new Map(segments.map((s) => [s.id, s])), [segments]);
  const selected = selectedSegmentId ? byId.get(selectedSegmentId) : undefined;
  const hovered =
    hoveredSegmentId && hoveredSegmentId !== selectedSegmentId
      ? byId.get(hoveredSegmentId)
      : undefined;
  const focus = focusSegmentId ? (byId.get(focusSegmentId)?.centroid ?? null) : null;
  const motion = useMotion();
  const treeDensity = useQualityProfile().treeDensity;
  const clock = useThree((s) => s.clock);
  const ripple = useRef<{ x: number; z: number; t0: number } | null>(null);

  return (
    <>
      <color attach="background" args={[SEA]} />
      <fog attach="fog" args={[SEA, 700, 1600]} />
      <hemisphereLight args={['#ffffff', '#5aa59a', 1.2]} />
      <directionalLight position={[-200, 400, 150]} intensity={1.5} color="#fff4e0" />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, LAND_BOTTOM_SEA, 0]}>
        <planeGeometry args={[4000, 4000]} />
        <meshStandardMaterial color={SEA} roughness={0.35} metalness={0.05} />
      </mesh>
      <Land
        districts={districts}
        segments={segments}
        layer={layer}
        onHoverSegment={props.onHoverSegment}
        onSelectSegment={props.onSelectSegment}
        onRipple={(x, z) => (ripple.current = { x, z, t0: clock.elapsedTime })}
        interactive={game}
      />
      <Vegetation districts={districts} density={treeDensity} />
      <Sky districts={districts} motion={motion} />
      <Coast districts={districts} motion={motion} />
      <RiverFlow river={river} motion={motion} />
      <Traffic roads={roads} motion={motion} />
      {roads.map((r, i) => (
        <Line
          key={i}
          points={r.map((p) => toScene(p, LAND_TOP + 0.09))}
          color={ROAD}
          lineWidth={1.6}
          dashed
          dashSize={4}
          gapSize={2}
        />
      ))}
      {hovered ? (
        <SegmentHighlight segment={hovered} color="#fffbe8" width={2.5} lift motion={motion} />
      ) : null}
      {selected ? <SegmentHighlight segment={selected} color={SELECT} width={3.5} /> : null}
      <Ripple at={ripple} motion={motion} />
      <Markets markets={markets} motion={motion} />
      <Holdings pins={pins} motion={motion} onSelectPin={props.onSelectPin} />
      {showLabels ? (
        <DistrictLabels districts={districts} container={props.labelLayer ?? null} />
      ) : null}
      <PerfProbe />
      {game ? (
        <>
          <MapControls
            makeDefault
            target={[10, 0, 40]}
            enableDamping
            dampingFactor={0.12}
            minDistance={30}
            maxDistance={1100}
            maxPolarAngle={1.15}
            screenSpacePanning={false}
          />
          <FocusRig target={focus} nonce={focusNonce} />
        </>
      ) : (
        <OrbitControls
          makeDefault
          autoRotate
          autoRotateSpeed={0.35}
          enableZoom={false}
          enablePan={false}
          enableRotate={false}
        />
      )}
    </>
  );
}

const LAND_BOTTOM_SEA = -2.7;
const FOCUS_DISTANCE = 260;

export default function TamilNaduMap(props: TamilNaduMapProps) {
  const [labelLayer, setLabelLayer] = useState<HTMLDivElement | null>(null);
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Canvas
        dpr={[1, 2]}
        camera={{ fov: 35, near: 1, far: 5000, position: [20, 700, 660] }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          gl.toneMapping = NoToneMapping;
          gl.outputColorSpace = SRGBColorSpace;
        }}
        onPointerMissed={() => props.onHoverSegment?.(null, 0, 0)}
        data-testid="tn-map"
      >
        <Scene {...props} labelLayer={labelLayer} />
      </Canvas>
      <div ref={setLabelLayer} className="tn-label-layer" aria-hidden="true" />
    </div>
  );
}
