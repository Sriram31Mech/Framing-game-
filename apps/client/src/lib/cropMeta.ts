/** Display metadata for crops that UI code can use without pulling in three.js. */
import type { CropId } from '@bh/domain';

export const CROP_META: Record<CropId, { label: string; swatch: string }> = {
  rice: { label: 'Rice (paddy)', swatch: '#5fa83a' },
  ragi: { label: 'Ragi (finger millet)', swatch: '#7a8a3c' },
  maize: { label: 'Maize', swatch: '#c9b24d' },
  sugarcane: { label: 'Sugarcane', swatch: '#3d8f3a' },
  tomato: { label: 'Tomato', swatch: '#d8432f' },
  chickpea: { label: 'Chickpea (Bengal gram)', swatch: '#a3a05a' },
};
