/**
 * Transient UI state: which panel is open, selection/hover, dialogs, camera focus requests.
 * Never holds server state (that lives in TanStack Query).
 */
import type { ItemId } from '@bh/domain';
import { create } from 'zustand';

export type PanelId =
  | 'map'
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
    set({ panel: null, selectedParcelId: panel === 'land' ? null : get().selectedParcelId });
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
      plantParcelId: null,
      focus: null,
      sellPrefill: null,
    }),
}));
