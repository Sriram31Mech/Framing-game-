/**
 * Onboarding tutorial: a lightweight step-by-step tooltip that guides new players through
 * the core loop without blocking the UI. Each step highlights a HUD element and explains
 * what to do next. Dismissed permanently once the player completes all steps or clicks Skip.
 */
import { useEffect, type CSSProperties } from 'react';
import { useOverview, usePlots } from '../../api/queries';
import { useOnboarding, type OnboardingStep } from '../../store/onboarding';
import { useUiStore, type PanelId } from '../../store/ui';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';

interface StepConfig {
  title: string;
  body: string;
  anchor?: string;
  nudgePanel?: PanelId;
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

const STEP_CONFIG: Record<OnboardingStep, StepConfig> = {
  welcome: {
    title: 'Welcome to Hemavati Valley',
    body: 'You have founded your company with starting capital. The valley is yours to survey — land, crops, markets and rival companies all share the same living economy.',
    placement: 'bottom',
  },
  inspect_land: {
    title: 'Survey the land',
    body: 'Open the Map, then click any parcel to inspect its soil, water access, elevation and crop suitability scores. Your starter plot is already reserved for you.',
    anchor: 'nav-map',
    nudgePanel: 'map',
    placement: 'right',
  },
  buy_or_lease: {
    title: 'Acquire a parcel',
    body: 'Buy a parcel outright or lease it for 1–3 seasons. Leasing is cheaper upfront but you pay rent and land tax. Parcels with a live crop cannot change hands.',
    anchor: 'parcel-buy-button',
    placement: 'top',
  },
  plant_crop: {
    title: 'Plant your first crop',
    body: 'Select a parcel you own or lease, then tap Plant crop. Choose a crop that suits the soil and season — the suitability panel shows the key factors.',
    anchor: 'nav-farm',
    nudgePanel: 'farm',
    placement: 'right',
  },
  harvest: {
    title: 'Harvest when ready',
    body: 'The Farm panel shows crop health, water stress and the harvest countdown. Harvest before the deadline to avoid yield loss.',
    anchor: 'nav-farm',
    nudgePanel: 'farm',
    placement: 'right',
  },
  sell: {
    title: 'Sell at the mandi',
    body: 'Open Markets → Sell to mandi. Enter a quantity to get a live quote including transport and fee. You can also post a player listing or accept a forward contract.',
    anchor: 'nav-market',
    nudgePanel: 'market',
    placement: 'right',
  },
};

function anchorRect(testId: string | undefined): DOMRect | null {
  if (!testId) return null;
  const el = document.querySelector(`[data-testid="${testId}"]`);
  return el ? el.getBoundingClientRect() : null;
}

function tooltipStyle(
  rect: DOMRect | null,
  placement: StepConfig['placement'] = 'bottom',
): CSSProperties {
  if (!rect) {
    return { position: 'fixed', bottom: 100, left: '50%', transform: 'translateX(-50%)' };
  }
  const gap = 12;
  switch (placement) {
    case 'right':
      return {
        position: 'fixed',
        top: rect.top + rect.height / 2,
        left: rect.right + gap,
        transform: 'translateY(-50%)',
      };
    case 'left':
      return {
        position: 'fixed',
        top: rect.top + rect.height / 2,
        right: window.innerWidth - rect.left + gap,
        transform: 'translateY(-50%)',
      };
    case 'top':
      return {
        position: 'fixed',
        bottom: window.innerHeight - rect.top + gap,
        left: rect.left + rect.width / 2,
        transform: 'translateX(-50%)',
      };
    default:
      return {
        position: 'fixed',
        top: rect.bottom + gap,
        left: rect.left + rect.width / 2,
        transform: 'translateX(-50%)',
      };
  }
}

/** Auto-advance: mark a step complete when game state shows the player did it. */
function useAutoAdvance() {
  const { complete, currentStep } = useOnboarding();
  const overview = useOverview();
  const plots = usePlots();

  useEffect(() => {
    const step = currentStep();
    if (!step) return;
    const o = overview.data;
    const p = plots.data;
    if (!o || !p) return;

    if (step === 'buy_or_lease' && o.counts.parcelsOwned + o.counts.parcelsLeased > 0) {
      complete('buy_or_lease');
    }
    if (
      step === 'plant_crop' &&
      p.plots.some((pl) => pl.status === 'growing' || pl.status === 'ready')
    ) {
      complete('plant_crop');
    }
    if (step === 'harvest' && p.plots.some((pl) => pl.status === 'harvested')) {
      complete('harvest');
    }
    if (step === 'sell' && o.profitAndLoss.revenuePaise > 0) {
      complete('sell');
    }
  }, [overview.data, plots.data, complete, currentStep]);
}

export function OnboardingTooltip({ companyId }: { companyId: string }) {
  const { init, currentStep, complete, dismiss, isDone } = useOnboarding();
  const openPanel = useUiStore((s) => s.openPanel);

  useEffect(() => {
    init(companyId);
  }, [companyId, init]);

  // Auto-advance the welcome step after a short read time (runs once on mount).
  useEffect(() => {
    if (currentStep() !== 'welcome') return;
    const t = setTimeout(() => complete('welcome'), 6_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useAutoAdvance();

  const step = currentStep();
  if (!step || isDone()) return null;

  const cfg = STEP_CONFIG[step];
  const rect = anchorRect(cfg.anchor);
  const style = tooltipStyle(rect, cfg.placement);

  const handleNext = () => {
    if (cfg.nudgePanel) openPanel(cfg.nudgePanel);
    complete(step);
  };

  return (
    <>
      {rect ? (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
            borderRadius: 8,
            border: '2px solid var(--accent)',
            boxShadow: '0 0 0 4px rgba(255,165,0,0.18)',
            pointerEvents: 'none',
            zIndex: 9998,
          }}
        />
      ) : null}

      <div
        className="bh-glass bh-onboarding-tooltip"
        style={{ ...style, zIndex: 9999, maxWidth: 300, padding: '14px 16px' }}
        role="status"
        aria-live="polite"
        data-testid="onboarding-tooltip"
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 8,
            marginBottom: 6,
          }}
        >
          <strong style={{ fontSize: 13.5 }}>{cfg.title}</strong>
          <button
            type="button"
            className="bh-icon-btn"
            aria-label="Skip tutorial"
            onClick={dismiss}
            style={{ flex: 'none', marginTop: -2 }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <p
          style={{
            fontSize: 12.5,
            margin: '0 0 10px',
            lineHeight: 1.5,
            color: 'var(--text-muted)',
          }}
        >
          {cfg.body}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button size="sm" variant="ghost" onClick={dismiss} data-testid="onboarding-skip">
            Skip
          </Button>
          <Button size="sm" variant="primary" onClick={handleNext} data-testid="onboarding-next">
            {cfg.nudgePanel ? 'Show me' : 'Got it'}
          </Button>
        </div>
      </div>
    </>
  );
}
