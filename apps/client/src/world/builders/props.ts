/**
 * Procedural low-poly props authored in code: village houses, temple with gopuram, school,
 * overhead water tank, warehouse, APMC mandi yard, lorry and tractor, trees and palms.
 * Each function draws into a MeshBuilder in a local frame: ground at y = 0, "front" facing +z
 * for buildings and +x for vehicles.
 */
import { Color } from 'three';
import type { MeshBuilder } from './meshBuilder';

const C = (hex: string) => new Color(hex);

const PLINTH = C('#a39a8a');
const STONE = C('#b8ab93');
const STONE_DARK = C('#8f846f');
const DOOR = C('#5a3a24');
const WINDOW = C('#2b333d');
const FRAME = C('#e9e2d2');
const WALLS = ['#efe8dc', '#e7c472', '#a9c9d9', '#e8b2a6', '#cfd99a', '#ecae66', '#f1e6cf'].map(C);
const ROOFS = ['#b5532f', '#a8482b', '#c0603a', '#9c4a2c', '#b9643f'].map(C);
const CONCRETE = C('#cfc8bb');
const METAL_ROOF = C('#7e93a3');
const GREEN_ROOF = C('#5b8c74');
const SAFFRON = C('#e8892c');
const GOLD = C('#d9a93a');
const TEMPLE_CREAM = C('#efe3c6');
const TEMPLE_OCHRE = C('#d8a24a');
const TEMPLE_RED = C('#c1442f');
const TEMPLE_WHITE = C('#f3ede0');
const SACK = C('#c9ad7a');
const SACK_DARK = C('#a88e60');

type Rand = () => number;
const pick = <T>(arr: readonly T[], r: Rand): T => arr[Math.floor(r() * arr.length) % arr.length]!;
const shade = (c: Color, k: number) => c.clone().multiplyScalar(k);

/** Foundation that extends below ground so buildings never float on slopes. */
function plinth(b: MeshBuilder, w: number, d: number, top: number, color: Color = PLINTH): void {
  b.box(0, -2, 0, w, 2 + top, d, color);
}

export function house(b: MeshBuilder, r: Rand): { w: number; d: number } {
  const w = 7 + r() * 4;
  const d = 6 + r() * 2.5;
  const twoStorey = r() < 0.22;
  const wallH = twoStorey ? 6.2 : 3.1 + r() * 0.5;
  const wall = pick(WALLS, r);
  const base = 0.45;
  plinth(b, w + 0.5, d + 0.5, base);
  b.box(0, base, 0, w, wallH, d, wall);
  b.box(0, base, 0, w + 0.08, 0.85, d + 0.08, shade(wall, 0.78));
  // door + windows on the front (+z)
  b.box(-w * 0.12, base, d / 2 + 0.02, 1.1, 2.1, 0.1, DOOR);
  for (const wx of [-w * 0.36, w * 0.18, w * 0.36]) {
    if (Math.abs(wx + w * 0.12) < 1) continue;
    b.box(wx, base + 1.1, d / 2 + 0.02, 1.05, 1.05, 0.12, FRAME);
    b.box(wx, base + 1.18, d / 2 + 0.06, 0.85, 0.85, 0.1, WINDOW);
  }
  if (twoStorey) {
    for (const wx of [-w * 0.25, w * 0.25]) {
      b.box(wx, base + 4.1, d / 2 + 0.02, 1.1, 1.1, 0.12, FRAME);
      b.box(wx, base + 4.18, d / 2 + 0.06, 0.9, 0.9, 0.1, WINDOW);
    }
    const top = base + wallH;
    b.box(0, top, 0, w + 0.3, 0.25, d + 0.3, CONCRETE);
    // parapet
    b.box(0, top + 0.25, d / 2 + 0.05, w + 0.3, 0.8, 0.2, wall);
    b.box(0, top + 0.25, -d / 2 - 0.05, w + 0.3, 0.8, 0.2, wall);
    b.box(w / 2 + 0.05, top + 0.25, 0, 0.2, 0.8, d + 0.3, wall);
    b.box(-w / 2 - 0.05, top + 0.25, 0, 0.2, 0.8, d + 0.3, wall);
    // stair head room with a small tiled roof
    b.box(-w * 0.25, top + 0.25, -d * 0.15, 2.6, 2.3, 2.6, wall);
    b.gableRoof(-w * 0.25, top + 2.55, -d * 0.15, 3.2, 3.2, 1.0, pick(ROOFS, r), wall);
    // water tank (sintex) — a very common rooftop silhouette
    b.cylinder(w * 0.28, top + 0.25, -d * 0.2, 0.7, 0.7, 1.3, 8, C('#2a2a2a'));
  } else {
    const roof = pick(ROOFS, r);
    const roofH = 1.9 + r() * 0.7;
    if (r() < 0.55) b.gableRoof(0, base + wallH, 0, w + 1.2, d + 1.3, roofH, roof, wall);
    else b.hipRoof(0, base + wallH, 0, w + 1.2, d + 1.3, roofH, roof, shade(roof, 0.92));
    if (r() < 0.55) {
      // front veranda (thinnai): posts + lean-to tiled roof
      const vd = 2.2;
      for (const px of [-w / 2 + 0.4, 0, w / 2 - 0.4])
        b.box(px, base, d / 2 + vd - 0.2, 0.22, 2.5, 0.22, FRAME);
      b.box(0, -0.2, d / 2 + vd / 2, w, base + 0.2, vd, PLINTH);
      b.with({ y: base + 2.5, z: d / 2 + vd / 2, rx: 0.32 }, () =>
        b.box(0, 0, 0, w + 0.4, 0.14, vd + 0.6, roof),
      );
    }
  }
  return { w, d };
}

export function temple(b: MeshBuilder): void {
  // Raised granite platform and striped (kaavi) compound wall.
  plinth(b, 34, 26, 1.1, STONE);
  const wallH = 2.4;
  const seg = 1.6;
  const side = (
    len: number,
    place: (t: number) => [number, number],
    alongX: boolean,
    gap: [number, number] | null,
  ) => {
    const n = Math.round(len / seg);
    for (let i = 0; i < n; i++) {
      const t = -len / 2 + (i + 0.5) * (len / n);
      if (gap && t > gap[0] && t < gap[1]) continue;
      const [x, z] = place(t);
      const col = i % 2 === 0 ? TEMPLE_RED : TEMPLE_WHITE;
      if (alongX) b.box(x, 1.1, z, len / n, wallH, 0.6, col);
      else b.box(x, 1.1, z, 0.6, wallH, len / n, col);
    }
  };
  side(33, (t) => [t, 12.7], true, [-3.4, 3.4]);
  side(33, (t) => [t, -12.7], true, null);
  side(25, (t) => [16.2, t], false, null);
  side(25, (t) => [-16.2, t], false, null);
  // wall coping
  for (const [x, z, w, d] of [
    [0, 12.7, 33.2, 0.8],
    [0, -12.7, 33.2, 0.8],
    [16.2, 0, 0.8, 25.4],
    [-16.2, 0, 0.8, 25.4],
  ] as const) {
    if (z === 12.7) {
      b.box(-10.1, 1.1 + wallH, z, 13, 0.25, d, STONE);
      b.box(10.1, 1.1 + wallH, z, 13, 0.25, d, STONE);
    } else b.box(x, 1.1 + wallH, z, w, 0.25, d, STONE);
  }

  // Gopuram over the entrance (front, +z).
  b.with({ z: 12.4, y: 1.1 }, () => {
    b.box(0, 0, 0, 10, 5.5, 6.4, STONE);
    b.box(0, 0, 3.25, 3, 4, 0.1, DOOR);
    b.box(0, 5.5, 0, 10.6, 0.5, 7, STONE_DARK);
    let w = 9.4;
    let d = 5.8;
    let y = 6;
    for (let tier = 0; tier < 6; tier++) {
      const col = tier % 2 === 0 ? TEMPLE_CREAM : TEMPLE_OCHRE;
      b.box(0, y, 0, w, 2.3, d, col);
      // cornice band and little niches (kudus)
      b.box(0, y + 2.3, 0, w + 0.5, 0.35, d + 0.5, TEMPLE_RED);
      for (let k = -2; k <= 2; k++)
        b.box((k * w) / 5.5, y + 0.5, d / 2 + 0.1, 0.55, 1.2, 0.25, shade(col, 0.8));
      y += 2.65;
      w *= 0.84;
      d *= 0.86;
    }
    // barrel-vault crown (shala) + golden kalasams
    b.with({ y }, () => {
      const L = w + 1.2;
      const R = d * 0.65;
      for (let i = 0; i < 6; i++) {
        const a0 = (i / 6) * Math.PI;
        const a1 = ((i + 1) / 6) * Math.PI;
        b.quad(
          [-L / 2, Math.sin(a0) * R * 1.3, Math.cos(a0) * R],
          [L / 2, Math.sin(a0) * R * 1.3, Math.cos(a0) * R],
          [L / 2, Math.sin(a1) * R * 1.3, Math.cos(a1) * R],
          [-L / 2, Math.sin(a1) * R * 1.3, Math.cos(a1) * R],
          TEMPLE_OCHRE,
        );
      }
      for (const s of [-1, 1]) {
        // end caps
        for (let i = 0; i < 6; i++) {
          const a0 = (i / 6) * Math.PI;
          const a1 = ((i + 1) / 6) * Math.PI;
          const x = (s * L) / 2;
          const p0: [number, number, number] = [x, Math.sin(a0) * R * 1.3, Math.cos(a0) * R];
          const p1: [number, number, number] = [x, Math.sin(a1) * R * 1.3, Math.cos(a1) * R];
          if (s > 0) b.tri([x, 0, 0], p0, p1, TEMPLE_CREAM);
          else b.tri([x, 0, 0], p1, p0, TEMPLE_CREAM);
        }
      }
      for (let k = -2; k <= 2; k++) {
        b.cylinder((k * L) / 5.2, R * 1.3 - 0.1, 0, 0.32, 0.05, 1.3, 6, GOLD);
      }
    });
  });

  // Mandapa: pillared hall with a flat roof.
  b.with({ y: 1.1, z: 1 }, () => {
    for (let ix = -2; ix <= 2; ix++)
      for (let iz = -1; iz <= 1; iz++) b.box(ix * 2.6, 0, iz * 2.8, 0.55, 3.6, 0.55, STONE);
    b.box(0, 3.6, 0, 14, 0.6, 9.4, STONE_DARK);
    b.box(0, 4.2, 0, 13.4, 0.35, 8.8, TEMPLE_CREAM);
  });

  // Main shrine (vimana) at the back: stepped pyramid + dome + kalasam.
  b.with({ y: 1.1, z: -7.5 }, () => {
    b.box(0, 0, 0, 8, 4.5, 7, STONE);
    let s = 7;
    let y = 4.5;
    for (let tier = 0; tier < 3; tier++) {
      b.box(0, y, 0, s, 1.6, s * 0.92, tier % 2 ? TEMPLE_OCHRE : TEMPLE_CREAM);
      b.box(0, y + 1.6, 0, s + 0.3, 0.25, s * 0.92 + 0.3, TEMPLE_RED);
      y += 1.85;
      s *= 0.76;
    }
    b.blob(0, y + 1, 0, s * 0.62, 1.4, s * 0.62, TEMPLE_OCHRE, 2);
    b.cylinder(0, y + 2.2, 0, 0.35, 0.05, 1.6, 6, GOLD);
  });

  // Dhwajasthambha (flag mast) in front of the mandapa.
  b.cylinder(0, 1.1, 7.6, 0.6, 0.6, 0.8, 8, STONE);
  b.cylinder(0, 1.9, 7.6, 0.18, 0.12, 9.5, 8, GOLD);
}

export function school(b: MeshBuilder): void {
  const cream = C('#f0e6cc');
  const blue = C('#3f6fb5');
  // playground
  b.box(0, -0.4, 14, 34, 0.48, 18, C('#c8ad84'));
  plinth(b, 30, 10, 0.5);
  b.box(0, 0.5, 0, 28, 3.6, 8, cream);
  b.box(0, 0.5, 0, 28.1, 1.0, 8.1, blue);
  for (let i = -5; i <= 5; i++) {
    b.box(i * 2.5, 1.7, 4.05, 1.3, 1.4, 0.1, FRAME);
    b.box(i * 2.5, 1.8, 4.1, 1.05, 1.15, 0.1, WINDOW);
  }
  b.gableRoof(0, 4.1, 0, 29.4, 9.6, 2.3, ROOFS[0]!, cream);
  // L wing
  b.with({ x: 15, z: 7 }, () => {
    plinth(b, 9, 12, 0.5);
    b.box(0, 0.5, 0, 8, 3.6, 11, cream);
    b.box(0, 0.5, 0, 8.1, 1.0, 11.1, blue);
    b.with({ ry: Math.PI / 2 }, () => b.gableRoof(0, 4.1, 0, 12.4, 9.6, 2.3, ROOFS[1]!, cream));
  });
  // flag mast with tricolour
  b.cylinder(-8, 0, 14, 0.09, 0.07, 8, 6, C('#dcdcdc'));
  b.box(-7.1, 6.9, 14, 1.6, 0.36, 0.05, C('#ff9933'));
  b.box(-7.1, 6.54, 14, 1.6, 0.36, 0.05, C('#ffffff'));
  b.box(-7.1, 6.18, 14, 1.6, 0.36, 0.05, C('#138808'));
}

export function waterTank(b: MeshBuilder): void {
  const conc = C('#d7d1c4');
  plinth(b, 9, 9, 0.3, CONCRETE);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.box(Math.cos(a) * 3.2, 0.3, Math.sin(a) * 3.2, 0.5, 14, 0.5, conc);
  }
  for (const y of [5, 10]) b.cylinder(0, y, 0, 3.5, 3.5, 0.35, 12, conc, { capTop: false });
  b.cylinder(0, 14.3, 0, 4.2, 5.2, 1.2, 14, conc);
  b.cylinder(0, 15.5, 0, 5.2, 5.2, 3.4, 14, C('#e6e1d6'));
  b.cylinder(0, 15.9, 0, 5.25, 5.25, 0.5, 14, C('#4f86b8'), { capTop: false });
  b.cylinder(0, 18.9, 0, 5.4, 0.6, 1.4, 14, conc);
}

export function warehouse(b: MeshBuilder, scale = 1): void {
  const wall = C('#dcd5c6');
  const w = 36 * scale;
  const d = 18;
  plinth(b, w + 1, d + 5, 1.1, CONCRETE);
  b.box(0, 1.1, 0, w, 6.5, d, wall);
  b.box(0, 1.1, 0, w + 0.1, 1.2, d + 0.1, shade(wall, 0.8));
  b.gableRoof(0, 7.6, 0, w + 1.4, d + 1.6, 3.4, METAL_ROOF, wall);
  // ridge vent
  b.box(0, 10.9, 0, w * 0.9, 0.5, 1, shade(METAL_ROOF, 0.85));
  // roller shutters + loading platform
  const n = Math.max(3, Math.round(w / 10));
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (i + 0.5) * (w / n);
    b.box(x, 1.1, d / 2 + 0.03, 4.2, 4.6, 0.12, C('#6d7378'));
  }
  b.box(0, 1.1, d / 2 + 0.8, w * 0.92, 0.12, 1.6, shade(METAL_ROOF, 0.7));
  // signage band (saffron)
  b.box(0, 6.2, d / 2 + 0.05, w * 0.5, 1.0, 0.12, SAFFRON);
  // sacks stacked outside
  sacks(b, -w / 2 + 3, d / 2 + 3.5, 2, 3);
}

function sacks(b: MeshBuilder, x: number, z: number, rows: number, cols: number): void {
  for (let lvl = 0; lvl < 3; lvl++) {
    for (let i = 0; i < cols - lvl; i++) {
      for (let j = 0; j < rows; j++) {
        b.box(
          x + i * 1.0 + lvl * 0.5,
          1.1 + lvl * 0.42,
          z + j * 0.7,
          0.9,
          0.42,
          0.62,
          (i + j + lvl) % 2 ? SACK : SACK_DARK,
        );
      }
    }
  }
}

/** APMC regulated market yard: auction shed, produce heaps, office, boundary wall, gate. */
export function mandi(b: MeshBuilder, scale = 1): void {
  const W = 70 * scale;
  const D = 50;
  b.box(0, -1.2, 0, W, 1.4, D, C('#b9ae9b'));
  // boundary wall with a gate on the front
  const wall = C('#e3dccb');
  b.box(0, 0.2, -D / 2, W, 2, 0.4, wall);
  b.box(-W / 2, 0.2, 0, 0.4, 2, D, wall);
  b.box(W / 2, 0.2, 0, 0.4, 2, D, wall);
  b.box(-W / 4 - 4, 0.2, D / 2, W / 2 - 8, 2, 0.4, wall);
  b.box(W / 4 + 4, 0.2, D / 2, W / 2 - 8, 2, 0.4, wall);
  for (const gx of [-6, 6]) b.box(gx, 0.2, D / 2, 1.2, 4.2, 1.2, SAFFRON);
  b.box(0, 4.0, D / 2, 13.2, 1.1, 0.6, C('#2f5f8f'));

  // open auction shed: column grid + broad shallow roof
  const sw = 48 * scale;
  const sd = 20;
  b.with({ z: -4 }, () => {
    b.box(0, 0.2, 0, sw + 2, 0.7, sd + 2, C('#c9c0ae'));
    for (let x = -sw / 2; x <= sw / 2 + 0.1; x += 6) {
      for (const z of [-sd / 2, 0, sd / 2]) b.box(x, 0.9, z, 0.45, 6.2, 0.45, C('#8f9aa3'));
    }
    b.gableRoof(0, 7.1, 0, sw + 3, sd + 3, 2.6, GREEN_ROOF, shade(GREEN_ROOF, 0.8));
    // produce heaps & sacks under the shed (tomato, maize, ragi, chickpea)
    const heaps = [
      C('#d8432f'),
      C('#e5b93c'),
      C('#8a4a2c'),
      C('#c9a464'),
      C('#d8432f'),
      C('#7aa04a'),
    ];
    heaps.forEach((col, i) => {
      const x = -sw / 2 + 5 + (i * (sw - 10)) / (heaps.length - 1);
      b.blob(x, 0.9, -4, 2.2, 1.0, 1.8, col, 1);
    });
    sacks(b, -sw / 2 + 4, 3, 2, 4);
    sacks(b, sw / 2 - 9, 3, 2, 4);
  });
  // office block (two storeys) with saffron sign band
  b.with({ x: W / 2 - 10, z: D / 2 - 9 }, () => {
    b.box(0, 0.2, 0, 14, 7, 9, C('#efe6d2'));
    b.box(0, 3.4, 4.55, 14, 0.4, 0.3, CONCRETE);
    for (const y of [1.4, 4.6]) {
      for (const x of [-4.5, -1.5, 1.5, 4.5]) {
        b.box(x, y, 4.52, 1.4, 1.3, 0.1, FRAME);
        b.box(x, y + 0.1, 4.56, 1.15, 1.05, 0.1, WINDOW);
      }
    }
    b.box(0, 7.2, 0, 14.4, 0.3, 9.4, CONCRETE);
    b.box(0, 7.5, 4.6, 10, 1.4, 0.25, SAFFRON);
  });
  // weighbridge + parked lorries
  b.box(-W / 2 + 12, 0.2, D / 2 - 6, 4, 0.25, 12, C('#7d7a73'));
  b.with({ x: -W / 2 + 12, y: 0.45, z: D / 2 - 6, ry: Math.PI / 2 }, () => lorry(b, 1));
  b.with({ x: 6, y: 0.2, z: D / 2 - 7, ry: 0.15 }, () => lorry(b, 3));
}

/**
 * Grain silo cluster: two cylindrical silos with a connecting conveyor shed.
 * Placed near warehouses to add vertical interest to the skyline.
 */
export function grainSilo(b: MeshBuilder): void {
  const conc = C('#d4cfc4');
  const roof = C('#7e8f9a');
  const rust = C('#8a5a3a');
  // Two silos side by side.
  for (const ox of [-5, 5]) {
    b.cylinder(ox, -1, 0, 3.2, 3.2, 1.2, 12, conc, { capTop: false });
    b.cylinder(ox, 0.2, 0, 3.2, 3.2, 14, 12, conc);
    // Conical roof.
    b.with({ x: ox, y: 14.2 }, () => {
      for (let i = 0; i < 12; i++) {
        const a0 = (i / 12) * Math.PI * 2;
        const a1 = ((i + 1) / 12) * Math.PI * 2;
        b.tri(
          [0, 3.2, 0],
          [Math.cos(a0) * 3.4, 0, Math.sin(a0) * 3.4],
          [Math.cos(a1) * 3.4, 0, Math.sin(a1) * 3.4],
          roof,
        );
      }
    });
    // Vertical ladder strip.
    b.box(ox + 3.1, 7, 0, 0.18, 12, 0.18, rust);
    for (let y = 1; y < 13; y += 1.4) b.box(ox + 3.1, y, 0, 0.18, 0.12, 0.55, rust);
  }
  // Connecting conveyor shed between silos.
  b.box(0, 10, 0, 9.6, 1.0, 2.2, C('#b8b0a4'));
  b.box(0, 11, 0, 9.8, 0.18, 2.4, roof);
  // Discharge spout at the base.
  b.cylinder(0, 0.2, 0, 0.55, 0.35, 2.8, 6, rust);
  // Foundation slab.
  b.box(0, -1, 0, 14, 0.2, 6, C('#c0bab0'));
}

/**
 * Processing shed: a larger industrial building with a chimney stack,
 * used near markets to suggest value-added processing.
 */
export function processingShed(b: MeshBuilder): void {
  const wall = C('#ddd6c8');
  const dark = C('#5a5a5a');
  plinth(b, 44, 22, 1.2, CONCRETE);
  // Main hall.
  b.box(0, 1.2, 0, 42, 8, 20, wall);
  b.box(0, 1.2, 0, 42.1, 1.4, 20.1, shade(wall, 0.78));
  b.gableRoof(0, 9.2, 0, 43.2, 21.4, 4.2, METAL_ROOF, wall);
  // Ridge vent.
  b.box(0, 13.2, 0, 38, 0.6, 1.2, shade(METAL_ROOF, 0.82));
  // Roller doors on the front.
  for (const x of [-14, -7, 0, 7, 14]) {
    b.box(x, 1.2, 10.05, 4.8, 5.2, 0.14, dark);
  }
  // Loading dock.
  b.box(0, 1.2, 11.2, 42 * 0.9, 0.14, 2.4, shade(METAL_ROOF, 0.68));
  // Chimney stack.
  b.cylinder(-16, 1.2, -6, 1.1, 0.9, 16, 8, C('#8a8070'));
  b.cylinder(-16, 17.2, -6, 1.2, 1.2, 0.6, 8, dark);
  // Signage band.
  b.box(0, 8.0, 10.08, 28, 1.2, 0.14, SAFFRON);
  // Sacks outside.
  sacks(b, -18, 12, 2, 5);
  sacks(b, 12, 12, 2, 4);
}

const LORRY_CABS = ['#e8892c', '#d23b2c', '#2f6db3', '#e7c23c'].map(C);
const LORRY_TARPS = ['#2f5f9e', '#3f7f4a', '#c9542f', '#5d4fa0'].map(C);

/** Tata-style goods carrier, ~8.4 m long, facing +x. */
export function lorry(b: MeshBuilder, variant = 0): void {
  const cab = LORRY_CABS[variant % LORRY_CABS.length]!;
  const tarp = LORRY_TARPS[variant % LORRY_TARPS.length]!;
  const dark = C('#26272a');
  // chassis
  b.box(0, 0.75, 0, 8.2, 0.35, 2.0, dark);
  // cab
  b.box(3.05, 1.1, 0, 1.9, 1.9, 2.3, cab);
  b.box(3.15, 3.0, 0, 1.7, 0.2, 2.25, C('#f2efe8'));
  b.box(4.02, 1.95, 0, 0.06, 0.85, 2.0, C('#26384a'));
  b.box(4.04, 1.15, 0, 0.1, 0.4, 2.2, C('#d7d7d7'));
  // decorated cargo body with tarp
  b.box(-1.0, 1.1, 0, 5.8, 1.5, 2.4, C('#d9b23c'));
  b.box(-1.0, 1.25, 0, 5.85, 0.25, 2.45, C('#c8452f'));
  b.box(-1.0, 2.6, 0, 5.8, 0.75, 2.35, tarp);
  b.blob(-1.0, 3.3, 0, 2.8, 0.35, 1.15, shade(tarp, 0.9), 1);
  // wheels
  for (const [x, z] of [
    [2.9, 1.05],
    [2.9, -1.05],
    [-2.0, 1.05],
    [-2.0, -1.05],
    [-3.1, 1.05],
    [-3.1, -1.05],
  ] as const) {
    b.wheel(x, 0.52, z, 0.52, 0.35, 8, dark, C('#9a9a9a'));
  }
}

/** Mahindra-style tractor, ~4 m long, facing +x. */
export function tractor(b: MeshBuilder): void {
  const red = C('#c4362a');
  const dark = C('#25262a');
  const rim = C('#e2c24a');
  b.box(0.7, 0.9, 0, 2.6, 1.0, 1.0, red);
  b.box(1.6, 1.9, 0, 0.9, 0.1, 0.95, shade(red, 0.85));
  b.box(2.02, 0.95, 0, 0.1, 0.8, 0.8, C('#3a3a3a'));
  b.box(-0.6, 0.9, 0, 1.4, 0.6, 1.4, shade(red, 0.9));
  // seat, steering, ROPS canopy
  b.box(-0.7, 1.5, 0, 0.5, 0.4, 0.5, dark);
  b.cylinder(0.1, 1.5, 0, 0.04, 0.04, 0.6, 5, dark);
  for (const z of [-0.65, 0.65]) b.box(-1.0, 1.5, z, 0.1, 1.5, 0.1, dark);
  b.box(-0.8, 3.0, 0, 1.3, 0.1, 1.6, C('#e9e2d2'));
  b.cylinder(1.3, 1.9, 0.3, 0.06, 0.06, 0.9, 5, dark);
  b.wheel(-0.8, 0.8, 0.95, 0.8, 0.5, 10, dark, rim);
  b.wheel(-0.8, 0.8, -0.95, 0.8, 0.5, 10, dark, rim);
  b.wheel(1.55, 0.45, 0.7, 0.45, 0.3, 8, dark, rim);
  b.wheel(1.55, 0.45, -0.7, 0.45, 0.3, 8, dark, rim);
  // trolley
  b.box(-2.9, 0.75, 0, 0.9, 0.1, 0.1, dark);
  b.box(-4.6, 0.8, 0, 2.6, 0.9, 1.9, C('#3f6aa8'));
  b.wheel(-4.6, 0.45, 1.05, 0.45, 0.25, 8, dark, rim);
  b.wheel(-4.6, 0.45, -1.05, 0.45, 0.25, 8, dark, rim);
}

// ----------------------------------------------------------------------------- vegetation

/** Mango / rain tree: short trunk, broad clustered canopy (~8 m). */
export function broadleafTree(b: MeshBuilder): void {
  const trunk = C('#5a4030');
  b.cylinder(0, -0.5, 0, 0.42, 0.3, 3.4, 6, trunk);
  const leaf = C('#5a8a3a');
  b.blob(0, 4.6, 0, 3.4, 2.3, 3.2, leaf.clone().multiplyScalar(0.92), 1);
  b.blob(1.6, 4.0, 0.8, 2.1, 1.6, 2.0, leaf.clone().multiplyScalar(0.82), 1);
  b.blob(-1.4, 4.2, -0.9, 2.2, 1.7, 2.0, leaf.clone().multiplyScalar(0.86), 1);
  b.blob(0.2, 5.8, -0.2, 2.1, 1.4, 2.0, leaf, 1);
}

function frond(b: MeshBuilder, length: number, width: number, color: Color): void {
  // Drooping leaf in +x: base → mid (lifted) → tip (drooping). Double-sided by duplicating.
  const mid: [number, number, number] = [length * 0.45, length * 0.13, 0];
  const tip: [number, number, number] = [length, -length * 0.28, 0];
  const w = width / 2;
  const base: [number, number, number] = [0, 0, 0];
  const l1: [number, number, number] = [length * 0.45, length * 0.13 - 0.15, w];
  const r1: [number, number, number] = [length * 0.45, length * 0.13 - 0.15, -w];
  for (const [a, c2, c3] of [
    [base, l1, mid],
    [base, mid, r1],
    [mid, l1, tip],
    [mid, tip, r1],
  ] as const) {
    b.tri(a, c2, c3, color);
    b.tri(a, c3, c2, color);
  }
}

/** Coconut palm: tall slightly curved trunk, drooping frond crown, coconuts (~11 m). */
export function coconutPalm(b: MeshBuilder): void {
  const trunk = C('#8a7356');
  const h = 10.5;
  const segs = 4;
  let x = 0;
  for (let i = 0; i < segs; i++) {
    const y0 = (i / segs) * h;
    const lean = 0.35 + i * 0.25;
    b.cylinder(
      x,
      y0 - (i === 0 ? 0.5 : 0),
      0,
      0.3 - i * 0.03,
      0.27 - i * 0.03,
      h / segs + (i === 0 ? 0.5 : 0.05),
      6,
      trunk,
    );
    x += lean;
  }
  const leaf = C('#6a9a3c');
  b.with({ x, y: h }, () => {
    for (let i = 0; i < 9; i++) {
      b.with({ ry: (i / 9) * Math.PI * 2 + (i % 2) * 0.2, rz: i % 3 === 0 ? 0.25 : 0 }, () =>
        frond(b, 4.6, 1.2, leaf.clone().multiplyScalar(0.8 + (i % 3) * 0.08)),
      );
    }
    b.blob(0, -0.2, 0, 0.6, 0.5, 0.6, C('#6e7a33'), 0);
  });
}

/** Areca (betel-nut) palm: very slender straight trunk, small crown (~12 m). */
export function arecaPalm(b: MeshBuilder): void {
  b.cylinder(0, -0.5, 0, 0.14, 0.1, 12.5, 5, C('#a29a86'));
  const leaf = C('#74a046');
  b.with({ y: 12 }, () => {
    for (let i = 0; i < 6; i++) {
      b.with({ ry: (i / 6) * Math.PI * 2, rz: 0.35 }, () =>
        frond(b, 2.8, 0.8, leaf.clone().multiplyScalar(0.85 + (i % 2) * 0.1)),
      );
    }
  });
}

/** Banana clump (understorey near houses). */
export function bananaClump(b: MeshBuilder): void {
  const leaf = C('#86b04e');
  for (let k = 0; k < 3; k++) {
    const ox = (k - 1) * 0.9;
    b.cylinder(ox, -0.3, (k % 2) * 0.6, 0.16, 0.12, 2.6, 5, C('#7f8f4a'));
    b.with({ x: ox, y: 2.3, z: (k % 2) * 0.6 }, () => {
      for (let i = 0; i < 5; i++)
        b.with({ ry: (i / 5) * Math.PI * 2 + k, rz: 0.5 }, () =>
          frond(b, 2.0, 0.9, leaf.clone().multiplyScalar(0.95)),
        );
    });
  }
}
