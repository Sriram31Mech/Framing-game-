/**
 * Isometric-style camera: narrow-FOV perspective at ~27–52° elevation (by zoom), orbiting a ground
 * target. Q/E or right-drag rotate, WASD/arrows or left-drag pan, wheel or +/- zoom (towards the
 * cursor), smooth exponential damping. Runs in 'demand' frameloop mode by invalidating only while
 * moving.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { PerspectiveCamera } from 'three';
import { Fog, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { useUiStore } from '../store/ui';
import { cameraState, pitchForDistance } from './cameraState';
import type { TerrainSampler } from './terrain';

export const MIN_DISTANCE = 55;

interface RigState {
  tx: number;
  tz: number;
  yaw: number;
  dist: number;
  pitchOffset: number;
  dtx: number;
  dtz: number;
  dyaw: number;
  ddist: number;
  dPitchOffset: number;
  ty: number;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function CameraRig({
  sampler,
  halfSize,
  initial,
  centroids,
}: {
  sampler: TerrainSampler;
  halfSize: number;
  initial: { x: number; z: number; distance: number };
  /** Parcel id → centroid/size, for focus requests. */
  centroids: Map<string, { x: number; y: number; sizeM: number }>;
}) {
  const { camera, gl, scene, invalidate, size } = useThree();
  const maxDist = halfSize * 2.7;
  const s = useRef<RigState>({
    tx: initial.x,
    tz: initial.z,
    yaw: -0.6,
    dist: initial.distance,
    pitchOffset: 0,
    dtx: initial.x,
    dtz: initial.z,
    dyaw: -0.6,
    ddist: initial.distance,
    dPitchOffset: 0,
    ty: sampler.heightAt(initial.x, initial.z),
  });
  const keys = useRef(new Set<string>());
  const centroidsRef = useRef(centroids);
  centroidsRef.current = centroids;

  // Focus requests from the UI (double-click a parcel, pick from the map list).
  useEffect(() => {
    return useUiStore.subscribe((st, prev) => {
      if (!st.focus || st.focus === prev.focus) return;
      const c = centroidsRef.current.get(st.focus.parcelId);
      if (!c) return;
      s.current.dtx = c.x;
      s.current.dtz = c.y;
      s.current.ddist = Math.max(MIN_DISTANCE * 2, Math.min(950, c.sizeM * 3.4));
      invalidate();
    });
  }, [invalidate]);

  useEffect(() => {
    const el = gl.domElement;
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    const plane = new Plane(new Vector3(0, 1, 0), 0);
    const hit = new Vector3();
    let drag: { button: number; x: number; y: number } | null = null;

    const groundUnder = (clientX: number, clientY: number): Vector3 | null => {
      const r = el.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      plane.constant = -s.current.ty;
      return raycaster.ray.intersectPlane(plane, hit);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2 && e.button !== 1) return;
      drag = { button: e.button, x: e.clientX, y: e.clientY };
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const st = s.current;
      if (drag.button === 0 && !e.shiftKey) {
        const cam = camera as PerspectiveCamera;
        const pitch = pitchForDistance(st.dist, MIN_DISTANCE, maxDist) + st.pitchOffset;
        const wpp =
          (2 * st.dist * Math.tan(((cam.fov ?? 30) * Math.PI) / 360)) /
          Math.max(1, el.clientHeight);
        const sin = Math.sin(st.dyaw);
        const cos = Math.cos(st.dyaw);
        // Grab-and-drag: right = (cos, -sin), forward = (-sin, -cos) in xz.
        st.dtx -= cos * dx * wpp;
        st.dtz += sin * dx * wpp;
        const k = wpp / Math.max(0.35, Math.sin(pitch));
        st.dtx += -sin * dy * k;
        st.dtz += -cos * dy * k;
      } else {
        st.dyaw -= dx * 0.006;
        st.dPitchOffset = Math.max(-0.22, Math.min(0.3, st.dPitchOffset + dy * 0.003));
      }
      invalidate();
    };
    const onPointerUp = () => {
      drag = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const st = s.current;
      const before = st.ddist;
      st.ddist = Math.max(MIN_DISTANCE, Math.min(maxDist, st.ddist * Math.exp(e.deltaY * 0.0014)));
      const p = groundUnder(e.clientX, e.clientY);
      if (p && st.ddist < before) {
        const f = 1 - st.ddist / before;
        st.dtx += (p.x - st.dtx) * f;
        st.dtz += (p.z - st.dtz) * f;
      }
      invalidate();
    };
    const onContext = (e: Event) => e.preventDefault();
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const k = e.key.toLowerCase();
      if (
        [
          'w',
          'a',
          's',
          'd',
          'q',
          'e',
          'arrowup',
          'arrowdown',
          'arrowleft',
          'arrowright',
          '+',
          '=',
          '-',
          '_',
        ].includes(k)
      ) {
        if (k.startsWith('arrow')) e.preventDefault();
        keys.current.add(k);
        invalidate();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    const onBlur = () => keys.current.clear();

    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [camera, gl, invalidate, maxDist]);

  useFrame((_, rawDt) => {
    const dt = Math.min(0.1, rawDt);
    const st = s.current;
    const k = keys.current;
    if (k.size > 0) {
      const speed = st.dist * 0.9 * dt;
      const sin = Math.sin(st.dyaw);
      const cos = Math.cos(st.dyaw);
      let fwd = 0;
      let right = 0;
      if (k.has('w') || k.has('arrowup')) fwd += 1;
      if (k.has('s') || k.has('arrowdown')) fwd -= 1;
      if (k.has('d') || k.has('arrowright')) right += 1;
      if (k.has('a') || k.has('arrowleft')) right -= 1;
      st.dtx += (-sin * fwd + cos * right) * speed;
      st.dtz += (-cos * fwd - sin * right) * speed;
      if (k.has('q')) st.dyaw += 1.5 * dt;
      if (k.has('e')) st.dyaw -= 1.5 * dt;
      if (k.has('+') || k.has('='))
        st.ddist = Math.max(MIN_DISTANCE, st.ddist * Math.exp(-1.6 * dt));
      if (k.has('-') || k.has('_')) st.ddist = Math.min(maxDist, st.ddist * Math.exp(1.6 * dt));
    }
    const lim = halfSize * 0.97;
    st.dtx = Math.max(-lim, Math.min(lim, st.dtx));
    st.dtz = Math.max(-lim, Math.min(lim, st.dtz));

    const a = 1 - Math.exp(-dt * 7);
    st.tx += (st.dtx - st.tx) * a;
    st.tz += (st.dtz - st.tz) * a;
    st.yaw += (st.dyaw - st.yaw) * a;
    st.dist += (st.ddist - st.dist) * a;
    st.pitchOffset += (st.dPitchOffset - st.pitchOffset) * a;
    const groundY = sampler.heightAt(st.tx, st.tz);
    st.ty += (groundY - st.ty) * a;

    const pitch = Math.max(
      0.2,
      Math.min(1.35, pitchForDistance(st.dist, MIN_DISTANCE, maxDist) + st.pitchOffset),
    );
    const horiz = Math.cos(pitch) * st.dist;
    camera.position.set(
      st.tx + Math.sin(st.yaw) * horiz,
      st.ty + Math.sin(pitch) * st.dist,
      st.tz + Math.cos(st.yaw) * horiz,
    );
    camera.lookAt(st.tx, st.ty, st.tz);
    const cam = camera as PerspectiveCamera;
    const near = Math.max(1.5, st.dist * 0.04);
    if (Math.abs(cam.near - near) / near > 0.15) {
      cam.near = near;
      cam.far = Math.max(8000, st.dist * 4);
      cam.updateProjectionMatrix();
    }
    if (scene.fog instanceof Fog) {
      scene.fog.near = st.dist * 1.1;
      scene.fog.far = st.dist * 4.2 + 1500;
    }

    const moving =
      k.size > 0 ||
      Math.abs(st.dtx - st.tx) > 0.05 ||
      Math.abs(st.dtz - st.tz) > 0.05 ||
      Math.abs(st.dyaw - st.yaw) > 0.0005 ||
      Math.abs(st.ddist - st.dist) > 0.05 ||
      Math.abs(groundY - st.ty) > 0.02 ||
      Math.abs(st.dPitchOffset - st.pitchOffset) > 0.0005;
    cameraState.targetX = st.tx;
    cameraState.targetY = st.ty;
    cameraState.targetZ = st.tz;
    cameraState.distance = st.dist;
    cameraState.yaw = st.yaw;
    cameraState.moved = moving;
    if (moving) invalidate();
  });

  // Keep aspect in sync on resize (R3F handles the projection; just repaint once).
  useEffect(() => invalidate(), [size, invalidate]);
  return null;
}

/** Slow cinematic orbit for the landing backdrop. */
export function LandingOrbit({ sampler, halfSize }: { sampler: TerrainSampler; halfSize: number }) {
  const { camera, scene } = useThree();
  const yaw = useRef(-0.9);
  useFrame((_, dt) => {
    yaw.current += Math.min(0.1, dt) * 0.03;
    const dist = halfSize * 0.95;
    const tx = halfSize * 0.12;
    const tz = -halfSize * 0.05;
    const ty = sampler.heightAt(tx, tz);
    const pitch = 0.5;
    const horiz = Math.cos(pitch) * dist;
    camera.position.set(
      tx + Math.sin(yaw.current) * horiz,
      ty + Math.sin(pitch) * dist,
      tz + Math.cos(yaw.current) * horiz,
    );
    camera.lookAt(tx - halfSize * 0.12, ty, tz);
    cameraState.targetX = tx;
    cameraState.targetY = ty;
    cameraState.targetZ = tz;
    cameraState.distance = dist;
    cameraState.moved = true;
    if (scene.fog instanceof Fog) {
      scene.fog.near = dist * 0.9;
      scene.fog.far = dist * 3.6;
    }
  });
  return null;
}
