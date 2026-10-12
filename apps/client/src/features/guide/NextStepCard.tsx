/**
 * "What should I do now?" — one clear next action derived from the company's real state:
 * plant → wait → harvest → sell → expand. Always visible, never a wall of text.
 */
import type { RegionMapResponse } from '@bh/contracts';
import { useMemo } from 'react';
import { useDevAdvance, useHarvest } from '../../api/mutations';
import { useAuthConfig, useInventory, useOverview, usePlots, useWorld } from '../../api/queries';
import { CROP_META } from '../../lib/cropMeta';
import { formatKg } from '../../lib/format';
import { useOnboarding, useTourActive } from '../../store/onboarding';
import { useUiStore } from '../../store/ui';
import { Button } from '../../ui/Button';

interface Step {
  key: string;
  n: number;
  title: string;
  body: string;
  action?: { label: string; run: () => void; busy?: boolean; testId: string };
  secondary?: { label: string; run: () => void; busy?: boolean };
}

const TOTAL = 5;

export function NextStepCard({ map, companyId }: { map?: RegionMapResponse; companyId: string }) {
  const overview = useOverview();
  const plots = usePlots();
  const inventory = useInventory();
  const world = useWorld();
  const config = useAuthConfig();
  const harvest = useHarvest();
  const advance = useDevAdvance();
  const ui = useUiStore();
  const devMode = config.data ? config.data.appEnv !== 'production' : false;
  const today = world.data?.gameDay ?? 0;
  const tourActive = useTourActive(companyId);
  const resumeTour = useOnboarding((s) => s.resume);

  const step = useMemo<Step | null>(() => {
    if (!overview.data || !plots.data || !inventory.data) return null;
    const live = plots.data.plots.filter((p) => p.status === 'growing' || p.status === 'ready');
    const ready = live.find((p) => p.status === 'ready');
    const failed = plots.data.plots.find((p) => p.status === 'failed');
    const stock = inventory.data.totals.find((t) => t.availableKg > 0);
    const myParcels = (map?.parcels ?? []).filter((p) => p.operatorCompanyId === companyId);
    const idle = myParcels.find((p) => !p.crop);
    const skip = (days: number) =>
      devMode
        ? { label: `Skip ${days} days`, run: () => advance.mutate(days), busy: advance.isPending }
        : undefined;

    if (ready) {
      return {
        key: 'harvest',
        n: 3,
        title: `Harvest your ${CROP_META[ready.cropId].label}`,
        body: `About ${formatKg(ready.expectedHarvestKg)} is ready. Harvest before day ${ready.harvestDeadlineDay ?? '—'} or it starts to spoil.`,
        action: {
          label: 'Harvest now',
          run: () => harvest.mutate({ plotId: ready.id, parcelId: ready.parcelId }),
          busy: harvest.isPending,
          testId: 'guide-harvest',
        },
      };
    }
    if (stock) {
      return {
        key: 'sell',
        n: 4,
        title: `Sell ${formatKg(stock.availableKg)} of ${CROP_META[stock.itemId].label}`,
        body: 'Compare mandi prices across districts — farther markets may pay more after transport.',
        action: {
          label: 'Go to market',
          run: () => ui.openSell(stock.itemId),
          testId: 'guide-sell',
        },
      };
    }
    if (failed) {
      return {
        key: 'clear',
        n: 2,
        title: 'A crop failed — clear the field',
        body: 'Check water and pest pressure next time. Clear the plot to plant again.',
        action: { label: 'Open my farms', run: () => ui.openPanel('farm'), testId: 'guide-farm' },
      };
    }
    if (live.length > 0) {
      const next = [...live].sort((a, b) => (a.readyDay ?? 1e9) - (b.readyDay ?? 1e9))[0]!;
      const days = Math.max(0, (next.readyDay ?? today) - today);
      return {
        key: 'grow',
        n: 3,
        title: `${CROP_META[next.cropId].label} is growing`,
        body: `Ready in about ${days} days. Keep it watered and spray if pests rise. Meanwhile, explore land to expand.`,
        action: { label: 'Check my farms', run: () => ui.openPanel('farm'), testId: 'guide-farm' },
        secondary: skip(Math.min(30, Math.max(1, days))),
      };
    }
    if (idle) {
      return {
        key: 'plant',
        n: 2,
        title: 'Plant your first crop',
        body: `Your field (${idle.id}) is empty. Pick a crop that suits its soil and the current season.`,
        action: { label: 'Choose a crop', run: () => ui.openPlant(idle.id), testId: 'guide-plant' },
        secondary: {
          label: 'Show on map',
          run: () =>
            idle.segmentId ? ui.selectSegment(idle.segmentId, { focus: true }) : undefined,
        },
      };
    }
    if (myParcels.length === 0) {
      return {
        key: 'first-field',
        n: 1,
        title: 'Get your first field',
        body: 'Every starter plot is taken, so you received extra cash instead. Lease a holding for a season (cheapest way in) or buy one.',
        action: {
          label: 'Find affordable land',
          run: () => ui.openPanel('map'),
          testId: 'guide-first-field',
        },
      };
    }
    return {
      key: 'expand',
      n: 5,
      title: 'Grow your farm business',
      body: 'Green areas have land for sale. Open an area, compare holdings, then buy or lease.',
      action: {
        label: 'Show land for sale',
        run: () => {
          ui.setMapLayer('land');
          ui.closePanel();
        },
        testId: 'guide-expand',
      },
    };
  }, [
    overview.data,
    plots.data,
    inventory.data,
    map,
    companyId,
    devMode,
    today,
    harvest,
    advance,
    ui,
  ]);

  // Thatha's tour owns this slot while it runs.
  if (!step || tourActive) return null;
  return (
    <aside className="tn-guide bh-glass" aria-label="Next step" data-testid="next-step">
      <div className="tn-guide-step">
        Step {step.n} of {TOTAL}
        <span className="tn-guide-dots" aria-hidden="true">
          {Array.from({ length: TOTAL }, (_, i) => (
            <i key={i} className={i < step.n ? 'on' : ''} />
          ))}
        </span>
      </div>
      <h3>{step.title}</h3>
      <p>{step.body}</p>
      <div className="bh-row">
        {step.action ? (
          <Button
            variant="primary"
            size="sm"
            busy={step.action.busy}
            onClick={step.action.run}
            data-testid={step.action.testId}
          >
            {step.action.label}
          </Button>
        ) : null}
        {step.secondary ? (
          <Button variant="ghost" size="sm" busy={step.secondary.busy} onClick={step.secondary.run}>
            {step.secondary.label}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={resumeTour} data-testid="tour-resume">
          Ask Thatha
        </Button>
      </div>
    </aside>
  );
}
