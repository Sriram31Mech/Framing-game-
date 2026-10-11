import { useMarkNotificationsRead } from '../../api/mutations';
import { useNotifications, useWorld } from '../../api/queries';
import { relativeDay } from '../../lib/format';
import { useUiStore } from '../../store/ui';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { Panel } from '../../ui/Panel';
import { EmptyState, QueryView } from '../../ui/States';

const ICON: Record<'info' | 'success' | 'warning' | 'danger', IconName> = {
  info: 'info',
  success: 'check',
  warning: 'alert',
  danger: 'alert',
};
const COLOR = {
  info: 'var(--info)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
} as const;

export function NotificationsPanel() {
  const close = useUiStore((s) => s.closePanel);
  const select = useUiStore((s) => s.selectParcel);
  const notifications = useNotifications();
  const markRead = useMarkNotificationsRead();
  const world = useWorld();
  const today = world.data?.gameDay ?? 0;
  const unread = notifications.data?.unreadCount ?? 0;
  return (
    <Panel
      title="Notifications"
      subtitle={unread > 0 ? `${unread} unread` : 'Activity feed'}
      onClose={close}
      testId="notifications-panel"
      actions={
        unread > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            busy={markRead.isPending}
            onClick={() => markRead.mutate({ all: true })}
            data-testid="notifications-mark-all"
          >
            Mark all read
          </Button>
        ) : null
      }
    >
      <QueryView query={notifications}>
        {(data) =>
          data.notifications.length === 0 ? (
            <EmptyState icon="bell" title="All quiet">
              Harvest alerts, sales, loan dues and market moves appear here.
            </EmptyState>
          ) : (
            <ul className="bh-stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
              {data.notifications.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className="bh-card"
                    style={{
                      all: 'unset',
                      boxSizing: 'border-box',
                      display: 'flex',
                      gap: 10,
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: 10,
                      cursor: 'pointer',
                      borderLeft: `3px solid ${COLOR[n.severity]}`,
                      background: n.read ? 'transparent' : 'var(--glass-soft)',
                      opacity: n.read ? 0.72 : 1,
                    }}
                    onClick={() => {
                      if (!n.read) markRead.mutate({ ids: [n.id] });
                      if (n.entityType === 'parcel' && n.entityId)
                        select(n.entityId, { focus: true });
                    }}
                    aria-label={`${n.read ? '' : 'Unread: '}${n.title}`}
                  >
                    <Icon
                      name={ICON[n.severity]}
                      size={16}
                      style={{ color: COLOR[n.severity], flex: 'none', marginTop: 2 }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <strong style={{ fontWeight: n.read ? 550 : 700 }}>{n.title}</strong>
                        <span className="faint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                          {relativeDay(n.gameDay, today)}
                        </span>
                      </span>
                      <span className="muted" style={{ fontSize: 12.5, display: 'block' }}>
                        {n.body}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
    </Panel>
  );
}
