/**
 * Procedural low-poly props for the map. Each is about 1 unit tall standing on y=0 (scenery
 * matrices carry the real size) and carries baked vertex colours, so one material serves all.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  IcosahedronGeometry,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  RingGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const m = new Matrix4();

function part(g: BufferGeometry, color: string, transform?: Matrix4): BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  geo.deleteAttribute('uv');
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  if (transform) geo.applyMatrix4(transform);
  const c = new Color(color);
  const n = geo.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  return geo;
}

function merge(...parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts);
  if (!g) throw new Error('prop merge failed');
  g.computeVertexNormals();
  return g;
}

const at = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);

/** Broadleaf tree: trunk + two stacked crowns (crown left white so instance tint sets its green). */
export const TREE = merge(
  part(new CylinderGeometry(0.06, 0.09, 0.4, 5), '#7a5536', at(0, 0.2, 0)),
  part(new IcosahedronGeometry(0.38, 0), '#ffffff', at(0, 0.6, 0)),
  part(new IcosahedronGeometry(0.26, 0), '#f2f2f2', at(0.12, 0.82, 0.05)),
);

/** Coconut palm: tall leaning trunk with drooping fronds. */
export const PALM = (() => {
  const fronds: BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    m.makeRotationY(a)
      .multiply(at(0.22, 0.9, 0))
      .multiply(new Matrix4().makeRotationZ(-0.45));
    fronds.push(part(new BoxGeometry(0.5, 0.03, 0.12), '#ffffff', m.clone()));
  }
  return merge(
    part(new CylinderGeometry(0.035, 0.06, 0.95, 5), '#8a6a45', at(0.04, 0.47, 0)),
    part(new IcosahedronGeometry(0.07, 0), '#6b4a2a', at(0.06, 0.92, 0)),
    ...fronds,
  );
})();

/** Rounded hill: a squat 7-sided cone. */
export const HILL = merge(part(new ConeGeometry(1, 1, 7, 2), '#ffffff', at(0, 0.5, 0)));

/** Cloud: a cluster of puffs. */
export const CLOUD = merge(
  part(new IcosahedronGeometry(0.5, 1), '#ffffff', at(0, 0.5, 0)),
  part(new IcosahedronGeometry(0.38, 1), '#ffffff', at(0.55, 0.4, 0.1)),
  part(new IcosahedronGeometry(0.34, 1), '#f4f6f8', at(-0.5, 0.38, -0.05)),
  part(new IcosahedronGeometry(0.28, 1), '#ffffff', at(0.15, 0.4, 0.4)),
);

/** Flat disc for cloud shadows and field patches. */
export const DISC = part(
  new CircleGeometry(1, 20),
  '#ffffff',
  new Matrix4().makeRotationX(-Math.PI / 2),
);

/** Bird: a V of two wings; tips at y=0.3 so scaling y flaps them. */
export const BIRD = (() => {
  const g = new BufferGeometry();
  // prettier-ignore
  const p = new Float32Array([
    0, 0, 0.15,   -0.5, 0.3, -0.1,   0, 0, -0.15,
    0, 0, 0.15,    0, 0, -0.15,     0.5, 0.3, -0.1,
  ]);
  g.setAttribute('position', new BufferAttribute(p, 3));
  return merge(part(g, '#2f2a26'));
})();

/** Lorry (1 unit long, facing +x): cargo box + cab; white parts take the instance tint. */
export const TRUCK = merge(
  part(new BoxGeometry(0.62, 0.36, 0.34), '#ffffff', at(-0.16, 0.28, 0)),
  part(new BoxGeometry(0.28, 0.3, 0.32), '#e8e8e8', at(0.3, 0.25, 0)),
  part(new BoxGeometry(0.06, 0.14, 0.28), '#3a4a5a', at(0.45, 0.32, 0)),
  part(new BoxGeometry(0.9, 0.1, 0.36), '#333333', at(0, 0.06, 0)),
);

/** Fishing boat (catamaran style) with a sail, facing +x. */
export const BOAT = (() => {
  const sail = new BufferGeometry();
  sail.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-0.25, 0.2, 0, 0.2, 0.2, 0, -0.05, 0.95, 0]), 3),
  );
  return merge(
    part(new BoxGeometry(1, 0.14, 0.3), '#8b5a2b', at(0, 0.07, 0)),
    part(new CylinderGeometry(0.015, 0.015, 0.8, 4), '#5a3a1a', at(-0.05, 0.55, 0)),
    part(sail, '#f6efe0'),
  );
})();

/** Small flat diamond glint on the sea. */
export const GLINT = part(
  new OctahedronGeometry(1, 0),
  '#ffffff',
  new Matrix4().makeScale(1, 0.05, 0.35),
);

/** Field patch with furrows: a square slab plus raised crop rows (white = tinted). */
export const FIELD = (() => {
  const rows: BufferGeometry[] = [];
  for (let i = -2; i <= 2; i++)
    rows.push(part(new BoxGeometry(1.7, 0.18, 0.18), '#ffffff', at(0, 0.12, i * 0.36)));
  return merge(part(new BoxGeometry(2, 0.06, 2), '#8a6a45', at(0, 0.03, 0)), ...rows);
})();

/** Floating map marker: an inverted pyramid. */
export const MARKER = merge(
  part(
    new ConeGeometry(0.45, 1, 4),
    '#ffffff',
    new Matrix4().makeRotationX(Math.PI).setPosition(0, 0.5, 0),
  ),
);

/** Sparkle star for harvest-ready fields. */
export const SPARKLE = merge(part(new OctahedronGeometry(0.5, 0), '#ffffff', at(0, 0.5, 0)));

/** Market stall: counter, posts and a striped awning. */
export const STALL = (() => {
  const stripes: BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    m.makeRotationX(0.35).setPosition(-0.4 + i * 0.2, 0.82, 0.05);
    stripes.push(part(new BoxGeometry(0.2, 0.04, 0.8), i % 2 ? '#fff4e0' : '#d9482b', m.clone()));
  }
  const posts = [-0.45, 0.45].flatMap((x) =>
    [-0.3, 0.3].map((z) =>
      part(new CylinderGeometry(0.025, 0.025, 0.8, 4), '#6b4a2a', at(x, 0.4, z)),
    ),
  );
  return merge(
    part(new BoxGeometry(1, 0.35, 0.45), '#a8743f', at(0, 0.175, 0.1)),
    part(new BoxGeometry(0.2, 0.12, 0.2), '#e0a030', at(-0.25, 0.41, 0.1)),
    part(new BoxGeometry(0.2, 0.12, 0.2), '#3f9a4f', at(0.05, 0.41, 0.1)),
    part(new BoxGeometry(0.2, 0.12, 0.2), '#c0392b', at(0.3, 0.41, 0.1)),
    ...posts,
    ...stripes,
  );
})();

/** Price token above a mandi: a standing gold coin. */
export const COIN = merge(
  part(
    new CylinderGeometry(0.5, 0.5, 0.12, 14),
    '#ffffff',
    new Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0.5, 0),
  ),
);

/** Click ripple ring. */
export const RIPPLE = new RingGeometry(0.85, 1, 40).rotateX(-Math.PI / 2);

export const solid = new MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.85,
  flatShading: true,
});
export const glossy = new MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.4,
  metalness: 0.3,
});
export const cloudMat = new MeshStandardMaterial({
  vertexColors: true,
  roughness: 1,
  flatShading: true,
  transparent: true,
  opacity: 0.92,
});
export const shadowMat = new MeshBasicMaterial({
  color: '#1d2a33',
  transparent: true,
  opacity: 0.13,
  depthWrite: false,
});
export const glintMat = new MeshBasicMaterial({
  color: '#ffffff',
  transparent: true,
  opacity: 0.75,
  depthWrite: false,
});
export const glowMat = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
export const birdMat = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide });
