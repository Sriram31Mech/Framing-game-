/**
 * Scene layers. Every layer is a single mesh / InstancedMesh with a shared material so the whole
 * world stays within a few dozen draw calls.
 */
import type { ParcelSummaryDto } from '@bh/contracts';
import type { CropId } from '@bh/domain';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { DirectionalLight, InstancedMesh } from 'three';
import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Mesh,
} from 'three';
import {
  polylineCumulative,
  pointAlong,
  longestEdgeAngle,
  polygonBounds,
  type Pt,
} from '../lib/geometry';
import {
  cropFieldColor,
  cropGeometry,
  fruitGeometry,
  layoutCrops,
  type PlantedParcel,
} from './builders/crops';
import { MeshBuilder } from './builders/meshBuilder';
import { applyParcelColors, buildBunds, buildParcelFill } from './builders/parcelGeometry';
import {
  arecaPalm,
  bananaClump,
  broadleafTree,
  coconutPalm,
  lorry,
  tractor,
} from './builders/props';
import type { Placement, Scenery } from './builders/scenery';
import { cameraState, perfStats } from './cameraState';
import type { WorldLayout } from './layout';
import type { SceneMaterials } from './materials';
import { sharedTime } from './materials';
import { ownershipClass, type ParcelVisualContext } from './ownership';
import { CROP_LOOK, FALLOW, OWNERSHIP, SOIL, SOIL_FALLBACK } from './palette';

export type { ParcelVisualContext } from './ownership';

// ----------------------------------------------------------------------------- lighting

const SUN_DIR = new Vector3(0.55, 0.78, 0.32).normalize();

export function Lights({ shadows, shadowMapSize }: { shadows: boolean; shadowMapSize: number }) {
  const sun = useRef<DirectionalLight>(null);
  const { scene } = useThree();
  useEffect(() => {
    const light = sun.current;
    if (!light) return;
    scene.add(light.target);
    return () => {
      scene.remove(light.target);
    };
  }, [scene]);
  const lastExtent = useRef(0);
  useFrame(() => {
    const light = sun.current;
    if (!light) return;
    const { targetX: x, targetY: y, targetZ: z, distance } = cameraState;
    light.target.position.set(x, y, z);
    light.position.set(x + SUN_DIR.x * 3000, y + SUN_DIR.y * 3000, z + SUN_DIR.z * 3000);
    light.target.updateMatrixWorld();
    if (shadows) {
      const extent = Math.max(110, Math.min(2600, distance * 0.85));
      if (Math.abs(extent - lastExtent.current) / extent > 0.08) {
        lastExtent.current = extent;
        const cam = light.shadow.camera;
        cam.left = -extent;
        cam.right = extent;
        cam.top = extent;
        cam.bottom = -extent;
        cam.near = 100;
        cam.far = 6500;
        cam.updateProjectionMatrix();
        light.shadow.normalBias = Math.max(0.4, extent / 600);
      }
    }
  });
  return (
    <>
      <hemisphereLight args={['#dce8f5', '#8a6b4c', 1.05]} />
      <directionalLight
        ref={sun}
        color="#ffe2b8"
        intensity={2.7}
        castShadow={shadows}
        shadow-mapSize-width={shadowMapSize || 1024}
        shadow-mapSize-height={shadowMapSize || 1024}
        shadow-bias={-0.0004}
      />
      <directionalLight color="#b9c8ff" intensity={0.35} position={[-1200, 900, -800]} />
    </>
  );
}

/** Advances the shared shader clock (water ripples, crop/tree sway). */
export function ShaderClock() {
  useFrame((_, dt) => {
    sharedTime.value += Math.min(0.1, dt);
  });
  return null;
}

/** Samples renderer stats for the dev perf overlay (no React updates per frame). */
export function PerfProbe() {
  const { gl } = useThree();
  const acc = useRef({ frames: 0, time: 0 });
  useFrame((_, dt) => {
    acc.current.frames++;
    acc.current.time += dt;
    if (acc.current.time >= 0.5) {
      perfStats.fps = acc.current.frames / acc.current.time;
      perfStats.frameMs = (acc.current.time / acc.current.frames) * 1000;
      acc.current = { frames: 0, time: 0 };
    }
    perfStats.calls = gl.info.render.calls;
    perfStats.triangles = gl.info.render.triangles;
    perfStats.geometries = gl.info.memory.geometries;
    perfStats.textures = gl.info.memory.textures;
  });
  return null;
}

// ----------------------------------------------------------------------------- static meshes

export function StaticWorld({
  layout,
  materials,
  scenery,
}: {
  layout: WorldLayout;
  materials: SceneMaterials;
  scenery: Scenery;
}) {
  return (
    <>
      <mesh geometry={layout.terrain} material={materials.terrain} receiveShadow />
      <mesh geometry={layout.roads} material={materials.road} receiveShadow />
      {layout.river ? (
        <mesh geometry={layout.river.geometry} material={materials.water} receiveShadow />
      ) : null}
      <mesh
        geometry={scenery.architecture}
        material={materials.architecture}
        castShadow
        receiveShadow
      />
    </>
  );
}

// ----------------------------------------------------------------------------- parcels

const cTmp = new Color();
const cSoil = new Color();

export function ParcelLayer({
  layout,
  parcels,
  materials,
  ctx,
  interactive,
  onHover,
  onSelect,
}: {
  layout: WorldLayout;
  parcels: ParcelSummaryDto[];
  materials: SceneMaterials;
  ctx: ParcelVisualContext;
  interactive: boolean;
  onHover?: (id: string | null, clientX: number, clientY: number) => void;
  onSelect?: (id: string, focus: boolean) => void;
}) {
  const { invalidate } = useThree();
  // Recolour fill + bunds when ownership / crop state changes (geometry untouched).
  useLayoutEffect(() => {
    const byIndex: (ParcelSummaryDto | undefined)[] = layout.parcelIds.map(() => undefined);
    for (const p of parcels) {
      const i = layout.parcelIndex.get(p.id);
      if (i !== undefined) byIndex[i] = p;
    }
    const fillColors = byIndex.map((p) => {
      const c = new Color();
      if (!p) return c.copy(FALLOW);
      cSoil.copy(SOIL[p.soilTexture] ?? SOIL_FALLBACK);
      const cls = ownershipClass(p, ctx);
      if (p.crop) cropFieldColor(p.crop, cSoil, c);
      else if (p.status === 'owned' || p.status === 'leased') c.copy(cSoil).multiplyScalar(0.9);
      else c.copy(cSoil).lerp(FALLOW, 0.62);
      if (cls === 'mine') c.lerp(OWNERSHIP.mine, 0.06);
      return c;
    });
    const classes = byIndex.map((p) => (p ? ownershipClass(p, ctx) : 'other'));
    applyParcelColors(layout.fill.geometry, layout.fill.vertexParcel, (pi) => fillColors[pi]!);
    applyParcelColors(layout.bunds.geometry, layout.bunds.vertexParcel, (pi, v) => {
      const cls = classes[pi]!;
      if (cls === 'forSale')
        return layout.bunds.vertexDash[v] ? OWNERSHIP.forSale : OWNERSHIP.forSaleGap;
      return cTmp.copy(OWNERSHIP[cls]);
    });
    invalidate();
  }, [layout, parcels, ctx, invalidate]);

  const pickMat = useMemo(() => new MeshBasicMaterial({ visible: false, side: DoubleSide }), []);
  useEffect(() => () => pickMat.dispose(), [pickMat]);

  const idAt = (e: ThreeEvent<PointerEvent | MouseEvent>): string | null => {
    const f = e.faceIndex;
    if (f === undefined || f === null) return null;
    const pi = layout.pick.triangleParcel[f];
    return pi === undefined ? null : (layout.parcelIds[pi] ?? null);
  };

  return (
    <>
      <mesh geometry={layout.fill.geometry} material={materials.fill} receiveShadow />
      <mesh
        geometry={layout.bunds.geometry}
        material={materials.bund}
        receiveShadow
        castShadow={false}
      />
      {interactive ? (
        <mesh
          geometry={layout.pick.geometry}
          material={pickMat}
          onPointerMove={(e) => {
            e.stopPropagation();
            onHover?.(idAt(e), e.nativeEvent.clientX, e.nativeEvent.clientY);
          }}
          onPointerOut={() => onHover?.(null, 0, 0)}
          onClick={(e) => {
            if (e.delta > 6) return;
            e.stopPropagation();
            const id = idAt(e);
            if (id) onSelect?.(id, false);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            const id = idAt(e);
            if (id) onSelect?.(id, true);
          }}
        />
      ) : null}
    </>
  );
}

/** Glowing outline (and soft fill for the selection) around one parcel. */
export function ParcelHighlight({
  layout,
  polygon,
  id,
  kind,
}: {
  layout: WorldLayout;
  polygon: Pt[];
  id: string;
  kind: 'hover' | 'selected';
}) {
  const geo = useMemo(() => {
    const shape = [{ id, polygon }];
    const ring = buildBunds(shape, layout.sampler, {
      width: kind === 'selected' ? 4.2 : 3.2,
      height: kind === 'selected' ? 1.5 : 1.2,
      step: 6,
      lift: 0.3,
    }).geometry;
    const fill =
      kind === 'selected' ? buildParcelFill(shape, layout.sampler, 14, 0.75).geometry : null;
    return { ring, fill };
  }, [layout, polygon, id, kind]);
  useEffect(
    () => () => {
      geo.ring.dispose();
      geo.fill?.dispose();
    },
    [geo],
  );
  const mats = useMemo(
    () => ({
      ring: new MeshBasicMaterial({
        color: kind === 'selected' ? OWNERSHIP.selected : OWNERSHIP.hover,
        toneMapped: false,
      }),
      fill: new MeshBasicMaterial({
        color: OWNERSHIP.selected,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -6,
      }),
    }),
    [kind],
  );
  useEffect(
    () => () => {
      mats.ring.dispose();
      mats.fill.dispose();
    },
    [mats],
  );
  return (
    <>
      <mesh geometry={geo.ring} material={mats.ring} renderOrder={2} />
      {geo.fill ? <mesh geometry={geo.fill} material={mats.fill} renderOrder={3} /> : null}
    </>
  );
}

// ----------------------------------------------------------------------------- crops

const CROP_GEOMETRIES = new Map<string, BufferGeometry>();
function geometryFor(kind: 'ridge' | 'stalk' | 'bush'): BufferGeometry {
  let g = CROP_GEOMETRIES.get(kind);
  if (!g) {
    g = cropGeometry(kind);
    CROP_GEOMETRIES.set(kind, g);
  }
  return g;
}
let FRUIT_GEOMETRY: BufferGeometry | null = null;

function InstancedLayer({
  geometry,
  material,
  count,
  matrices,
  colors,
  castShadow,
}: {
  geometry: BufferGeometry;
  material: SceneMaterials[keyof Omit<SceneMaterials, 'dispose'>];
  count: number;
  matrices: Float32Array;
  colors?: Float32Array;
  castShadow?: boolean;
}) {
  const ref = useRef<InstancedMesh>(null);
  const { invalidate } = useThree();
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.instanceMatrix.array.set(matrices.subarray(0, count * 16));
    mesh.instanceMatrix.needsUpdate = true;
    if (colors) {
      const capacity = mesh.instanceMatrix.count;
      if (!mesh.instanceColor || mesh.instanceColor.count < capacity) {
        mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      }
      (mesh.instanceColor.array as Float32Array).set(colors.subarray(0, count * 3));
      mesh.instanceColor.needsUpdate = true;
    }
    mesh.count = count;
    mesh.computeBoundingSphere();
    invalidate();
  }, [matrices, colors, count, invalidate]);
  if (count === 0) return null;
  return (
    <instancedMesh
      // Re-create when capacity grows; matrices are rewritten in place otherwise.
      key={Math.ceil(count / 2048)}
      ref={ref}
      args={[geometry, material, Math.ceil(count / 2048) * 2048]}
      castShadow={castShadow}
      receiveShadow
      frustumCulled
    />
  );
}

export function CropLayer({
  layout,
  parcels,
  materials,
  spacingScale,
  maxPerCrop,
  castShadow,
}: {
  layout: WorldLayout;
  parcels: ParcelSummaryDto[];
  materials: SceneMaterials;
  spacingScale: number;
  maxPerCrop: number;
  castShadow: boolean;
}) {
  // Only rebuild instances when the crop-relevant data actually changes.
  const signature = parcels
    .filter((p) => p.crop)
    .map(
      (p) =>
        `${p.id}:${p.crop!.cropId}:${p.crop!.status}:${p.crop!.progress.toFixed(2)}:${p.crop!.health.toFixed(2)}`,
    )
    .join('|');
  const planted = useMemo<PlantedParcel[]>(
    () =>
      parcels.filter((p) => p.crop).map((p) => ({ id: p.id, polygon: p.polygon, crop: p.crop! })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the crop signature, not array identity
    [signature],
  );
  const crops = useMemo(
    () => layoutCrops(planted, layout.sampler, { spacingScale, maxPerCrop }),
    [planted, layout, spacingScale, maxPerCrop],
  );
  useEffect(() => {
    perfStats.instances = crops.total + crops.fruit.count;
  }, [crops]);
  if (!FRUIT_GEOMETRY) FRUIT_GEOMETRY = fruitGeometry();
  return (
    <>
      {crops.byCrop.map((c) => (
        <InstancedLayer
          key={c.cropId}
          geometry={geometryFor(CROP_LOOK[c.cropId as CropId].kind)}
          material={materials.crop}
          count={c.count}
          matrices={c.matrices}
          colors={c.colors}
          castShadow={castShadow}
        />
      ))}
      <InstancedLayer
        geometry={FRUIT_GEOMETRY}
        material={materials.fruit}
        count={crops.fruit.count}
        matrices={crops.fruit.matrices}
      />
    </>
  );
}

// ----------------------------------------------------------------------------- vegetation

const TREE_GEOMETRIES: Record<'broadleaf' | 'coconut' | 'areca' | 'banana', () => BufferGeometry> =
  {
    broadleaf: () => {
      const b = new MeshBuilder();
      broadleafTree(b);
      return b.toGeometry();
    },
    coconut: () => {
      const b = new MeshBuilder();
      coconutPalm(b);
      return b.toGeometry();
    },
    areca: () => {
      const b = new MeshBuilder();
      arecaPalm(b);
      return b.toGeometry();
    },
    banana: () => {
      const b = new MeshBuilder();
      bananaClump(b);
      return b.toGeometry();
    },
  };

function placementsToArrays(list: Placement[]): { matrices: Float32Array; colors: Float32Array } {
  const matrices = new Float32Array(list.length * 16);
  const colors = new Float32Array(list.length * 3);
  const m = new Matrix4();
  const q = new Quaternion();
  const p = new Vector3();
  const s = new Vector3();
  const c = new Color();
  const axis = new Vector3(0, 1, 0);
  list.forEach((t, i) => {
    p.set(t.x, t.y, t.z);
    q.setFromAxisAngle(axis, t.ry);
    s.setScalar(t.s);
    m.compose(p, q, s).toArray(matrices, i * 16);
    // Subtle hue/value variation around white (vertex colours carry the species palette).
    c.setHSL(0.18 + (t.tint - 0.5) * 0.08, 0.25, 0.86 + t.tint * 0.14);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  });
  return { matrices, colors };
}

export function VegetationLayer({
  scenery,
  materials,
}: {
  scenery: Scenery;
  materials: SceneMaterials;
}) {
  const data = useMemo(() => {
    const kinds = ['broadleaf', 'coconut', 'areca', 'banana'] as const;
    return kinds.map((k) => ({
      kind: k,
      geometry: TREE_GEOMETRIES[k](),
      list: scenery[k],
      ...placementsToArrays(scenery[k]),
    }));
  }, [scenery]);
  useEffect(() => () => data.forEach((d) => d.geometry.dispose()), [data]);
  return (
    <>
      {data.map((d) => (
        <InstancedLayer
          key={d.kind}
          geometry={d.geometry}
          material={materials.tree}
          count={d.list.length}
          matrices={d.matrices}
          colors={d.colors}
          castShadow
        />
      ))}
    </>
  );
}

// ----------------------------------------------------------------------------- vehicles

interface Route {
  pts: Pt[];
  cum: number[];
  length: number;
  laneOffset: number;
}

const tmpObj = new Object3D();

export function Vehicles({
  layout,
  materials,
  animate,
  tractorParcel,
}: {
  layout: WorldLayout;
  materials: SceneMaterials;
  animate: boolean;
  tractorParcel: Pt[] | null;
}) {
  const lorryRef = useRef<InstancedMesh>(null);
  const tractorRef = useRef<Mesh>(null);
  const geos = useMemo(() => {
    const lb = new MeshBuilder();
    lorry(lb, 0);
    const tb = new MeshBuilder();
    tractor(tb);
    return { lorry: lb.toGeometry(), tractor: tb.toGeometry() };
  }, []);
  useEffect(
    () => () => {
      geos.lorry.dispose();
      geos.tractor.dispose();
    },
    [geos],
  );

  const routes = useMemo<Route[]>(() => {
    const ranked = [...layout.roadPaths]
      .filter((r) => r.kind === 'highway' || r.kind === 'district')
      .map((r) => ({ r, len: polylineCumulative(r.points).at(-1) ?? 0 }))
      .sort((a, b) => b.len - a.len)
      .slice(0, 3);
    return ranked.map(({ r }) => {
      const cum = polylineCumulative(r.points);
      return { pts: r.points, cum, length: cum.at(-1) ?? 0, laneOffset: r.widthM * 0.25 };
    });
  }, [layout]);

  const tractorPath = useMemo(() => {
    if (!tractorParcel || tractorParcel.length < 3) return null;
    const angle = longestEdgeAngle(tractorParcel);
    const b = polygonBounds(tractorParcel);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const span = Math.min(b.maxX - b.minX, b.maxY - b.minY) * 0.32;
    return { cx, cy, angle, span: Math.max(10, span) };
  }, [tractorParcel]);

  const lorryColors = useMemo(() => {
    const arr = new Float32Array(9);
    const tints = ['#ffffff', '#ffd9c2', '#cfe0ff'];
    tints.forEach((t, i) => new Color(t).toArray(arr, i * 3));
    return arr;
  }, []);

  const place = (t: number) => {
    const mesh = lorryRef.current;
    if (mesh) {
      routes.forEach((route, i) => {
        if (route.length < 50) return;
        const speed = 9 + i * 2;
        const period = route.length / speed;
        const phase = (t / period + i * 0.37) % 2;
        const forward = phase < 1;
        const s = (forward ? phase : 2 - phase) * route.length;
        const p = pointAlong(route.pts, route.cum, s);
        const heading = forward ? p.angle : p.angle + Math.PI;
        // Drive on the left (India): left of heading θ is (sin θ, −cos θ) in the map frame.
        const off = route.laneOffset;
        const lx = p.x + Math.sin(heading) * off;
        const ly = p.y - Math.cos(heading) * off;
        tmpObj.position.set(lx, layout.sampler.heightAt(lx, ly) + 0.45, ly);
        tmpObj.rotation.set(0, -heading, 0);
        tmpObj.scale.setScalar(1);
        tmpObj.updateMatrix();
        mesh.setMatrixAt(i, tmpObj.matrix);
      });
      mesh.count = routes.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
    const tr = tractorRef.current;
    if (tr && tractorPath) {
      const u = Math.sin(t * 0.12) * tractorPath.span;
      const heading = tractorPath.angle + (Math.cos(t * 0.12) >= 0 ? 0 : Math.PI);
      const x = tractorPath.cx + Math.cos(tractorPath.angle) * u;
      const y = tractorPath.cy + Math.sin(tractorPath.angle) * u;
      tr.position.set(x, layout.sampler.heightAt(x, y) + 0.35, y);
      tr.rotation.set(0, -heading, 0);
    }
  };

  useLayoutEffect(() => {
    const mesh = lorryRef.current;
    if (mesh) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.instanceColor = new InstancedBufferAttribute(lorryColors, 3);
    }
    place(40);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial placement only
  }, [routes, tractorPath]);

  useFrame(({ clock }) => {
    if (animate) place(clock.elapsedTime + 40);
  });

  return (
    <>
      {routes.length > 0 ? (
        <instancedMesh
          ref={lorryRef}
          args={[geos.lorry, materials.vehicle, 3]}
          castShadow
          frustumCulled={false}
        />
      ) : null}
      {tractorPath ? (
        <mesh ref={tractorRef} geometry={geos.tractor} material={materials.vehicle} castShadow />
      ) : null}
    </>
  );
}
