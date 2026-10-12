/**
 * Procedural low-poly stand-ins for every model key the area view uses. Each is built once,
 * sized so its largest dimension is ~1 with its base on y=0 (same contract as normalised GLBs).
 */
import type { CropId } from '@bh/domain';
import type { BufferGeometry, Material } from 'three';
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  IcosahedronGeometry,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface Part {
  geometry: BufferGeometry;
  material: Material | Material[];
}

const mats = new Map<string, MeshStandardMaterial>();
const mat = (color: string) => {
  let m = mats.get(color);
  if (!m) {
    m = new MeshStandardMaterial({ color, flatShading: true, roughness: 0.85 });
    mats.set(color, m);
  }
  return m;
};

type G = BufferGeometry;
const at = (g: G, x: number, y: number, z: number, rx = 0, rz = 0) => {
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  return g.translate(x, y, z);
};
const box = (w: number, h: number, d: number, x: number, y: number, z: number) =>
  at(new BoxGeometry(w, h, d), x, y, z);
/** Merge geometries that share one colour into a single part. */
const part = (color: string, ...gs: G[]): Part => ({
  geometry: gs.length === 1 ? gs[0]! : mergeGeometries(gs.map((g) => g.toNonIndexed()))!,
  material: mat(color),
});

const legs = (w: number, d: number, h: number, r: number) =>
  [-1, 1].flatMap((sx) =>
    [-1, 1].map((sz) => at(new CylinderGeometry(r, r, h, 5), (sx * w) / 2, h / 2, (sz * d) / 2)),
  );

const BUILDERS: Record<string, () => Part[]> = {
  tree1: () => [
    part('#7a5230', at(new CylinderGeometry(0.06, 0.09, 0.5, 6), 0, 0.25, 0)),
    part(
      '#4f8f3a',
      at(new IcosahedronGeometry(0.36, 0), 0, 0.68, 0),
      at(new IcosahedronGeometry(0.24, 0), 0.18, 0.55, 0.1),
    ),
  ],
  tree2: () => [
    part('#6b4a2c', at(new CylinderGeometry(0.04, 0.06, 0.3, 6), 0, 0.15, 0)),
    part(
      '#2f6b3f',
      at(new ConeGeometry(0.28, 0.5, 7), 0, 0.45, 0),
      at(new ConeGeometry(0.2, 0.4, 7), 0, 0.75, 0),
    ),
  ],
  palm: () => [
    part('#8a6a43', at(new CylinderGeometry(0.03, 0.05, 0.85, 6), 0.06, 0.42, 0, 0, -0.12)),
    part(
      '#3f8a3a',
      ...[0, 1, 2, 3, 4, 5].map((i) => {
        const g = new BoxGeometry(0.42, 0.015, 0.09).translate(0.21, 0, 0).rotateZ(-0.45);
        return g.rotateY((i / 6) * Math.PI * 2).translate(0.11, 0.86, 0);
      }),
    ),
  ],
  bush: () => [part('#2f7a3c', at(new SphereGeometry(0.5, 8, 6).scale(1, 0.6, 1), 0, 0.3, 0))],
  rock: () => [
    part('#9a958c', at(new DodecahedronGeometry(0.5, 0).scale(1, 0.55, 0.8), 0, 0.25, 0)),
  ],
  grass: () => [part('#7fae4a', at(new ConeGeometry(0.15, 1, 4), 0, 0.5, 0))],
  cropRice: () => [
    part(
      '#6fbf4a',
      ...[-0.12, 0, 0.12].map((x, i) =>
        at(new ConeGeometry(0.05, 1, 4), x, 0.5, (i - 1) * 0.05, 0, x * 1.5),
      ),
    ),
  ],
  cropCorn: () => [
    part('#4f9a3a', at(new CylinderGeometry(0.04, 0.05, 1, 5), 0, 0.5, 0)),
    part(
      '#7cbf4e',
      at(new ConeGeometry(0.16, 0.5, 4), 0, 0.55, 0),
      at(new ConeGeometry(0.12, 0.4, 4), 0, 0.85, 0),
    ),
  ],
  cropWheat: () => [
    part('#a8b84e', ...[-0.1, 0.1].map((x) => at(new ConeGeometry(0.08, 1, 5), x, 0.5, 0))),
  ],
  cropTomato: () => [
    part('#4f9a3a', at(new IcosahedronGeometry(0.42, 0), 0, 0.42, 0)),
    part(
      '#d8432f',
      at(new SphereGeometry(0.09, 6, 4), 0.3, 0.45, 0.2),
      at(new SphereGeometry(0.08, 6, 4), -0.25, 0.55, -0.15),
    ),
  ],
  cropGeneric: () => [
    part('#7f9a4a', at(new IcosahedronGeometry(0.4, 0).scale(1, 0.8, 1), 0, 0.32, 0)),
  ],
  cow: () => [
    part(
      '#f2eee6',
      box(0.7, 0.32, 0.3, 0, 0.42, 0),
      box(0.2, 0.2, 0.18, 0.42, 0.55, 0),
      ...legs(0.5, 0.2, 0.28, 0.035),
    ),
    part(
      '#4a3a2c',
      box(0.2, 0.12, 0.31, -0.05, 0.5, 0),
      at(new ConeGeometry(0.03, 0.1, 4), 0.45, 0.7, 0.06),
    ),
  ],
  goat: () => [
    part(
      '#8a6f55',
      box(0.6, 0.3, 0.26, 0, 0.5, 0),
      box(0.18, 0.2, 0.15, 0.36, 0.68, 0),
      ...legs(0.42, 0.16, 0.36, 0.03),
    ),
  ],
  chicken: () => [
    part(
      '#fbf6ea',
      at(new SphereGeometry(0.32, 7, 5), 0, 0.4, 0),
      at(new SphereGeometry(0.18, 6, 4), 0.28, 0.72, 0),
    ),
    part('#d8432f', box(0.12, 0.1, 0.04, 0.3, 0.92, 0)),
    part(
      '#e3a020',
      at(new ConeGeometry(0.05, 0.12, 4), 0.46, 0.72, 0, 0, -Math.PI / 2),
      ...legs(0.1, 0.1, 0.12, 0.02),
    ),
  ],
  tractor: () => [
    part('#c8321f', box(0.7, 0.28, 0.4, 0, 0.42, 0), box(0.3, 0.32, 0.38, -0.18, 0.72, 0)),
    part(
      '#2a2622',
      at(new CylinderGeometry(0.22, 0.22, 0.12, 10), -0.22, 0.22, 0.25, Math.PI / 2),
      at(new CylinderGeometry(0.22, 0.22, 0.12, 10), -0.22, 0.22, -0.25, Math.PI / 2),
      at(new CylinderGeometry(0.13, 0.13, 0.1, 8), 0.28, 0.13, 0.22, Math.PI / 2),
      at(new CylinderGeometry(0.13, 0.13, 0.1, 8), 0.28, 0.13, -0.22, Math.PI / 2),
      at(new CylinderGeometry(0.025, 0.025, 0.3, 5), 0.2, 0.7, 0),
    ),
  ],
  farmer: () => [
    part('#f4f0e4', at(new CylinderGeometry(0.11, 0.14, 0.5, 7), 0, 0.45, 0)),
    part(
      '#3c6aa8',
      at(new CylinderGeometry(0.06, 0.06, 0.22, 5), 0.06, 0.11, 0),
      at(new CylinderGeometry(0.06, 0.06, 0.22, 5), -0.06, 0.11, 0),
    ),
    part('#8a5a3a', at(new SphereGeometry(0.1, 8, 6), 0, 0.8, 0)),
    part(
      '#d9b860',
      at(new CylinderGeometry(0.22, 0.24, 0.03, 10), 0, 0.88, 0),
      at(new ConeGeometry(0.1, 0.1, 8), 0, 0.94, 0),
    ),
  ],
  barn: () => [
    part('#a8382a', box(1, 0.55, 0.7, 0, 0.275, 0)),
    part(
      '#5a4a3c',
      at(new ConeGeometry(0.72, 0.35, 4).rotateY(Math.PI / 4).scale(1, 1, 0.75), 0, 0.72, 0),
    ),
  ],
  farmhouse: () => [
    part('#efe2c4', box(0.9, 0.45, 0.6, 0, 0.225, 0)),
    part(
      '#b5532f',
      at(new ConeGeometry(0.66, 0.35, 4).rotateY(Math.PI / 4).scale(1, 1, 0.75), 0, 0.62, 0),
    ),
  ],
  well: () => [
    part('#9a958c', at(new CylinderGeometry(0.3, 0.3, 0.3, 10, 1, true), 0, 0.15, 0)),
    part(
      '#6b4a2c',
      box(0.04, 0.6, 0.04, 0.26, 0.3, 0),
      box(0.04, 0.6, 0.04, -0.26, 0.3, 0),
      box(0.6, 0.04, 0.04, 0, 0.6, 0),
    ),
  ],
  bird: () => [
    part(
      '#3a3530',
      box(0.5, 0.03, 0.14, 0.25, 0, 0).rotateZ(0.35),
      box(0.5, 0.03, 0.14, -0.25, 0, 0).rotateZ(-0.35),
    ),
  ],
};

/** Model variants that share a primitive stand-in. */
const ALIAS: Record<string, string> = {
  treeCube: 'tree1',
  acacia: 'tree1',
  pine: 'tree2',
  bush2: 'bush',
  rockTall: 'rock',
};

const cache = new Map<string, Part[]>();
export function fallbackParts(key: string): Part[] {
  let p = cache.get(key);
  if (!p) {
    p = (BUILDERS[ALIAS[key] ?? key] ?? BUILDERS.cropGeneric!)();
    cache.set(key, p);
  }
  return p;
}

/** Model key and mature height (scene units) per crop. */
export const CROP_LOOK: Record<CropId, { model: string; height: number }> = {
  rice: { model: 'cropRice', height: 1.1 },
  ragi: { model: 'cropWheat', height: 1 },
  maize: { model: 'cropCorn', height: 2.2 },
  sugarcane: { model: 'cropCorn', height: 2.8 },
  tomato: { model: 'cropTomato', height: 1 },
  chickpea: { model: 'cropGeneric', height: 0.8 },
};
