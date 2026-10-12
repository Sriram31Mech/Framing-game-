import type { MeResponse, WorldResponse } from '@bh/contracts';
import { useEffect, useRef, useState } from 'react';
import { api, signOutLocally } from '../../api/client';
import { useAuthConfig, useNotifications, useOverview, useWorld } from '../../api/queries';
import { useDevAdvance } from '../../api/mutations';
import { formatCountdown, money, moneyCompact, tamilSeasonLabel } from '../../lib/format';
import { useConnectionStore, type ConnectionStatus } from '../../store/connection';
import { useUiStore } from '../../store/ui';
import { Chip } from '../../ui/Bits';
import { Button, IconButton } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { Logo } from '../../ui/Logo';
import { Skeleton } from '../../ui/States';

const CONN_LABEL: Record<ConnectionStatus, string> = {
  idle: 'Offline',
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

export function ConnectionBadge() {
  const status = useConnectionStore((s) => s.status);
  const title =
    status === 'live'
      ? 'Realtime updates are flowing.'
      : status === 'offline'
        ? 'No realtime connection. Data refreshes periodically and may be stale.'
        : 'Re-establishing the realtime connection…';
  return (
    <span
      className={`bh-conn ${status}`}
      title={title}
      role="status"
      aria-live="polite"
      data-testid="connection-status"
      data-status={status}
    >
      <span className="dot" aria-hidden="true" />
      {CONN_LABEL[status]}
    </span>
  );
}

export function weatherIcon(w: WorldResponse['weather']): { icon: IconName; label: string } {
  if (!w) return { icon: 'sun', label: 'Clear' };
  switch (w.event) {
    case 'heavy_rain':
      return { icon: 'storm', label: 'Heavy rain' };
    case 'heatwave':
      return { icon: 'heat', label: 'Heatwave' };
    case 'dry_spell':
      return { icon: 'dry', label: 'Dry spell' };
    case 'pest_outbreak':
      return { icon: 'bug', label: 'Pest outbreak' };
    default:
      if (w.rainMm >= 2) return { icon: 'rain', label: 'Rain' };
      if (w.rainMm > 0) return { icon: 'cloud', label: 'Light showers' };
      return { icon: 'sun', label: 'Clear' };
  }
}

function Countdown({
  nextTickAt,
  paused,
  onElapsed,
}: {
  nextTickAt: string;
  paused: boolean;
  onElapsed: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Date.parse(nextTickAt) - now;
  useEffect(() => {
    // If the day rolled over but no realtime hint arrived, refetch shortly after.
    if (remaining < -4000 && fired.current !== nextTickAt) {
      fired.current = nextTickAt;
      onElapsed();
    }
  }, [remaining, nextTickAt, onElapsed]);
  if (paused) return <span className="sub">Clock paused</span>;
  return (
    <span className="sub" title="Real time until the next game day">
      Next day in {formatCountdown(remaining)}
    </span>
  );
}

function GameDate() {
  const world = useWorld();
  const w = world.data;
  if (!w) return <Skeleton width={150} height={30} />;
  const weather = weatherIcon(w.weather);
  return (
    <div className="bh-date">
      <span
        title={
          w.weather
            ? `${weather.label} · ${w.weather.tempC.toFixed(1)}°C · ${w.weather.rainMm.toFixed(1)} mm rain`
            : weather.label
        }
      >
        <Icon
          name={weather.icon}
          size={22}
          className="tone-accent"
          aria-label={weather.label}
          role="img"
          aria-hidden={false}
        />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span className="date-label" data-testid="game-date" data-game-day={w.gameDay}>
          {w.date.label}
          <Chip tone="accent" title={`Day ${w.gameDay}`}>
            {tamilSeasonLabel(w.date.month)}
          </Chip>
        </span>
        <Countdown
          nextTickAt={w.nextTickAt}
          paused={w.paused}
          onElapsed={() => void world.refetch()}
        />
      </div>
    </div>
  );
}

function DevAdvance() {
  const config = useAuthConfig();
  const advance = useDevAdvance();
  const [days, setDays] = useState(1);
  if (!config.data || config.data.appEnv === 'production') return null;
  return (
    <div className="bh-row" title="Development only: run daily ticks immediately">
      <select
        className="bh-select"
        style={{ width: 74, height: 30 }}
        value={days}
        onChange={(e) => setDays(Number(e.target.value))}
        aria-label="Days to advance"
        data-testid="dev-advance-days"
      >
        {[1, 7, 30, 90].map((d) => (
          <option key={d} value={d}>
            +{d}d
          </option>
        ))}
      </select>
      <Button
        size="sm"
        icon="fastForward"
        busy={advance.isPending}
        onClick={() => advance.mutate(days)}
        data-testid="dev-advance"
      >
        Advance
      </Button>
    </div>
  );
}

function UserMenu() {
  const [open, setOpen] = useState(false);
  const openPanel = useUiStore((s) => s.openPanel);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <IconButton
        icon="menu"
        label="Menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        data-testid="menu-button"
      />
      {open ? (
        <div className="bh-menu bh-glass" role="menu">
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              openPanel('settings');
              setOpen(false);
            }}
          >
            <Icon name="settings" size={16} /> Settings
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              openPanel('leaderboard');
              setOpen(false);
            }}
          >
            <Icon name="leaderboard" size={16} /> Leaderboard
          </button>
          <button
            role="menuitem"
            type="button"
            data-testid="logout-button"
            onClick={() => {
              void api.logout().catch(() => undefined);
              signOutLocally();
            }}
          >
            <Icon name="logout" size={16} /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function TopBar({ me }: { me: MeResponse }) {
  const overview = useOverview();
  const notifications = useNotifications();
  const panel = useUiStore((s) => s.panel);
  const togglePanel = useUiStore((s) => s.togglePanel);
  const company = overview.data?.company ?? me.company!;
  const cash = overview.data?.company.cashPaise ?? me.company?.cashPaise ?? 0;
  const unread = notifications.data?.unreadCount ?? overview.data?.counts.unreadNotifications ?? 0;
  const grace = overview.data?.company.graceDaysRemaining;
  return (
    <header className="bh-topbar bh-glass">
      <div className="bh-brand">
        <Logo className="logo" />
        <span className="company" title={company.name} data-testid="company-name">
          {company.name}
        </span>
        {company.status === 'distressed' ? (
          <Chip
            tone="danger"
            title="Cash is negative. Restore a positive balance before the grace period ends to avoid bankruptcy."
          >
            Distressed{grace != null ? ` · ${grace}d grace` : ''}
          </Chip>
        ) : company.status === 'bankrupt' ? (
          <Chip tone="danger">Bankrupt</Chip>
        ) : null}
      </div>
      <span className="divider" aria-hidden="true" />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
        <span
          className="faint"
          style={{
            fontSize: 10.5,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontWeight: 650,
          }}
        >
          Cash
        </span>
        <span
          className={`cash${cash < 0 ? ' negative' : ''}`}
          title={money(cash)}
          data-testid="cash-display"
          data-paise={cash}
        >
          {moneyCompact(cash)}
        </span>
      </div>
      <span className="divider" aria-hidden="true" />
      <GameDate />
      <div className="grow" />
      <DevAdvance />
      <ConnectionBadge />
      <IconButton
        icon="bell"
        label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        badge={unread}
        active={panel === 'notifications'}
        onClick={() => togglePanel('notifications')}
        data-testid="notifications-bell"
      />
      <UserMenu />
    </header>
  );
}
