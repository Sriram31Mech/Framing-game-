/**
 * Transient UI state: which panel is open, selection/hover, dialogs, camera focus requests.
 * Never holds server state (that lives in TanStack Query).
 */
import type { ItemId } from '@bh/domain';
import { create } from 'zustand';
import type { MapLayer } from '../world/tn/colors';

export type PanelId =
  | 'map'
  | 'segment'
  | 'land'
  | 'farm'
  | 'inventory'
  | 'market'
  | 'contracts'
  | 'finance'
  | 'leaderboard'
  | 'notifications'
  | 'settings';

interface FocusRequest {
  parcelId: string;
  nonce: number;
}

interface UiState {
  panel: PanelId | null;
  selectedSegmentId: string | null;
  hoveredSegmentId: string | null;
  /** Segment the camera should glide to (changes nonce to re-trigger). */
  focusSegment: { id: string; nonce: number } | null;
  mapLayer: MapLayer;
  /** Segment shown in the 3D close-up "area view" (null = Tamil Nadu map). */
  areaSegmentId: string | null;
  /** Swoop into a segment's close-up. Also callable as `useUiStore.getState().enterArea(id)`. */
  enterArea: (segmentId: string) => void;
  /** Back to the state map, focused on the area just left. */
  exitArea: () => void;
  selectSegment: (id: string | null, opts?: { focus?: boolean }) => void;
  setHoveredSegment: (id: string | null) => void;
  setMapLayer: (layer: MapLayer) => void;
  selectedParcelId: string | null;
  hoveredParcelId: string | null;
  plantParcelId: string | null;
  focus: FocusRequest | null;
  /** Item to preselect in the market sell form. */
  sellPrefill: ItemId | null;
  openSell: (itemId: ItemId) => void;
  openPanel: (p: PanelId) => void;
  togglePanel: (p: PanelId) => void;
  closePanel: () => void;
  selectParcel: (id: string | null, opts?: { focus?: boolean }) => void;
  setHovered: (id: string | null) => void;
  openPlant: (parcelId: string) => void;
  closePlant: () => void;
  requestFocus: (parcelId: string) => void;
  reset: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  panel: null,
  selectedSegmentId: null,
  hoveredSegmentId: null,
  focusSegment: null,
  mapLayer: 'zone',
  areaSegmentId: null,
  enterArea: (id) =>
    set({
      areaSegmentId: id,
      selectedSegmentId: id,
      hoveredSegmentId: null,
      panel: get().panel === 'segment' ? null : get().panel,
    }),
  exitArea: () => {
    const id = get().areaSegmentId;
    if (!id) return;
    set({ areaSegmentId: null, focusSegment: { id, nonce: (get().focusSegment?.nonce ?? 0) + 1 } });
  },
  selectSegment: (id, opts) => {
    if (id === null) {
      set({ selectedSegmentId: null, panel: get().panel === 'segment' ? null : get().panel });
      return;
    }
    set({
      selectedSegmentId: id,
      panel: 'segment',
      focusSegment: opts?.focus
        ? { id, nonce: (get().focusSegment?.nonce ?? 0) + 1 }
        : get().focusSegment,
    });
  },
  setHoveredSegment: (id) => {
    if (get().hoveredSegmentId !== id) set({ hoveredSegmentId: id });
  },
  setMapLayer: (mapLayer) => set({ mapLayer }),
  selectedParcelId: null,
  hoveredParcelId: null,
  plantParcelId: null,
  focus: null,
  sellPrefill: null,
  openSell: (itemId) => set({ sellPrefill: itemId, panel: 'market' }),
  openPanel: (panel) => set({ panel }),
  togglePanel: (panel) => set({ panel: get().panel === panel ? null : panel }),
  closePanel: () => {
    const { panel } = get();
    set({
      panel: null,
      selectedParcelId: panel === 'land' ? null : get().selectedParcelId,
      selectedSegmentId: panel === 'segment' ? null : get().selectedSegmentId,
    });
  },
  selectParcel: (id, opts) => {
    if (id === null) {
      set({ selectedParcelId: null, panel: get().panel === 'land' ? null : get().panel });
      return;
    }
    set({
      selectedParcelId: id,
      panel: 'land',
      focus: opts?.focus ? { parcelId: id, nonce: (get().focus?.nonce ?? 0) + 1 } : get().focus,
    });
  },
  setHovered: (id) => {
    if (get().hoveredParcelId !== id) set({ hoveredParcelId: id });
  },
  openPlant: (parcelId) => set({ plantParcelId: parcelId }),
  closePlant: () => set({ plantParcelId: null }),
  requestFocus: (parcelId) => set({ focus: { parcelId, nonce: (get().focus?.nonce ?? 0) + 1 } }),
  reset: () =>
    set({
      panel: null,
      selectedParcelId: null,
      hoveredParcelId: null,
      selectedSegmentId: null,
      hoveredSegmentId: null,
      focusSegment: null,
      areaSegmentId: null,
      plantParcelId: null,
      focus: null,
      sellPrefill: null,
    }),
}));
