/**
 * Crop rows: one unit geometry per archetype (length 1 along x, height 1, width 1 along z),
 * instanced per crop type and scaled per row segment by growth progress.
 */
import type { CropId } from '@bh/domain';
import type { BufferGeometry } from 'three';
import { Color, Matrix4, Quaternion, Vector3 } from 'three';
import { sampleCropRows, type Pt } from '../../lib/geometry';
import { CROP_LOOK, cropCanopyColor, PADDY_WATER, unitHealth } from '../palette';
import type { TerrainSampler } from '../terrain';
import { MeshBuilder } from './meshBuilder';

const shadeBottom = (k: number) => new Color(0.55 + 0.45 * k, 0.55 + 0.45 * k, 0.55 + 0.45 * k);

/** Low jagged mound (rice, ragi): `teeth` tufts along the row. */
function ridge(teeth: number): BufferGeometry {
  const b = new MeshBuilder();
  const top = shadeBottom(1);
  const low = shadeBottom(0.2);
  for (let i = 0; i < teeth; i++) {
    const x0 = -0.5 + i / teeth;
    const x1 = -0.5 + (i + 1) / teeth;
    const xm = (x0 + x1) / 2;
    // two tilted blades per tuft forming a tent
    b.quad([x0, 0, 0.5], [x1, 0, 0.5], [xm + 0.02, 1, 0.05], [xm - 0.02, 1, 0.05], top);
    b.quad([x1, 0, -0.5], [x0, 0, -0.5], [xm - 0.02, 1, -0.05], [xm + 0.02, 1, -0.05], low);
    b.tri([x1, 0, 0.5], [x1, 0, -0.5], [xm + 0.02, 1, -0.05], low);
    b.tri([x0, 0, -0.5], [x0, 0, 0.5], [xm - 0.02, 1, 0.05], top);
  }
  return b.toGeometry();
}

/** Tall stalk row (maize, sugarcane): narrow tapered wall with a spiky crown. */
function stalks(teeth: number): BufferGeometry {
  const b = new MeshBuilder();
  const top = shadeBottom(1);
  const mid = shadeBottom(0.7);
  const low = shadeBottom(0.3);
  // body
  b.quad([-0.5, 0, 0.3], [0.5, 0, 0.3], [0.5, 0.75, 0.42], [-0.5, 0.75, 0.42], mid);
  b.quad([0.5, 0, -0.3], [-0.5, 0, -0.3], [-0.5, 0.75, -0.42], [0.5, 0.75, -0.42], low);
  b.quad([0.5, 0, 0.3], [0.5, 0, -0.3], [0.5, 0.75, -0.42], [0.5, 0.75, 0.42], low);
  b.quad([-0.5, 0, -0.3], [-0.5, 0, 0.3], [-0.5, 0.75, 0.42], [-0.5, 0.75, -0.42], low);
  // crown spikes (leaves arching out)
  for (let i = 0; i < teeth; i++) {
    const x0 = -0.5 + i / teeth;
    const x1 = -0.5 + (i + 1) / teeth;
    const xm = (x0 + x1) / 2;
    b.quad([x0, 0.75, 0.42], [x1, 0.75, 0.42], [xm, 1, 0.1], [xm, 1, 0.1], top);
    b.tri([x0, 0.75, 0.42], [x1, 0.75, 0.42], [xm, 1, 0.1], top);
    b.tri([x1, 0.75, -0.42], [x0, 0.75, -0.42], [xm, 1, -0.1], mid);
    b.tri([x1, 0.75, 0.42], [x1, 0.75, -0.42], [xm, 1, 0], mid);
    b.tri([x0, 0.75, -0.42], [x0, 0.75, 0.42], [xm, 1, 0], mid);
  }
  return b.toGeometry();
}

/** Bushy row (tomato, chickpea): a run of squashed blobs. */
function bushes(count: number): BufferGeometry {
  const b = new MeshBuilder();
  for (let i = 0; i < count; i++) {
    const x = -0.5 + (i + 0.5) / count;
    b.blob(x, 0.45, 0, 0.62 / count, 0.55, 0.5, shadeBottom(0.85 + (i % 2) * 0.15), 1);
  }
  return b.toGeometry();
}

export function cropGeometry(kind: 'ridge' | 'stalk' | 'bush'): BufferGeometry {
  if (kind === 'stalk') return stalks(6);
  if (kind === 'bush') return bushes(4);
  return ridge(7);
}

export function fruitGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  b.blob(0, 0, 0, 0.5, 0.5, 0.5, new Color(1, 1, 1), 1);
  return b.toGeometry();
}

export interface PlantedParcel {
  id: string;
  polygon: Pt[];
  crop: {
    cropId: CropId;
    status: 'growing' | 'ready' | 'failed';
    progress: number;
    health: number;
  };
}

export interface CropInstances {
  cropId: CropId;
  count: number;
  matrices: Float32Array;
  colors: Float32Array;
}

export interface CropLayout {
  byCrop: CropInstances[];
  fruit: { count: number; matrices: Float32Array };
  total: number;
}

const m4 = new Matrix4();
const q = new Quaternion();
const up = new Vector3(0, 1, 0);
const pos = new Vector3();
const scl = new Vector3();
const col = new Color();

function heightFactor(progress: number, status: string): number {
  if (status === 'failed') return 0.35;
  const p = status === 'ready' ? 1 : Math.max(0, Math.min(1, progress));
  const t = Math.min(1, p / 0.85);
  return 0.1 + 0.9 * (t * t * (3 - 2 * t));
}

/**
 * Instance transforms + colours for every planted parcel. Row spacing scales with quality and is
 * widened automatically if a crop type would exceed `maxPerCrop` instances.
 */
export function layoutCrops(
  parcels: readonly PlantedParcel[],
  sampler: TerrainSampler,
  opts: { spacingScale: number; maxPerCrop: number },
): CropLayout {
  const groups = new Map<CropId, PlantedParcel[]>();
  for (const p of parcels) {
    const list = groups.get(p.crop.cropId);
    if (list) list.push(p);
    else groups.set(p.crop.cropId, [p]);
  }
  const byCrop: CropInstances[] = [];
  const fruitMats: number[] = [];
  let total = 0;
  for (const [cropId, list] of groups) {
    const look = CROP_LOOK[cropId];
    let spacing = look.rowSpacing * opts.spacingScale;
    let seg = look.segmentLength * Math.sqrt(opts.spacingScale);
    let samples = list.map((p) =>
      sampleCropRows(p.polygon, {
        rowSpacing: spacing,
        segmentLength: seg,
        margin: 2.4,
        seed: p.id,
      }),
    );
    let count = samples.reduce((s, a) => s + a.length, 0);
    if (count > opts.maxPerCrop) {
      const k = Math.sqrt(count / opts.maxPerCrop);
      spacing *= k;
      seg *= k;
      samples = list.map((p) =>
        sampleCropRows(p.polygon, {
          rowSpacing: spacing,
          segmentLength: seg,
          margin: 2.4,
          seed: p.id,
          maxSamples: opts.maxPerCrop,
        }),
      );
      count = Math.min(
        opts.maxPerCrop,
        samples.reduce((s, a) => s + a.length, 0),
      );
    }
    const matrices = new Float32Array(count * 16);
    const colors = new Float32Array(count * 3);
    let i = 0;
    list.forEach((parcel, pi) => {
      const crop = parcel.crop;
      const health = unitHealth(crop.health);
      const hf = heightFactor(crop.progress, crop.status);
      const base = cropCanopyColor(cropId, crop.progress, health, crop.status, new Color());
      for (const s of samples[pi]!) {
        if (i >= count) break;
        const h = look.maxHeight * hf * (0.9 + s.variation * 0.2);
        const w = look.width * (0.55 + 0.45 * hf) * Math.min(1, spacing / look.rowSpacing) ** 0.3;
        pos.set(s.x, sampler.heightAt(s.x, s.y) + 0.3, s.y);
        q.setFromAxisAngle(up, -s.angle);
        scl.set(s.length * 0.96, h, Math.min(w * opts.spacingScale ** 0.5, spacing * 0.8));
        m4.compose(pos, q, scl);
        m4.toArray(matrices, i * 16);
        col.copy(base).multiplyScalar(0.92 + s.variation * 0.16);
        colors[i * 3] = col.r;
        colors[i * 3 + 1] = col.g;
        colors[i * 3 + 2] = col.b;
        i++;
        if (
          cropId === 'tomato' &&
          crop.status !== 'failed' &&
          (crop.status === 'ready' || crop.progress > 0.72)
        ) {
          for (let k = 0; k < 3; k++) {
            const t = (k + 0.5) / 3 - 0.5 + (s.variation - 0.5) * 0.15;
            const fx = s.x + Math.cos(s.angle) * t * s.length;
            const fy = s.y + Math.sin(s.angle) * t * s.length;
            const side = k % 2 === 0 ? 0.35 : -0.35;
            pos.set(
              fx - Math.sin(s.angle) * side,
              sampler.heightAt(fx, fy) + 0.3 + h * 0.55,
              fy + Math.cos(s.angle) * side,
            );
            q.identity();
            scl.setScalar(0.32);
            m4.compose(pos, q, scl);
            for (const v of m4.elements) fruitMats.push(v);
          }
        }
      }
    });
    total += i;
    byCrop.push({ cropId, count: i, matrices, colors });
  }
  return {
    byCrop,
    fruit: { count: fruitMats.length / 16, matrices: Float32Array.from(fruitMats) },
    total,
  };
}

/** Field (fill) colour for a parcel's crop: canopy for mature fields, paddy water for young rice. */
export function cropFieldColor(crop: PlantedParcel['crop'], soil: Color, out: Color): Color {
  const health = unitHealth(crop.health);
  cropCanopyColor(crop.cropId, crop.progress, health, crop.status, out);
  if (crop.cropId === 'rice' && crop.status === 'growing' && crop.progress < 0.6) {
    return out.lerp(PADDY_WATER, 0.55 * (1 - crop.progress / 0.6));
  }
  const p = crop.status === 'ready' ? 1 : crop.progress;
  // Young fields show more soil between the rows.
  return out.lerp(soil, Math.max(0, 0.75 - p * 0.9));
}
