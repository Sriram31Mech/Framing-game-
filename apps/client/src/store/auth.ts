/**
 * Session token store. The token is persisted under a single localStorage key and
 * cleared on logout or any 401 from the API.
 */
import type { AccountDto, AuthResponse } from '@bh/contracts';
import { create } from 'zustand';

export const SESSION_STORAGE_KEY = 'bh.session.v1';

interface PersistedSession {
  token: string;
  expiresAt: string;
}

interface AuthState {
  token: string | null;
  expiresAt: string | null;
  account: AccountDto | null;
  /** Reason shown on the auth screen after an involuntary sign-out. */
  signedOutReason: string | null;
  setSession: (res: AuthResponse) => void;
  clear: (reason?: string) => void;
}

function readPersisted(): PersistedSession | null {
  try {
    const raw = (typeof window === 'undefined' ? undefined : window.localStorage)?.getItem(
      SESSION_STORAGE_KEY,
    );
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PersistedSession>;
    if (typeof v.token !== 'string' || typeof v.expiresAt !== 'string') return null;
    if (Date.parse(v.expiresAt) <= Date.now()) return null;
    return { token: v.token, expiresAt: v.expiresAt };
  } catch {
    return null;
  }
}

function writePersisted(s: PersistedSession | null): void {
  try {
    if (s)
      (typeof window === 'undefined' ? undefined : window.localStorage)?.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify(s),
      );
    else
      (typeof window === 'undefined' ? undefined : window.localStorage)?.removeItem(
        SESSION_STORAGE_KEY,
      );
  } catch {
    // Storage may be unavailable (private mode); the session then lasts for this tab only.
  }
}

const initial = readPersisted();

export const useAuthStore = create<AuthState>((set) => ({
  token: initial?.token ?? null,
  expiresAt: initial?.expiresAt ?? null,
  account: null,
  signedOutReason: null,
  setSession: (res) => {
    writePersisted({ token: res.token, expiresAt: res.expiresAt });
    set({
      token: res.token,
      expiresAt: res.expiresAt,
      account: res.account,
      signedOutReason: null,
    });
  },
  clear: (reason) => {
    writePersisted(null);
    set({ token: null, expiresAt: null, account: null, signedOutReason: reason ?? null });
  },
}));

export const getToken = (): string | null => useAuthStore.getState().token;
