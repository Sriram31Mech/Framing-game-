/**
 * Tiny procedural mesh builder: accumulates flat-shaded, vertex-coloured triangles under a
 * transform stack and emits ONE BufferGeometry. All buildings/vehicles/props are authored with
 * it, so each family renders in a single draw call with a single shared material.
 */
import { BufferAttribute, BufferGeometry, Color, Euler, Matrix4, Quaternion, Vector3 } from 'three';

export type ColorLike = Color | string;

const va = new Vector3();
const vb = new Vector3();
const vc = new Vector3();
const e1 = new Vector3();
const e2 = new Vector3();
const n = new Vector3();
const tmpColor = new Color();

export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private stack: Matrix4[] = [new Matrix4()];

  get triangleCount(): number {
    return this.pos.length / 9;
  }

  private get m(): Matrix4 {
    return this.stack[this.stack.length - 1]!;
  }

  /** Run `fn` with an extra local transform (translate · rotate · scale). */
  with(
    t: {
      x?: number;
      y?: number;
      z?: number;
      ry?: number;
      rx?: number;
      rz?: number;
      s?: number | [number, number, number];
    },
    fn: () => void,
  ): void {
    const local = new Matrix4().compose(
      new Vector3(t.x ?? 0, t.y ?? 0, t.z ?? 0),
      new Quaternion().setFromEuler(new Euler(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0, 'YXZ')),
      Array.isArray(t.s) ? new Vector3(...t.s) : new Vector3(t.s ?? 1, t.s ?? 1, t.s ?? 1),
    );
    this.stack.push(this.m.clone().multiply(local));
    try {
      fn();
    } finally {
      this.stack.pop();
    }
  }

  tri(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    color: ColorLike,
  ): void {
    va.set(...a).applyMatrix4(this.m);
    vb.set(...b).applyMatrix4(this.m);
    vc.set(...c).applyMatrix4(this.m);
    e1.subVectors(vb, va);
    e2.subVectors(vc, va);
    n.crossVectors(e1, e2);
    const len = n.length();
    if (len < 1e-12) return;
    n.multiplyScalar(1 / len);
    const col = typeof color === 'string' ? tmpColor.set(color) : color;
    for (const v of [va, vb, vc]) {
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(n.x, n.y, n.z);
      this.col.push(col.r, col.g, col.b);
    }
  }

  /** Quad a-b-c-d counter-clockwise when seen from the front. */
  quad(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
    color: ColorLike,
  ): void {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }

  /** Axis-aligned box with its base centred at (x, y, z). */
  box(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: ColorLike,
    opts: { bottom?: boolean; top?: ColorLike } = {},
  ): void {
    const x0 = x - w / 2;
    const x1 = x + w / 2;
    const z0 = z - d / 2;
    const z1 = z + d / 2;
    const y0 = y;
    const y1 = y + h;
    // +z (front)
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], color);
    // -z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], color);
    // +x
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], color);
    // -x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], color);
    // top
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], opts.top ?? color);
    if (opts.bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], color);
  }

  /**
   * Gable roof: ridge along x. Footprint w (x) × d (z) incl. overhang, base at y, ridge height h.
   * Gable ends coloured `gable` (wall colour) when given.
   */
  gableRoof(
    x: number,
    y: number,
    z: number,
    w: number,
    d: number,
    h: number,
    color: ColorLike,
    gable?: ColorLike,
  ): void {
    const x0 = x - w / 2;
    const x1 = x + w / 2;
    const z0 = z - d / 2;
    const z1 = z + d / 2;
    const yr = y + h;
    // slopes
    this.quad([x0, y, z1], [x1, y, z1], [x1, yr, z], [x0, yr, z], color);
    this.quad([x1, y, z0], [x0, y, z0], [x0, yr, z], [x1, yr, z], color);
    // gable triangles
    const g = gable ?? color;
    this.tri([x1, y, z1], [x1, y, z0], [x1, yr, z], g);
    this.tri([x0, y, z0], [x0, y, z1], [x0, yr, z], g);
    // soffit (underside) so roofs read solid from low angles
    this.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], g);
  }

  /** Hip roof (four slopes) with ridge along x. */
  hipRoof(
    x: number,
    y: number,
    z: number,
    w: number,
    d: number,
    h: number,
    color: ColorLike,
    side?: ColorLike,
  ): void {
    const x0 = x - w / 2;
    const x1 = x + w / 2;
    const z0 = z - d / 2;
    const z1 = z + d / 2;
    const inset = Math.min(d / 2, w / 2) * 0.9;
    const yr = y + h;
    const rx0 = x0 + inset;
    const rx1 = Math.max(rx0, x1 - inset);
    const s = side ?? color;
    this.quad([x0, y, z1], [x1, y, z1], [rx1, yr, z], [rx0, yr, z], color);
    this.quad([x1, y, z0], [x0, y, z0], [rx0, yr, z], [rx1, yr, z], color);
    this.tri([x1, y, z1], [x1, y, z0], [rx1, yr, z], s);
    this.tri([x0, y, z0], [x0, y, z1], [rx0, yr, z], s);
  }

  /** Cylinder / frustum along y, base centre (x, y, z). */
  cylinder(
    x: number,
    y: number,
    z: number,
    rBottom: number,
    rTop: number,
    h: number,
    segments: number,
    color: ColorLike,
    opts: { capTop?: boolean; capColor?: ColorLike } = {},
  ): void {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      this.quad(
        [x + c0 * rBottom, y, z + s0 * rBottom],
        [x + c0 * rTop, y + h, z + s0 * rTop],
        [x + c1 * rTop, y + h, z + s1 * rTop],
        [x + c1 * rBottom, y, z + s1 * rBottom],
        color,
      );
      if (opts.capTop !== false && rTop > 0) {
        this.tri(
          [x, y + h, z],
          [x + c1 * rTop, y + h, z + s1 * rTop],
          [x + c0 * rTop, y + h, z + s0 * rTop],
          opts.capColor ?? color,
        );
      }
    }
  }

  /** Horizontal cylinder (wheel) along z axis centred at (x, y, z). */
  wheel(
    x: number,
    y: number,
    z: number,
    r: number,
    width: number,
    segments: number,
    tyre: ColorLike,
    hub: ColorLike,
  ): void {
    const z0 = z - width / 2;
    const z1 = z + width / 2;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const p0: [number, number] = [x + Math.cos(a0) * r, y + Math.sin(a0) * r];
      const p1: [number, number] = [x + Math.cos(a1) * r, y + Math.sin(a1) * r];
      this.quad(
        [p0[0], p0[1], z1],
        [p0[0], p0[1], z0],
        [p1[0], p1[1], z0],
        [p1[0], p1[1], z1],
        tyre,
      );
      this.tri([x, y, z1], [p0[0], p0[1], z1], [p1[0], p1[1], z1], hub);
      this.tri([x, y, z0], [p1[0], p1[1], z0], [p0[0], p0[1], z0], hub);
    }
  }

  /** Low-poly "blob" (octahedron-ish sphere) for canopies, fruit, produce heaps. */
  blob(
    x: number,
    y: number,
    z: number,
    rx: number,
    ry: number,
    rz: number,
    color: ColorLike,
    detail = 1,
  ): void {
    const rings = 2 + detail;
    const segs = 4 + detail * 2;
    const pt = (ri: number, si: number): [number, number, number] => {
      const phi = (ri / rings) * Math.PI;
      const th = (si / segs) * Math.PI * 2;
      return [
        x + Math.sin(phi) * Math.cos(th) * rx,
        y + Math.cos(phi) * ry,
        z + Math.sin(phi) * Math.sin(th) * rz,
      ];
    };
    for (let ri = 0; ri < rings; ri++) {
      for (let si = 0; si < segs; si++) {
        const a = pt(ri, si);
        const b = pt(ri + 1, si);
        const c = pt(ri + 1, si + 1);
        const d = pt(ri, si + 1);
        if (ri === 0) this.tri(a, c, b, color);
        else if (ri === rings - 1) this.tri(a, d, b, color);
        else this.quad(a, d, c, b, color);
      }
    }
  }

  toGeometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
