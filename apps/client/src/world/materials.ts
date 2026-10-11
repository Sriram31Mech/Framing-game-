/**
 * Shared materials. A handful of MeshStandardMaterials with vertex colours cover the whole scene;
 * crops/trees get a tiny wind-sway vertex patch and the river an animated ripple normal, both
 * driven by one shared time uniform.
 */
import { Color, DoubleSide, FrontSide, MeshStandardMaterial, type IUniform } from 'three';
import { WATER } from './palette';

export const sharedTime: IUniform<number> = { value: 0 };

function withSway(mat: MeshStandardMaterial, amplitude: number, key: string): MeshStandardMaterial {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec2 swayPhase = vec2(instanceMatrix[3].x, instanceMatrix[3].z) * 0.045;
#else
  vec2 swayPhase = vec2(0.0);
#endif
  float sway = sin(uTime * 1.3 + swayPhase.x + swayPhase.y) + 0.5 * sin(uTime * 2.1 + swayPhase.x * 1.7);
  transformed.x += sway * ${amplitude.toFixed(3)} * max(position.y, 0.0);
  transformed.z += sway * ${(amplitude * 0.6).toFixed(3)} * max(position.y, 0.0);`,
      );
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

export interface SceneMaterials {
  terrain: MeshStandardMaterial;
  fill: MeshStandardMaterial;
  bund: MeshStandardMaterial;
  road: MeshStandardMaterial;
  architecture: MeshStandardMaterial;
  tree: MeshStandardMaterial;
  crop: MeshStandardMaterial;
  fruit: MeshStandardMaterial;
  water: MeshStandardMaterial;
  vehicle: MeshStandardMaterial;
  dispose: () => void;
}

export function createSceneMaterials(animate: boolean): SceneMaterials {
  const terrain = new MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 });
  const fill = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  const bund = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  const road = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const architecture = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.02,
    flatShading: true,
  });
  const tree = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
    side: DoubleSide,
  });
  const crop = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0,
    flatShading: true,
    side: DoubleSide,
  });
  const fruit = new MeshStandardMaterial({
    color: new Color('#d8432f'),
    roughness: 0.45,
    metalness: 0,
  });
  const vehicle = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.15,
    flatShading: true,
  });
  if (animate) {
    withSway(tree, 0.012, 'bh-tree-sway');
    withSway(crop, 0.05, 'bh-crop-sway');
  }

  const water = new MeshStandardMaterial({
    color: new Color(WATER.deep),
    roughness: 0.12,
    metalness: 0.1,
    transparent: true,
    opacity: 0.92,
    side: FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  water.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedTime;
    shader.uniforms.uShallow = { value: new Color(WATER.shallow) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRiverUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvRiverUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uTime;\nuniform vec3 uShallow;\nvarying vec2 vRiverUv;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float edge = smoothstep(0.55, 1.0, abs(vRiverUv.x) / 26.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, uShallow, edge);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  float flow = vRiverUv.y * 0.12 - uTime * 0.9;
  vec3 ripple = vec3(
    sin(flow + vRiverUv.x * 0.35) * 0.06 + sin(flow * 2.3 - vRiverUv.x * 0.8) * 0.03,
    0.0,
    cos(flow * 1.7 + vRiverUv.x * 0.5) * 0.05
  );
  normal = normalize(normal + (viewMatrix * vec4(ripple, 0.0)).xyz);`,
      );
  };
  water.customProgramCacheKey = () => 'bh-water';

  const all = [terrain, fill, bund, road, architecture, tree, crop, fruit, water, vehicle];
  return {
    terrain,
    fill,
    bund,
    road,
    architecture,
    tree,
    crop,
    fruit,
    water,
    vehicle,
    dispose: () => all.forEach((m) => m.dispose()),
  };
}
