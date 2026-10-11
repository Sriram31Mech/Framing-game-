import { useEffect, useRef } from 'react';
import { useOverview } from '../../api/queries';
import { useIsStale } from '../../store/connection';
import { useSettingsStore } from '../../store/settings';
import { useUiStore, type PanelId } from '../../store/ui';
import { Icon, type IconName } from '../../ui/Icon';
import { perfStats } from '../../world/cameraState';

const NAV: { id: PanelId; label: string; icon: IconName }[] = [
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'farm', label: 'Farm', icon: 'farm' },
  { id: 'inventory', label: 'Stock', icon: 'inventory' },
  { id: 'market', label: 'Market', icon: 'market' },
  { id: 'contracts', label: 'Deals', icon: 'contracts' },
  { id: 'finance', label: 'Finance', icon: 'finance' },
  { id: 'leaderboard', label: 'Ranks', icon: 'leaderboard' },
  { id: 'notifications', label: 'Inbox', icon: 'bell' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const FULL_NAMES: Partial<Record<PanelId, string>> = {
  inventory: 'Inventory',
  contracts: 'Contracts',
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
          {i === 6 ? <span className="sep" aria-hidden="true" /> : null}
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

export function Legend() {
  return (
    <div className="bh-legend bh-glass" aria-label="Map legend">
      <span>
        <span className="sw" style={{ color: '#ffad33' }} />
        Yours
      </span>
      <span>
        <span className="sw" style={{ color: '#f3eee2', borderStyle: 'dashed' }} />
        For sale
      </span>
      <span>
        <span className="sw" style={{ color: '#6f8fe0' }} />
        AI company
      </span>
      <span>
        <span className="sw" style={{ color: '#b3a68f' }} />
        Other owners
      </span>
    </div>
  );
}

export function Hints() {
  return (
    <div className="bh-hints bh-glass" aria-hidden="true">
      <kbd>W</kbd>
      <kbd>A</kbd>
      <kbd>S</kbd>
      <kbd>D</kbd> pan · <kbd>Q</kbd>
      <kbd>E</kbd> rotate · <kbd>+</kbd>
      <kbd>−</kbd> zoom · right-drag orbit · double-click focus · <kbd>Esc</kbd> close
    </div>
  );
}

/** Dev perf overlay (fps, draw calls, triangles) — reads mutable stats twice a second. */
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
        `${s.instances.toLocaleString('en-IN')} crop instances\n${s.geometries} geometries · layout ${s.layoutMs.toFixed(0)} ms`;
    }, 500);
    return () => clearInterval(id);
  }, [show]);
  if (!show) return null;
  return (
    <div ref={ref} className="bh-perf bh-glass" data-testid="perf-overlay" aria-hidden="true" />
  );
}
