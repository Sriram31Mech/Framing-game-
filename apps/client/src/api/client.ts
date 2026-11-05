/**
 * App-wide singletons: the QueryClient and the API bound to the auth store.
 */
import { QueryClient } from '@tanstack/react-query';
import { useAuthStore, getToken } from '../store/auth';
import { useUiStore } from '../store/ui';
import { createApi } from './endpoints';
import { createHttpClient, isApiError } from './http';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The HTTP layer already retries transient failures; don't multiply attempts.
      retry: (failureCount, error) =>
        failureCount < 1 && isApiError(error) && error.code === 'RATE_LIMITED',
      staleTime: 10_000,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});

export function signOutLocally(reason?: string): void {
  useAuthStore.getState().clear(reason);
  useUiStore.getState().reset();
  queryClient.clear();
}

// Empty = same origin (dev proxy / single-host deploy). Set VITE_API_URL when the API is hosted elsewhere, e.g. on Vercel.
export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(
  /\/$/,
  '',
);

export const http = createHttpClient({
  baseUrl: API_URL,
  getToken,
  onUnauthorized: () => {
    if (getToken()) signOutLocally('Your session has ended. Please sign in again.');
  },
  onSchemaMismatch: (path, error) => {
    if (import.meta.env.DEV)
      console.warn(`[api] response for ${path} does not match contract`, error);
  },
});

export const api = createApi(http);
