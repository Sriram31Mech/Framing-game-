/**
 * One instanced mesh per material part, fed by either a CC0 GLB from `MODELS` (normalised so its
 * largest dimension is 1 and its base sits on y=0) or a procedural primitive fallback of the
 * same proportions. Missing / failing models silently use the fallback.
 */
import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { BufferGeometry, Material, Mesh } from 'three';
import { Box3, Color, Matrix4, Object3D, type InstancedMesh } from 'three';
import { ErrorBoundary } from '../../app/ErrorBoundary';
import { MODELS } from '../models';
import { fallbackParts, type Part } from './props';

export interface Item {
  x: number;
  y?: number;
  z: number;
  /** Largest dimension in scene units. */
  s: number;
  ry?: number;
  phase?: number;
  color?: string;
}

/** Called per instance per frame after the base transform is set; mutate `o` to move it. */
export type Animate = (i: number, t: number, o: Object3D) => void;

interface Props {
  model: string;
  items: readonly Item[];
  /** Max wind tilt in radians. */
  sway?: number;
  animate?: Animate;
}

export function modelUrl(key: string): string | undefined {
  return (MODELS as Record<string, string | undefined>)[key];
}

function useGltfParts(url: string): Part[] {
  const { scene } = useGLTF(url);
  const parts = useMemo(() => {
    scene.updateMatrixWorld(true);
    const out: Part[] = [];
    scene.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh)
        out.push({
          geometry: m.geometry.clone().applyMatrix4(m.matrixWorld),
          material: m.material,
        });
    });
    const box = new Box3();
    for (const p of out) {
      p.geometry.computeBoundingBox();
      box.union(p.geometry.boundingBox!);
    }
    const k =
      1 / Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 1e-6);
    const norm = new Matrix4()
      .makeScale(k, k, k)
      .multiply(
        new Matrix4().makeTranslation(
          -(box.min.x + box.max.x) / 2,
          -box.min.y,
          -(box.min.z + box.max.z) / 2,
        ),
      );
    for (const p of out) p.geometry.applyMatrix4(norm);
    return out;
  }, [scene]);
  useEffect(() => () => parts.forEach((p) => p.geometry.dispose()), [parts]);
  return parts;
}

const WHITE = new Color('#ffffff');

function InstancedParts({ parts, items, sway = 0, animate }: Props & { parts: Part[] }) {
  const refs = useRef<(InstancedMesh | null)[]>([]);
  const o = useMemo(() => new Object3D(), []);
  const color = useMemo(() => new Color(), []);
  const write = (t: number, colors: boolean) => {
    items.forEach((it, i) => {
      o.position.set(it.x, it.y ?? 0, it.z);
      o.rotation.set(0, it.ry ?? 0, sway ? Math.sin(t * 1.7 + (it.phase ?? i)) * sway : 0);
      o.scale.setScalar(it.s);
      animate?.(i, t, o);
      o.updateMatrix();
      if (colors) color.set(it.color ? it.color : WHITE);
      for (const m of refs.current) {
        if (!m) continue;
        m.setMatrixAt(i, o.matrix);
        if (colors) m.setColorAt(i, color);
      }
    });
    for (const m of refs.current) {
      if (!m) continue;
      m.instanceMatrix.needsUpdate = true;
      if (colors && m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  };
  useLayoutEffect(() => write(0, true));
  useFrame(({ clock }) => {
    if (sway || animate) write(clock.elapsedTime, false);
  });
  if (items.length === 0) return null;
  return (
    <>
      {parts.map((p, k) => (
        <instancedMesh
          // count is fixed at creation, so remount when it changes
          key={`${k}-${items.length}`}
          ref={(el) => {
            refs.current[k] = el;
          }}
          args={[p.geometry as BufferGeometry, p.material as Material, items.length]}
          castShadow
          receiveShadow
          frustumCulled={false}
        />
      ))}
    </>
  );
}

function GltfInstanced(props: Props & { url: string }) {
  return <InstancedParts {...props} parts={useGltfParts(props.url)} />;
}

export function Instanced(props: Props) {
  const url = modelUrl(props.model);
  const fallback = <InstancedParts {...props} parts={fallbackParts(props.model)} />;
  if (!url) return fallback;
  return (
    <ErrorBoundary fallback={() => fallback}>
      <Suspense fallback={fallback}>
        <GltfInstanced {...props} url={url} />
      </Suspense>
    </ErrorBoundary>
  );
}
