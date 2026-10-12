import { Color } from 'three';

export type MapLayer = 'zone' | 'rain' | 'land' | 'mine';

export const MAP_LAYERS: { id: MapLayer; label: string; hint: string }[] = [
  { id: 'zone', label: 'Farming zones', hint: 'TNAU agro-climatic zones' },
  { id: 'rain', label: 'Rainfall', hint: 'Annual rainfall by district' },
  { id: 'land', label: 'Land for sale', hint: 'Where holdings are available' },
  { id: 'mine', label: 'My land', hint: 'Segments where you farm' },
];

const ZONE_COLORS: Record<string, string> = {
  'North Eastern Zone': '#a8c860',
  'North Western Zone': '#d6a25e',
  'Western Zone': '#c4c066',
  'Cauvery Delta Zone': '#72c255',
  'Southern Zone': '#e2c271',
  'High Rainfall Zone': '#4fae5a',
  'Hilly Zone': '#3f9450',
};
export const zoneColor = (zone: string) => new Color(ZONE_COLORS[zone] ?? '#cdbb8f');
export const ZONE_LEGEND = Object.entries(ZONE_COLORS);

const DRY = new Color('#e9d9b0');
const WET = new Color('#2f7fb8');
export function rainColor(annualMm: number): Color {
  const t = Math.min(1, Math.max(0, (annualMm - 600) / (1600 - 600)));
  return DRY.clone().lerp(WET, t);
}

const NONE = new Color('#d9d2c3');
const FEW = new Color('#cfe3b0');
const MANY = new Color('#3f9a4f');
export function landColor(forSale: number): Color {
  if (forSale <= 0) return NONE.clone();
  return FEW.clone().lerp(MANY, Math.min(1, forSale / 10));
}

const MINE = new Color('#f2a33a');
const MUTED = new Color('#ddd6c8');
export const mineColor = (mine: number) => (mine > 0 ? MINE.clone() : MUTED.clone());

/** Slight per-segment brightness variation so neighbouring segments read as separate areas. */
export function vary(c: Color, seed: number): Color {
  const t = (((seed * 2654435761) >>> 0) % 1000) / 1000;
  return c.clone().multiplyScalar(0.94 + 0.1 * t);
}

/** Tiny Swords-style teal water and stone cliffs (shared look with the area view). */
export const SEA = '#47aba9';
export const WALL = '#7d8796';
export const RIVER = '#3d8fc4';
export const ROAD = '#6d6458';
export const SELECT = '#ff9f1c';
