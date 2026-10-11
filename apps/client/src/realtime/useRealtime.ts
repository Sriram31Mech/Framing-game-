import { NotificationDto, type RealtimeEvent } from '@bh/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { signOutLocally } from '../api/client';
import { invalidateKeys } from '../api/queryKeys';
import { useAuthStore } from '../store/auth';
import { useConnectionStore } from '../store/connection';
import { useToastStore } from '../store/toasts';
import { invalidationsForEvent } from './invalidation';
import { defaultSocketUrl, RealtimeClient } from './socket';

/** Notification toast for a `notification.created` event, if its payload is well-formed. */
export function toastForEvent(
  event: RealtimeEvent,
): { severity: NotificationDto['severity']; title: string; body: string } | null {
  if (event.type !== 'notification.created') return null;
  const parsed = NotificationDto.safeParse(event.payload);
  if (!parsed.success) return null;
  return { severity: parsed.data.severity, title: parsed.data.title, body: parsed.data.body };
}

/** Connects the realtime socket while signed in and turns events into query invalidations. */
export function useRealtime(enabled: boolean): void {
  const qc = useQueryClient();
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!enabled || !token) return;
    const setStatus = useConnectionStore.getState().setStatus;
    const markEvent = useConnectionStore.getState().markEvent;

    const client = new RealtimeClient({
      url: defaultSocketUrl(),
      getToken: () => useAuthStore.getState().token,
      onStatus: setStatus,
      onReady: ({ reconnected }) => {
        // Anything could have happened while disconnected: refetch everything displayed.
        if (reconnected) void qc.invalidateQueries();
      },
      onEvent: (event) => {
        markEvent();
        invalidateKeys(qc, invalidationsForEvent(event));
        const t = toastForEvent(event);
        if (t)
          useToastStore.getState().push({ severity: t.severity, title: t.title, body: t.body });
      },
      onAuthError: () => signOutLocally('Your session has ended. Please sign in again.'),
    });
    client.start();

    const online = () => client.reconnectNow();
    const offline = () => setStatus('offline');
    const visible = () => {
      if (document.visibilityState === 'visible') client.reconnectNow();
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
      client.stop();
    };
  }, [enabled, token, qc]);
}
