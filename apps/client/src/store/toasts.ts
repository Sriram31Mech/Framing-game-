import { create } from 'zustand';

export type Severity = 'info' | 'success' | 'warning' | 'danger';

export interface Toast {
  id: number;
  severity: Severity;
  title: string;
  body?: string;
  /** Auto-dismiss after ms (0 = sticky). */
  ttlMs: number;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id' | 'ttlMs'> & { ttlMs?: number }) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let nextId = 1;
const MAX_TOASTS = 5;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    const ttlMs = t.ttlMs ?? (t.severity === 'danger' ? 9000 : 5000);
    set({ toasts: [...get().toasts, { ...t, id, ttlMs }].slice(-MAX_TOASTS) });
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  clear: () => set({ toasts: [] }),
}));

export const toast = {
  info: (title: string, body?: string) =>
    useToastStore.getState().push({ severity: 'info', title, body }),
  success: (title: string, body?: string) =>
    useToastStore.getState().push({ severity: 'success', title, body }),
  warning: (title: string, body?: string) =>
    useToastStore.getState().push({ severity: 'warning', title, body }),
  danger: (title: string, body?: string) =>
    useToastStore.getState().push({ severity: 'danger', title, body }),
};
