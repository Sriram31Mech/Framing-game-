import type { MeResponse } from '@bh/contracts';
import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react';
import { useLeaderboard, useRegionMap } from '../api/queries';
import { AwayModal } from '../features/away/AwayModal';
import { OnboardingTooltip } from '../features/onboarding/OnboardingTooltip';
import { ContractsPanel } from '../features/contracts/ContractsPanel';
import { FarmPanel } from '../features/farm/FarmPanel';
import { FinancePanel } from '../features/finance/FinancePanel';
import { Dock, Hints, Legend, PerfOverlay, StaleBanner } from '../features/hud/HudChrome';
import { HoverTooltip, setHoverPointer } from '../features/hud/HoverTooltip';
import { TopBar } from '../features/hud/TopBar';
import { InventoryPanel } from '../features/inventory/InventoryPanel';
import { LandInspector } from '../features/land/LandInspector';
import { PlantDialog } from '../features/land/PlantDialog';
import { LeaderboardPanel } from '../features/leaderboard/LeaderboardPanel';
import { MapPanel } from '../features/map/MapPanel';
import { MarketPanel } from '../features/market/MarketPanel';
import { NotificationsPanel } from '../features/notifications/NotificationsPanel';
import { SettingsPanel } from '../features/settings/SettingsPanel';
import { useSettingsStore } from '../store/settings';
import { useUiStore } from '../store/ui';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/States';
import { ErrorBoundary } from './ErrorBoundary';

const WorldView = lazy(() => import('../world/WorldView'));

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const ui = useUiStore.getState();
      if (ui.panel) ui.closePanel();
      else if (ui.selectedParcelId) ui.selectParcel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function WorldFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="bh-landing-fallback" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="bh-glass" style={{ padding: 24, maxWidth: 420 }}>
        <ErrorState error={error} />
        <p className="muted" style={{ fontSize: 13 }}>
          The 3D view could not start (WebGL may be disabled). All management panels still work —
          use the Map panel to pick parcels.
        </p>
        <Button icon="refresh" onClick={onRetry}>
          Retry 3D view
        </Button>
      </div>
    </div>
  );
}

export function GameScreen({ me }: { me: MeResponse }) {
  useGlobalKeys();
  const companyId = me.company?.id ?? null;
  const map = useRegionMap(me.regionId);
  const leaderboard = useLeaderboard();
  const panel = useUiStore((s) => s.panel);
  const selectedParcelId = useUiStore((s) => s.selectedParcelId);
  const hoveredParcelId = useUiStore((s) => s.hoveredParcelId);
  const plantParcelId = useUiStore((s) => s.plantParcelId);
  const showPerf = useSettingsStore((s) => s.showPerf);

  const aiIds = useMemo(
    () =>
      new Set(
        (leaderboard.data?.entries ?? []).filter((e) => e.kind === 'ai').map((e) => e.companyId),
      ),
    [leaderboard.data],
  );
  const parcelMap = useMemo(
    () => new Map((map.data?.parcels ?? []).map((p) => [p.id, p])),
    [map.data],
  );

  const onHover = useCallback((id: string | null, x: number, y: number) => {
    setHoverPointer(x, y);
    useUiStore.getState().setHovered(id);
    document.body.style.cursor = id ? 'pointer' : '';
  }, []);
  const onSelect = useCallback((id: string, focus: boolean) => {
    useUiStore.getState().selectParcel(id, { focus });
  }, []);
  useEffect(
    () => () => {
      document.body.style.cursor = '';
    },
    [],
  );

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        {map.data ? (
          <ErrorBoundary
            fallback={(error, reset) => <WorldFallback error={error} onRetry={reset} />}
          >
            <Suspense fallback={<div className="bh-landing-fallback" />}>
              <WorldView
                map={map.data}
                mode="game"
                myCompanyId={companyId}
                aiCompanyIds={aiIds}
                selectedParcelId={selectedParcelId}
                hoveredParcelId={hoveredParcelId}
                onHover={onHover}
                onSelect={onSelect}
                showPerf={showPerf}
              />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <div className="bh-landing-fallback" style={{ display: 'grid', placeItems: 'center' }}>
            {map.isError ? (
              <div className="bh-glass" style={{ padding: 20 }}>
                <ErrorState error={map.error} onRetry={() => void map.refetch()} />
              </div>
            ) : (
              <div className="bh-row muted" role="status">
                <span className="bh-spinner" aria-hidden="true" /> Surveying the valley…
              </div>
            )}
          </div>
        )}
      </div>
      <HoverTooltip parcels={parcelMap} myCompanyId={companyId} />
      <div className="bh-hud">
        <TopBar me={me} />
        <Dock />
        <StaleBanner />
        <Legend />
        <Hints />
        <PerfOverlay />
        {panel === 'land' && selectedParcelId ? (
          <LandInspector key={selectedParcelId} parcelId={selectedParcelId} />
        ) : null}
        {panel === 'map' ? <MapPanel map={map.data} aiIds={aiIds} myCompanyId={companyId} /> : null}
        {panel === 'farm' ? <FarmPanel areaById={parcelMap} /> : null}
        {panel === 'inventory' ? <InventoryPanel /> : null}
        {panel === 'market' ? <MarketPanel /> : null}
        {panel === 'contracts' ? <ContractsPanel /> : null}
        {panel === 'finance' ? <FinancePanel /> : null}
        {panel === 'leaderboard' ? <LeaderboardPanel myCompanyId={companyId} /> : null}
        {panel === 'notifications' ? <NotificationsPanel /> : null}
        {panel === 'settings' ? <SettingsPanel me={me} /> : null}
      </div>
      {plantParcelId ? <PlantDialog parcelId={plantParcelId} /> : null}
      <AwayModal />
      {me.company ? <OnboardingTooltip companyId={me.company.id} /> : null}
    </div>
  );
}
