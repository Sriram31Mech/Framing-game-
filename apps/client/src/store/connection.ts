import { create } from 'zustand';

export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline';

interface ConnectionState {
  status: ConnectionStatus;
  lastEventAt: number | null;
  setStatus: (s: ConnectionStatus) => void;
  markEvent: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: 'idle',
  lastEventAt: null,
  setStatus: (status) => {
    if (get().status !== status) set({ status });
  },
  markEvent: () => set({ lastEventAt: Date.now() }),
}));

/** True when realtime hints are not flowing and displayed data may be stale. */
export function useIsStale(): boolean {
  const s = useConnectionStore((st) => st.status);
  return s === 'reconnecting' || s === 'offline';
}
