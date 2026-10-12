import { useEffect, useRef } from 'react';
import { useOverview } from '../../api/queries';
import { useIsStale } from '../../store/connection';
import { useSettingsStore } from '../../store/settings';
import { useUiStore, type PanelId } from '../../store/ui';
import { Icon, type IconName } from '../../ui/Icon';
import { perfStats } from '../../world/tn/perf';

const NAV: { id: PanelId; label: string; icon: IconName }[] = [
  { id: 'map', label: 'Find land', icon: 'map' },
  { id: 'farm', label: 'My farms', icon: 'farm' },
  { id: 'inventory', label: 'Storage', icon: 'inventory' },
  { id: 'market', label: 'Sell', icon: 'market' },
  { id: 'finance', label: 'Money', icon: 'finance' },
  { id: 'contracts', label: 'Deals', icon: 'contracts' },
  { id: 'leaderboard', label: 'Ranks', icon: 'leaderboard' },
  { id: 'notifications', label: 'Inbox', icon: 'bell' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/** Index of the first secondary item (after the separator). */
const SECONDARY_FROM = 5;

const FULL_NAMES: Partial<Record<PanelId, string>> = {
  map: 'Find land in Tamil Nadu',
  farm: 'My farms and crops',
  inventory: 'Storage (harvested produce)',
  market: 'Sell at mandis and trade',
  finance: 'Money: cash, loans, machinery',
  contracts: 'Contracts with other players',
  leaderboard: 'Leaderboard',
  notifications: 'Notifications',
};

export function Dock() {
  const panel = useUiStore((s) => s.panel);
  const toggle = useUiStore((s) => s.togglePanel);
  const overview = useOverview();
  const ready = overview.data?.counts.plotsReady ?? 0;
  return (
    <nav className="bh-dock bh-glass" aria-label="Game sections">
      {NAV.map((n, i) => (
        <span key={n.id} style={{ display: 'contents' }}>
          {i === SECONDARY_FROM ? <span className="sep" aria-hidden="true" /> : null}
          <button
            type="button"
            aria-pressed={panel === n.id}
            aria-label={FULL_NAMES[n.id] ?? n.label}
            title={FULL_NAMES[n.id] ?? n.label}
            onClick={() => toggle(n.id)}
            data-testid={`nav-${n.id}`}
          >
            <Icon name={n.icon} size={20} />
            {n.label}
            {n.id === 'farm' && ready > 0 ? (
              <span
                className="bh-badge-count"
                style={{ background: 'var(--success)' }}
                aria-hidden="true"
              >
                {ready}
              </span>
            ) : null}
          </button>
        </span>
      ))}
    </nav>
  );
}

export function StaleBanner() {
  const stale = useIsStale();
  if (!stale) return null;
  return (
    <div className="bh-stale-banner bh-glass" role="status">
      <Icon name="alert" size={14} className="tone-warning" />
      Live updates paused — showing the last known state, refreshing periodically.
    </div>
  );
}

export function PerfOverlay() {
  const show = useSettingsStore((s) => s.showPerf);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!show) return;
    const id = setInterval(() => {
      if (!ref.current) return;
      const s = perfStats;
      ref.current.textContent =
        `${s.fps.toFixed(0).padStart(3)} fps  ${s.frameMs.toFixed(1)} ms\n` +
        `${s.calls} draw calls\n${(s.triangles / 1000).toFixed(0)}k triangles\n` +
        `${s.geometries} geometries · ${s.textures} textures`;
    }, 500);
    return () => clearInterval(id);
  }, [show]);
  if (!show) return null;
  return (
    <div ref={ref} className="bh-perf bh-glass" data-testid="perf-overlay" aria-hidden="true" />
  );
}
