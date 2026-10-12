/**
 * Story intro + guided tour with Muthu Thatha. The story names the player's real starter land and
 * flies the camera there; then each tour step teaches one piece of the loop (visit land → open
 * holding → plant → grow → harvest → sell → finance) and completes on the real game state, with a
 * spotlight on the UI element to use, +XP and confetti. While Thatha talks or guides, only what
 * he points at can be used (guideLock). Progress persists in store/onboarding.
 */
import type { RegionMapResponse } from '@bh/contracts';
import { useEffect, useMemo, useState } from 'react';
import { useDevAdvance } from '../../api/mutations';
import { useAuthConfig, useInventory, useOverview, usePlots, useWorld } from '../../api/queries';
import { humanize, moneyCompact } from '../../lib/format';
import {
  currentTourStep,
  TOUR_STEPS,
  useOnboarding,
  XP_PER_STEP,
  type TourStepId,
} from '../../store/onboarding';
import { useUiStore } from '../../store/ui';
import { Button } from '../../ui/Button';
import { NUDGE_EVENT, useGuideLock } from './guideLock';
import { Spotlight } from './Spotlight';
import { Thatha } from './Thatha';
import { useVoice } from './useVoice';

const NO_PLOTS: never[] = [];

interface Beat {
  text: string;
  focusSegmentId?: string;
}

interface StepView {
  title: string;
  say: string;
  /** What the spotlight points at (first visible match). */
  targets: string[];
  /** Also usable while guided (panels / dialogs the step happens in). */
  allow?: string[];
  /** Free play while waiting (e.g. crops growing in real time): no input lock. */
  free?: boolean;
  action?: { label: string; run: () => void; busy?: boolean };
}

const ACTION = '[data-testid="tour-action"]';

function focusCamera(segmentId: string) {
  const prev = useUiStore.getState().focusSegment?.nonce ?? 0;
  useUiStore.setState({ focusSegment: { id: segmentId, nonce: prev + 1 } });
}

export function Tour({ map, companyId }: { map?: RegionMapResponse; companyId: string }) {
  const ob = useOnboarding();
  const selectedSegmentId = useUiStore((s) => s.selectedSegmentId);
  const selectedParcelId = useUiStore((s) => s.selectedParcelId);
  const plantParcelId = useUiStore((s) => s.plantParcelId);
  const panel = useUiStore((s) => s.panel);
  const ui = useUiStore.getState;
  const overview = useOverview();
  const plots = usePlots();
  const inventory = useInventory();
  const config = useAuthConfig();
  const world = useWorld();
  const advance = useDevAdvance();
  const [beat, setBeat] = useState(0);
  // Confetti only for steps completed in this session, not replayed on reload.
  const [seenCount] = useState(() => ob.completed.length);

  useEffect(() => ob.init(companyId), [ob, companyId]);

  const mine = map?.parcels.filter((p) => p.operatorCompanyId === companyId) ?? [];
  const parcel = mine.find((p) => p.isStarterPlot) ?? mine[0];
  const segment = parcel ? map?.segments.find((s) => s.id === parcel.segmentId) : undefined;
  const district = segment ? map?.districts.find((d) => d.id === segment.districtId) : undefined;
  const name = overview.data?.company.name ?? 'friend';
  const devMode = config.data ? config.data.appEnv !== 'production' : false;

  const beats = useMemo<Beat[]>(() => {
    const intro = {
      text: `Vanakkam, ${name}! I am Muthu Thatha. Come, sit with me — let me tell you a story.`,
    };
    const outro = {
      text: 'The monsoon is near. Walk with me through your first season: we will sow, grow, harvest, and sell at the mandi.',
      focusSegmentId: segment?.id,
    };
    if (!parcel || !segment || !district) {
      return [
        intro,
        {
          text: "Your grandfather's field was sold long ago, but he left you extra savings. Together we will find new land.",
        },
        outro,
      ];
    }
    const known = district.knownFor.slice(0, 2).join(' and ');
    const acres = (parcel.areaHa * 2.471).toFixed(1);
    return [
      intro,
      {
        text: `Long ago, your grandfather ploughed a small field in ${segment.name}, in ${district.name} district${known ? ` — the land of ${known}` : ''}.`,
        focusSegmentId: segment.id,
      },
      {
        text: `That field — holding ${parcel.id}, about ${acres} acres of ${humanize(parcel.soilTexture).toLowerCase()} soil — is yours now. And ${moneyCompact(overview.data?.company.cashPaise ?? 0)} is in the bank.`,
        focusSegmentId: segment.id,
      },
      outro,
    ];
  }, [name, parcel, segment, district, overview.data]);

  const inStory = ob.companyId === companyId && !ob.storyDone && !ob.dismissed && !!map;
  const step = currentTourStep(ob.completed);
  const plotList = plots.data?.plots ?? NO_PLOTS;
  const stock = inventory.data?.totals.find((t) => t.availableKg > 0);
  const revenue = overview.data?.profitAndLoss.revenuePaise ?? 0;

  const done = useMemo<Record<TourStepId, boolean>>(() => {
    const hasPlots = plotList.length > 0;
    const harvested =
      plotList.some((p) => p.status === 'harvested') ||
      (inventory.data?.lots.some((l) => l.source === 'harvest') ?? false) ||
      revenue > 0;
    return {
      find_land:
        !!parcel &&
        (selectedSegmentId === parcel.segmentId || selectedParcelId === parcel.id || hasPlots),
      open_plot: !!parcel && (selectedParcelId === parcel.id || !!plantParcelId || hasPlots),
      plant: hasPlots,
      grow: harvested || plotList.some((p) => p.status === 'ready'),
      harvest: harvested,
      sell: revenue > 0,
      finance: panel === 'finance',
    };
  }, [
    plotList,
    inventory.data,
    revenue,
    parcel,
    selectedSegmentId,
    selectedParcelId,
    plantParcelId,
    panel,
  ]);

  // Complete steps in order as soon as the real game state satisfies them.
  const active = ob.companyId === companyId && ob.storyDone && !ob.dismissed;
  useEffect(() => {
    if (active && step && done[step]) ob.complete(step);
  }, [active, step, done, ob]);

  const view = useMemo<StepView | null>(() => {
    if (!step) return null;
    const pid = parcel?.id;
    const segId = parcel?.segmentId;
    switch (step) {
      case 'find_land':
        return parcel && segId
          ? {
              title: 'Visit your land',
              say: `Your field is in ${segment?.name ?? 'the glowing area'}. Come, I will take you there.`,
              targets: [ACTION],
              action: { label: 'Take me there', run: () => ui().enterArea(segId) },
            }
          : {
              title: 'Find a field',
              say: 'Open Find land and lease a cheap holding for a season. Leasing costs far less than buying.',
              targets: ['[data-testid="nav-map"]'],
              free: true,
              action: { label: 'Find land', run: () => ui().openPanel('map') },
            };
      case 'open_plot':
        return {
          title: 'Open your holding',
          say: `See the orange fence? That is your field, holding ${pid ?? ''}. Tap it to see its soil, water, and which crops suit it best.`,
          targets: [
            `[data-testid="area-chip-${pid ?? ''}"]`,
            `[data-testid="holding-${pid ?? ''}"]`,
          ],
          action: pid
            ? { label: 'Open it', run: () => ui().selectParcel(pid, { focus: true }) }
            : undefined,
        };
      case 'plant':
        return {
          title: 'Sow your first crop',
          say: 'Press Plant and pick a crop with a high suitability score that can be sown this month. Fertiliser costs more but raises the yield.',
          targets: ['[data-testid="plant-confirm"]', '[data-testid="parcel-plant-button"]'],
          allow: ['[data-testid="plant-dialog"]', `[data-testid="area-chip-${pid ?? ''}"]`],
          action: pid ? { label: 'Choose a crop', run: () => ui().openPlant(pid) } : undefined,
        };
      case 'grow': {
        const failed =
          plotList.some((p) => p.status === 'failed') &&
          !plotList.some((p) => p.status === 'growing');
        if (failed) {
          return {
            title: 'A crop failed',
            say: 'Aiyo, the crop failed. It happens to every farmer. Clear the plot in My farms, watch water and pests, and sow again.',
            targets: ['[data-testid="clear-plot-button"]', '[data-testid="nav-farm"]'],
            allow: ['[data-testid="farm-panel"]', '[data-testid="parcel-inspector"]'],
            action: { label: 'Open my farms', run: () => ui().openPanel('farm') },
          };
        }
        // Dev builds: one click jumps straight to harvest, whatever the crop's duration.
        const readyDay = Math.max(
          0,
          ...plotList.filter((p) => p.status === 'growing').map((p) => p.readyDay ?? 0),
        );
        const skip = Math.min(400, Math.max(1, readyDay - (world.data?.gameDay ?? readyDay) + 1));
        return {
          title: 'Let it grow',
          say: devMode
            ? 'Crops take weeks of game time. Use fast-forward to jump to harvest day, and check My farms for water stress and pests.'
            : 'Crops keep growing even while you are away. Check My farms for water stress and pests, and come back when it is ready.',
          targets: devMode ? [ACTION] : ['[data-testid="nav-farm"]'],
          // Real-time growth takes days: let the player roam meanwhile.
          free: !devMode,
          action: devMode
            ? {
                label: `Skip to harvest (${skip} days)`,
                run: () => advance.mutate(skip),
                busy: advance.isPending,
              }
            : { label: 'Open my farms', run: () => ui().openPanel('farm') },
        };
      }
      case 'harvest':
        return {
          title: 'Harvest time!',
          say: 'Your crop is ready! Open My farms and press Harvest before it starts to spoil.',
          targets: ['[data-testid="harvest-button"]', '[data-testid="nav-farm"]'],
          allow: [
            '[data-testid="farm-panel"]',
            '[data-testid="parcel-inspector"]',
            `[data-testid="area-chip-${pid ?? ''}"]`,
          ],
          action: { label: 'Open my farms', run: () => ui().openPanel('farm') },
        };
      case 'sell':
        return {
          title: 'Sell at the mandi',
          say: 'Grain in storage earns nothing. Compare mandi prices — a farther market may pay more even after transport — then sell.',
          targets: ['[data-testid="sell-submit"]', '[data-testid="nav-market"]'],
          allow: ['[data-testid="market-panel"]'],
          action: {
            label: 'Go to market',
            run: () => (stock ? ui().openSell(stock.itemId) : ui().openPanel('market')),
          },
        };
      case 'finance':
        return {
          title: 'Count your money',
          say: 'Well sold! Open Money to see your profit, loans, and machinery. Next season, reinvest: more land, a pump set, better crops.',
          targets: ['[data-testid="nav-finance"]'],
          action: { label: 'Open Money', run: () => ui().openPanel('finance') },
        };
    }
  }, [step, parcel, segment, plotList, devMode, advance, stock, ui, world.data]);

  const xp = ob.completed.length * XP_PER_STEP;
  const finalText = `Shabash! You finished your first season with me and earned ${xp} XP. The land is yours, ${name} — make your grandfather proud.`;
  const current = beats[Math.min(beat, beats.length - 1)]!;
  const line =
    !ob.dismissed && ob.companyId === companyId
      ? inStory
        ? current.text
        : ob.storyDone
          ? (view?.say ?? finalText)
          : null
      : null;
  const lineKey = line === null ? null : inStory ? `story-${beat}` : `step-${step ?? 'done'}`;
  const talking = useVoice(lineKey, line ?? '', ob.muted);

  // Story and guided steps own the input; everything else is swallowed and nudges the card.
  const guiding = !ob.dismissed && ob.companyId === companyId;
  useGuideLock(
    guiding && inStory
      ? []
      : guiding && ob.storyDone && view && !view.free
        ? [...view.targets, ...(view.allow ?? [])]
        : null,
  );
  const [nudge, setNudge] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      setNudge(true);
      clearTimeout(t);
      t = setTimeout(() => setNudge(false), 520);
    };
    window.addEventListener(NUDGE_EVENT, on);
    return () => {
      window.removeEventListener(NUDGE_EVENT, on);
      clearTimeout(t);
    };
  }, []);

  // Camera follows the story.
  const focusId = inStory ? current.focusSegmentId : undefined;
  useEffect(() => {
    if (focusId) focusCamera(focusId);
  }, [focusId]);

  if (ob.companyId !== companyId || ob.dismissed) return null;

  const mute = (
    <button
      type="button"
      className="tour-icon-btn"
      onClick={() => ob.setMuted(!ob.muted)}
      aria-pressed={ob.muted}
      aria-label={ob.muted ? 'Unmute Thatha' : 'Mute Thatha'}
      title={ob.muted ? 'Unmute voice' : 'Mute voice'}
      data-testid="tour-mute"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
        {ob.muted ? (
          <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="2" />
        ) : (
          <path
            d="M16 8a5 5 0 0 1 0 8M18.5 5.5a8.5 8.5 0 0 1 0 13"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        )}
      </svg>
    </button>
  );

  if (inStory) {
    const last = beat >= beats.length - 1;
    return (
      <div
        className="tour-story"
        role="region"
        aria-label="Story"
        data-testid="tour-story"
        data-guide-allow
      >
        <div className="tour-bar top" />
        <div className="tour-bar bottom" />
        <div className="tour-story-cast">
          <Thatha talking={talking} size={150} />
          <div className={`tour-bubble bh-scroll${nudge ? ' nudge' : ''}`} aria-live="polite">
            <p key={beat}>{current.text}</p>
            <div className="bh-row" style={{ justifyContent: 'space-between' }}>
              <span className="tour-dots" aria-hidden="true">
                {beats.map((_, i) => (
                  <i key={i} className={i <= beat ? 'on' : ''} />
                ))}
              </span>
              <span className="bh-row" style={{ gap: 6 }}>
                {mute}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={ob.finishStory}
                  data-testid="tour-story-skip"
                >
                  Skip story
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  autoFocus
                  onClick={() => (last ? ob.finishStory() : setBeat(beat + 1))}
                  data-testid="tour-story-next"
                >
                  {last ? "Let's begin" : 'Next'}
                </Button>
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (!ob.storyDone) return null;

  const fresh = ob.completed.length > seenCount;
  return (
    <>
      {view ? <Spotlight selectors={view.targets} dim={!view.free && !view.allow?.length} /> : null}
      <aside
        className={`tour-card bh-scroll${nudge ? ' nudge' : ''}`}
        aria-label="Thatha's guide"
        data-testid="tour-card"
        data-guide-allow
      >
        <div className="tour-card-cast">
          <Thatha talking={talking} size={78} />
          {fresh ? (
            <div key={ob.completed.length} className="tour-reward" aria-live="polite">
              <span className="tour-xp">+{XP_PER_STEP} XP</span>
              {Array.from({ length: 18 }, (_, i) => (
                <i key={i} style={{ ['--i' as string]: i }} />
              ))}
            </div>
          ) : null}
        </div>
        <div className="tour-card-body">
          <div className="tour-card-head">
            <span>
              {step
                ? `Step ${TOUR_STEPS.indexOf(step) + 1} of ${TOUR_STEPS.length}`
                : 'Season complete'}{' '}
              · {xp} XP
            </span>
            {mute}
          </div>
          <h3>{view?.title ?? 'You did it!'}</h3>
          <p>{view?.say ?? finalText}</p>
          <ol className="tour-checks" aria-label="Tour progress">
            {TOUR_STEPS.map((s) => (
              <li
                key={s}
                className={ob.completed.includes(s) ? 'done' : s === step ? 'now' : ''}
                title={humanize(s)}
              >
                {ob.completed.includes(s) ? '✓' : ''}
              </li>
            ))}
          </ol>
          <div className="bh-row" style={{ gap: 6 }}>
            {view?.action ? (
              <Button
                variant="primary"
                size="sm"
                busy={view.action.busy}
                onClick={view.action.run}
                data-testid="tour-action"
              >
                {view.action.label}
              </Button>
            ) : null}
            {view ? (
              <Button variant="ghost" size="sm" onClick={ob.dismiss} data-testid="tour-skip">
                Skip tour
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={ob.dismiss} data-testid="tour-finish">
                Finish
              </Button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
