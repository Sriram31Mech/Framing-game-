/**
 * Operated holdings as tiny farms (a furrowed field patch per holding), the player's own marked
 * by a bobbing marker; harvest-ready fields turn golden with a bouncing marker and orbiting
 * sparkles. Mandis are little market stalls with a spinning price coin.
 */
import { useThree } from '@react-three/fiber';
import { useMemo } from 'react';
import { Color, Object3D } from 'three';
import { rngFrom } from '../../lib/random';
import { KM, LAND_TOP } from './geometry';
import { makeBuffers, Prop, useTick } from './Instanced';
import { COIN, FIELD, glossy, glowMat, MARKER, solid, SPARKLE, STALL } from './parts';

interface Pin {
  id: string;
  x: number;
  y: number;
  kind: 'mine' | 'ready' | 'ai' | 'other';
}

const dummy = new Object3D();
const tmp = new Color();
function put(arr: Float32Array, i: number) {
  dummy.updateMatrix();
  dummy.matrix.toArray(arr, i * 16);
}

/** Growing-crop greens for the player's fields (picked per holding so neighbours differ). */
const MY_CROPS = ['#4caf50', '#7cc35a', '#3f9a4f', '#9ccc65'];
const FIELD_COLOR: Record<Pin['kind'], string> = {
  mine: '#4caf50',
  ready: '#f2c230',
  ai: '#8fa58a',
  other: '#a9a48e',
};
const MARKER_COLOR = { mine: '#ff9f1c', ready: '#ffd23f' };
const SPARKS = 3;

export function Holdings({
  pins,
  motion,
  onSelectPin,
}: {
  pins: Pin[];
  motion: boolean;
  onSelectPin?: (id: string) => void;
}) {
  const camera = useThree((s) => s.camera);
  const sys = useMemo(() => {
    const fields = makeBuffers(pins.length, true);
    const marked = pins.filter((p) => p.kind === 'mine' || p.kind === 'ready');
    const ready = pins.filter((p) => p.kind === 'ready');
    const markers = makeBuffers(marked.length, true);
    const sparks = makeBuffers(ready.length * SPARKS, true);
    pins.forEach((p, i) => {
      const rand = rngFrom(p.id);
      const own = p.kind === 'mine' || p.kind === 'ready';
      const size = own ? 2.2 : 1.5;
      dummy.position.set(p.x * KM, LAND_TOP + 0.02, p.y * KM);
      dummy.rotation.set(0, rand() * Math.PI, 0);
      dummy.scale.set(size, own ? 1.4 : 0.8, size);
      put(fields.matrices.array as Float32Array, i);
      tmp.set(
        p.kind === 'mine' ? MY_CROPS[Math.floor(rand() * MY_CROPS.length)]! : FIELD_COLOR[p.kind],
      );
      fields.colors!.setXYZ(i, tmp.r, tmp.g, tmp.b);
    });
    marked.forEach((p, i) => {
      tmp.set(MARKER_COLOR[p.kind as 'mine' | 'ready']);
      markers.colors!.setXYZ(i, tmp.r, tmp.g, tmp.b);
    });
    for (let i = 0; i < ready.length * SPARKS; i++) {
      tmp.set(i % 2 ? '#fff6b0' : '#ffd23f');
      sparks.colors!.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    return { fields, markers, sparks, marked, ready };
  }, [pins]);

  useTick((clock) => {
    const t = motion ? clock : 0;
    // Markers keep a readable on-screen size as the camera pulls back.
    const zoom = Math.min(4, Math.max(1, camera.position.y / 160));
    const ma = sys.markers.matrices.array as Float32Array;
    sys.marked.forEach((p, i) => {
      const isReady = p.kind === 'ready';
      const phase = i * 1.3;
      const bob = isReady
        ? Math.abs(Math.sin(t * 3.2 + phase)) * 2.2
        : Math.sin(t * 1.6 + phase) * 0.5;
      const pulse = isReady ? 1 + Math.sin(t * 6 + phase) * 0.12 : 1;
      const s = (isReady ? 2.6 : 2.1) * zoom * pulse;
      dummy.position.set(p.x * KM, LAND_TOP + 2.2 * zoom + bob * zoom, p.y * KM);
      dummy.rotation.set(0, t * (isReady ? 2 : 0.8) + phase, 0);
      dummy.scale.set(s, s * 1.4, s);
      put(ma, i);
    });
    const sa = sys.sparks.matrices.array as Float32Array;
    sys.ready.forEach((p, r) => {
      for (let k = 0; k < SPARKS; k++) {
        const a = t * 1.8 + (k / SPARKS) * Math.PI * 2 + r;
        const rad = 2.4 * zoom;
        const tw = motion ? 0.5 + Math.abs(Math.sin(t * 5 + k * 2 + r)) * 0.7 : 0.8;
        dummy.position.set(
          p.x * KM + Math.cos(a) * rad,
          LAND_TOP + (1.2 + Math.sin(t * 2.5 + k) * 0.6) * zoom,
          p.y * KM + Math.sin(a) * rad,
        );
        dummy.rotation.set(t * 3, t * 2 + k, 0);
        dummy.scale.setScalar(tw * zoom);
        put(sa, r * SPARKS + k);
      }
    });
    sys.markers.matrices.needsUpdate = true;
    sys.sparks.matrices.needsUpdate = true;
    // Always ticks: markers rescale with zoom even when animation is off.
  }, true);

  const pick = (list: Pin[]) => (i: number) => {
    const p = list[i];
    if (p) onSelectPin?.(p.id);
  };
  return (
    <group>
      <Prop buffers={sys.fields} geometry={FIELD} material={solid} onClick={pick(pins)} />
      <Prop
        buffers={sys.markers}
        geometry={MARKER}
        material={glossy}
        castShadow
        onClick={pick(sys.marked)}
      />
      <Prop buffers={sys.sparks} geometry={SPARKLE} material={glowMat} />
    </group>
  );
}

export function Markets({
  markets,
  motion,
}: {
  markets: { id: string; x: number; y: number }[];
  motion: boolean;
}) {
  const sys = useMemo(() => {
    const stalls = makeBuffers(markets.length);
    const coins = makeBuffers(markets.length, true);
    markets.forEach((m, i) => {
      const rand = rngFrom(m.id);
      dummy.position.set(m.x * KM, LAND_TOP, m.y * KM);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.scale.setScalar(5);
      put(stalls.matrices.array as Float32Array, i);
      tmp.set('#ffc93c');
      coins.colors!.setXYZ(i, tmp.r, tmp.g, tmp.b);
    });
    return { stalls, coins };
  }, [markets]);

  useTick((t) => {
    const ca = sys.coins.matrices.array as Float32Array;
    markets.forEach((m, i) => {
      dummy.position.set(m.x * KM, LAND_TOP + 6.2 + Math.sin(t * 2 + i) * 0.6, m.y * KM);
      dummy.rotation.set(0, t * 1.5 + i, 0);
      dummy.scale.setScalar(2.4);
      put(ca, i);
    });
    sys.coins.matrices.needsUpdate = true;
  }, motion);

  return (
    <group>
      <Prop
        modelKey="marketStall"
        buffers={sys.stalls}
        geometry={STALL}
        material={solid}
        castShadow
      />
      <Prop buffers={sys.coins} geometry={COIN} material={glossy} />
    </group>
  );
}
