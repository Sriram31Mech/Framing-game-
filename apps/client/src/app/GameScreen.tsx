import type { MeResponse, RegionMapResponse } from '@bh/contracts';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useLeaderboard, useRegionMap } from '../api/queries';
import { AwayModal } from '../features/away/AwayModal';
import { ContractsPanel } from '../features/contracts/ContractsPanel';
import { FarmPanel } from '../features/farm/FarmPanel';
import { FinancePanel } from '../features/finance/FinancePanel';
import { NextStepCard } from '../features/guide/NextStepCard';
import { Dock, PerfOverlay, StaleBanner } from '../features/hud/HudChrome';
import { TopBar } from '../features/hud/TopBar';
import { InventoryPanel } from '../features/inventory/InventoryPanel';
import { LandInspector } from '../features/land/LandInspector';
import { PlantDialog } from '../features/land/PlantDialog';
import { LeaderboardPanel } from '../features/leaderboard/LeaderboardPanel';
import { MarketPanel } from '../features/market/MarketPanel';
import { NotificationsPanel } from '../features/notifications/NotificationsPanel';
import { FindLandPanel } from '../features/segment/FindLandPanel';
import { SegmentPanel } from '../features/segment/SegmentPanel';
import { SettingsPanel } from '../features/settings/SettingsPanel';
import { Tour } from '../features/tour/Tour';
import { moneyCompact } from '../lib/format';
import { useUiStore } from '../store/ui';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/States';
import { AreaHud } from '../world/area/AreaHud';
import { MAP_LAYERS, ZONE_LEGEND } from '../world/tn/colors';
import type { MapPin } from '../world/tn/TamilNaduMap';
import { ErrorBoundary } from './ErrorBoundary';

const TamilNaduMap = lazy(() => import('../world/tn/TamilNaduMap'));
const AreaScene = lazy(() => import('../world/area/AreaScene'));

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const ui = useUiStore.getState();
      if (ui.panel) ui.closePanel();
      else if (ui.areaSegmentId) ui.exitArea();
      else if (ui.selectedSegmentId) ui.selectSegment(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function MapFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="bh-landing-fallback" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="bh-glass" style={{ padding: 24, maxWidth: 420 }}>
        <ErrorState error={error} />
        <p className="muted" style={{ fontSize: 13 }}>
          The 3D map could not start (WebGL may be disabled). Use “Find land” to browse areas.
        </p>
        <Button icon="refresh" onClick={onRetry}>
          Retry map
        </Button>
      </div>
    </div>
  );
}

function LayerBar() {
  const layer = useUiStore((s) => s.mapLayer);
  const setLayer = useUiStore((s) => s.setMapLayer);
  return (
    <div className="tn-layers bh-glass" role="radiogroup" aria-label="Map colours">
      {MAP_LAYERS.map((l) => (
        <button
          key={l.id}
          type="button"
          role="radio"
          aria-checked={layer === l.id}
          title={l.hint}
          onClick={() => setLayer(l.id)}
          data-testid={`layer-${l.id}`}
        >
          {l.label}
        </button>
      ))}
      {layer === 'zone' ? (
        <div className="tn-legend">
          {ZONE_LEGEND.map(([name, color]) => (
            <span key={name}>
              <i style={{ background: color }} />
              {name.replace(' Zone', '')}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SegmentTooltip({ map, pos }: { map?: RegionMapResponse; pos: { x: number; y: number } }) {
  const id = useUiStore((s) => s.hoveredSegmentId);
  const seg = id ? map?.segments.find((s) => s.id === id) : undefined;
  if (!seg || !map) return null;
  const district = map.districts.find((d) => d.id === seg.districtId);
  return (
    <div
      className="tn-tooltip bh-glass"
      style={{ left: pos.x + 14, top: pos.y + 14 }}
      role="tooltip"
    >
      <strong>{seg.name}</strong>
      <span className="muted">
        {district?.name} · <span lang="ta">{district?.tamilName}</span>
      </span>
      <span>
        {seg.holdingsForSale > 0
          ? `${seg.holdingsForSale} holdings for sale · from ${moneyCompact(seg.minPricePaise ?? 0)}`
          : seg.holdings > 0
            ? 'No land for sale right now'
            : 'Urban area'}
      </span>
      {seg.mine > 0 ? <span className="tn-mine">You farm {seg.mine} here</span> : null}
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
  const selectedSegmentId = useUiStore((s) => s.selectedSegmentId);
  const hoveredSegmentId = useUiStore((s) => s.hoveredSegmentId);
  const focusSegment = useUiStore((s) => s.focusSegment);
  const layer = useUiStore((s) => s.mapLayer);
  const plantParcelId = useUiStore((s) => s.plantParcelId);
  const areaSegmentId = useUiStore((s) => s.areaSegmentId);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });

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
  const pins = useMemo<MapPin[]>(
    () =>
      (map.data?.parcels ?? []).map((p) => ({
        id: p.id,
        x: p.centroid.x,
        y: p.centroid.y,
        kind:
          p.operatorCompanyId === companyId
            ? p.crop?.status === 'ready'
              ? 'ready'
              : 'mine'
            : p.operatorCompanyId && aiIds.has(p.operatorCompanyId)
              ? 'ai'
              : 'other',
      })),
    [map.data, companyId, aiIds],
  );

  // On arrival, fly to the player's own land so the next step is in view.
  const myFirstSegment = map.data?.parcels.find(
    (p) => p.operatorCompanyId === companyId,
  )?.segmentId;
  useEffect(() => {
    if (myFirstSegment && !useUiStore.getState().focusSegment) {
      useUiStore.setState({ focusSegment: { id: myFirstSegment, nonce: 1 } });
    }
  }, [myFirstSegment]);

  const onHover = useCallback((id: string | null, x: number, y: number) => {
    setPointer({ x, y });
    useUiStore.getState().setHoveredSegment(id);
    document.body.style.cursor = id ? 'var(--cursor-hand)' : '';
  }, []);
  const onSelectSegment = useCallback((id: string) => useUiStore.getState().enterArea(id), []);
  const onSelectPin = useCallback((id: string) => useUiStore.getState().selectParcel(id), []);
  useEffect(
    () => () => {
      document.body.style.cursor = '';
    },
    [],
  );

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        {areaSegmentId ? (
          <ErrorBoundary
            key={areaSegmentId}
            fallback={(error) => (
              <MapFallback error={error} onRetry={() => useUiStore.getState().exitArea()} />
            )}
          >
            <Suspense fallback={<div className="bh-landing-fallback" />}>
              <AreaScene segmentId={areaSegmentId} aiIds={aiIds} />
            </Suspense>
          </ErrorBoundary>
        ) : map.data ? (
          <ErrorBoundary fallback={(error, reset) => <MapFallback error={error} onRetry={reset} />}>
            <Suspense fallback={<div className="bh-landing-fallback" />}>
              <TamilNaduMap
                mode="game"
                districts={map.data.districts}
                segments={map.data.segments}
                layer={layer}
                river={map.data.river.points}
                roads={map.data.roads.map((r) => r.points)}
                markets={map.data.markets}
                pins={pins}
                selectedSegmentId={selectedSegmentId}
                hoveredSegmentId={hoveredSegmentId}
                focusSegmentId={focusSegment?.id ?? null}
                focusNonce={focusSegment?.nonce ?? 0}
                onHoverSegment={onHover}
                onSelectSegment={onSelectSegment}
                onSelectPin={onSelectPin}
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
                <span className="bh-spinner" aria-hidden="true" /> Loading the map of Tamil Nadu…
              </div>
            )}
          </div>
        )}
      </div>
      {areaSegmentId ? null : <SegmentTooltip map={map.data} pos={pointer} />}
      <div className="bh-hud">
        <TopBar me={me} />
        {companyId ? <NextStepCard map={map.data} companyId={companyId} /> : null}
        {companyId ? <Tour map={map.data} companyId={companyId} /> : null}
        <Dock />
        {areaSegmentId ? <AreaHud segmentId={areaSegmentId} /> : <LayerBar />}
        <StaleBanner />
        <PerfOverlay />
        {panel === 'segment' && selectedSegmentId ? (
          <SegmentPanel key={selectedSegmentId} segmentId={selectedSegmentId} />
        ) : null}
        {panel === 'land' && selectedParcelId ? (
          <LandInspector key={selectedParcelId} parcelId={selectedParcelId} />
        ) : null}
        {panel === 'map' ? <FindLandPanel map={map.data} /> : null}
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
    </div>
  );
}
