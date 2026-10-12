/**
 * Shared instancing plumbing for map scenery: one InstancedMesh per prop type, whose matrix
 * (and colour) buffers are owned by the system that animates them. If a CC0 model exists for a
 * prop (see ../models), its first mesh replaces the procedural geometry; while it loads, or if it
 * fails, the procedural primitive is drawn instead.
 */
import { useGLTF } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Box3,
  type BufferAttribute,
  type BufferGeometry,
  InstancedBufferAttribute,
  type InstancedMesh,
  type Material,
  Matrix4,
  type Mesh,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ErrorBoundary } from '../../app/ErrorBoundary';
import { useQualityProfile } from '../../store/settings';
import * as Models from '../models';

/** URL for a model key, if the models registry has one (registry shape is not assumed). */
function modelUrl(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const registry = (Models as unknown as { MODELS?: Record<string, unknown> }).MODELS;
  const v = registry?.[key];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') {
    return (v as { url: string }).url;
  }
  return undefined;
}

export interface InstanceBuffers {
  matrices: InstancedBufferAttribute;
  colors?: InstancedBufferAttribute;
  count: number;
}

export function makeBuffers(count: number, withColors = false): InstanceBuffers {
  const n = Math.max(1, count);
  return {
    matrices: new InstancedBufferAttribute(new Float32Array(n * 16), 16),
    colors: withColors
      ? new InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3)
      : undefined,
    count,
  };
}

interface BatchProps {
  buffers: InstanceBuffers;
  geometry: BufferGeometry;
  material: Material | Material[];
  castShadow?: boolean;
  onClick?: (instanceId: number, e: ThreeEvent<MouseEvent>) => void;
  /** Model meshes keep their own textures/colours; skip the procedural tint. */
  tint?: boolean;
}

function Batch({ buffers, geometry, material, castShadow, onClick, tint = true }: BatchProps) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.instanceMatrix = buffers.matrices;
    mesh.instanceColor = tint && buffers.colors ? buffers.colors : null;
    mesh.count = buffers.count;
    buffers.matrices.needsUpdate = true;
  }, [buffers, tint, geometry]);
  if (buffers.count === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, Math.max(1, buffers.count)]}
      frustumCulled={false}
      castShadow={castShadow}
      dispose={null}
      onClick={
        onClick
          ? (e) => {
              if (e.instanceId == null) return;
              e.stopPropagation();
              onClick(e.instanceId, e);
            }
          : undefined
      }
    />
  );
}

/** All meshes of a glTF merged (one group per material), baked unit-height on y=0 like the primitives. */
function ModelBatch({ url, ...rest }: Omit<BatchProps, 'geometry' | 'material'> & { url: string }) {
  const gltf = useGLTF(url);
  const part = useMemo(() => {
    gltf.scene.updateMatrixWorld(true);
    const meshes: Mesh[] = [];
    gltf.scene.traverse((o) => {
      if ((o as Mesh).isMesh) meshes.push(o as Mesh);
    });
    if (!meshes.length) throw new Error(`no mesh in ${url}`);
    const geos = meshes.map((m) => {
      const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
      return g.index ? g.toNonIndexed() : g;
    });
    // mergeGeometries needs identical attribute sets: keep only those every part has.
    const keep = Object.keys(geos[0]!.attributes).filter((k) =>
      geos.every((g) => g.getAttribute(k)),
    );
    for (const g of geos)
      for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
    const geometry = mergeGeometries(geos, true);
    geos.forEach((g) => g.dispose());
    if (!geometry) throw new Error(`cannot merge ${url}`);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const box = new Box3().setFromBufferAttribute(
      geometry.getAttribute('position') as BufferAttribute,
    );
    const size = box.getSize(new Vector3());
    const centre = box.getCenter(new Vector3());
    const s = 1 / Math.max(size.y, 1e-6);
    geometry.applyMatrix4(
      new Matrix4()
        .makeScale(s, s, s)
        .multiply(new Matrix4().makeTranslation(-centre.x, -box.min.y, -centre.z)),
    );
    const material = meshes.map((m) => (Array.isArray(m.material) ? m.material[0]! : m.material));
    return { geometry, material };
  }, [gltf, url]);
  useEffect(() => () => part.geometry.dispose(), [part]);
  return <Batch {...rest} geometry={part.geometry} material={part.material} tint={false} />;
}

/** One instanced prop type: the model if registered, else (and meanwhile) the primitive. */
export function Prop({ modelKey, ...props }: BatchProps & { modelKey?: string }) {
  const url = modelUrl(modelKey);
  const primitive = <Batch {...props} />;
  if (!url) return primitive;
  return (
    <ErrorBoundary fallback={() => primitive}>
      <Suspense fallback={primitive}>
        <ModelBatch
          url={url}
          buffers={props.buffers}
          castShadow={props.castShadow}
          onClick={props.onClick}
        />
      </Suspense>
    </ErrorBoundary>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/** Whether ambient animation should run: quality profile allows it and the OS doesn't ask for less. */
export function useMotion(): boolean {
  const animate = useQualityProfile().animate;
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return animate && !reduced;
}

/**
 * One frame callback per system. With motion off it draws a single still frame (t = 0) and
 * then idles until the component re-renders (e.g. new data).
 */
export function useTick(update: (t: number, dt: number) => void, motion: boolean): void {
  const drawn = useRef(false);
  useEffect(() => {
    drawn.current = false;
  });
  useFrame((state, dt) => {
    if (!motion && drawn.current) return;
    drawn.current = true;
    update(motion ? state.clock.elapsedTime : 0, Math.min(dt, 0.1));
  });
}
