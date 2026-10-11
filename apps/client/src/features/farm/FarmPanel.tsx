import type { CropPlotDto, ParcelSummaryDto } from '@bh/contracts';
import { mulPaise, type MachineryType } from '@bh/domain';
import { useClearPlot, useHarvest, usePlotOperation } from '../../api/mutations';
import { useCrops, useMachinery, usePlots, useWorld } from '../../api/queries';
import { CROP_META } from '../../lib/cropMeta';
import { machineryEffects, safe } from '../../lib/economics';
import { formatFraction, formatKg, humanize, money, relativeDay } from '../../lib/format';
import { useIsStale } from '../../store/connection';
import { useUiStore } from '../../store/ui';
import { Chip, ProgressBar } from '../../ui/Bits';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Panel } from '../../ui/Panel';
import { EmptyState, QueryView } from '../../ui/States';

const unit = (v: number) => (v > 1.0001 ? v / 100 : v);

function riskTone(v: number): 'success' | 'warning' | 'danger' {
  const u = unit(v);
  return u < 0.3 ? 'success' : u < 0.6 ? 'warning' : 'danger';
}

function PlotCard({
  plot,
  areaHa,
  today,
}: {
  plot: CropPlotDto;
  areaHa: number | null;
  today: number;
}) {
  const crops = useCrops();
  const machinery = useMachinery();
  const op = usePlotOperation();
  const harvest = useHarvest();
  const clear = useClearPlot();
  const select = useUiStore((s) => s.selectParcel);
  const info = crops.data?.crops.find((c) => c.id === plot.cropId);
  const effects = machineryEffects(
    (machinery.data?.owned ?? []).map((m) => m.type as MachineryType),
  );
  const area = areaHa ?? 0;
  const cost = (perHa: number | undefined, mult = 1) =>
    perHa === undefined || !area
      ? null
      : safe(() => mulPaise(perHa, area * mult), Math.round(perHa * area * mult));
  const fertCost = cost(info?.costs.fertilizerPaisePerHa);
  const pestCost = cost(info?.costs.pestControlPaisePerHa);
  const harvestCost = cost(info?.costs.harvestLaborPaisePerHa, effects.harvestLaborMultiplier);
  const irrigationDaily =
    plot.dailyIrrigationCostPaise ||
    cost(info?.costs.irrigationPaisePerHaPerDay, effects.irrigationCostMultiplier);
  const protectedLeft =
    plot.pestProtectedUntilDay != null ? plot.pestProtectedUntilDay - today : null;
  const deadlineLeft = plot.harvestDeadlineDay != null ? plot.harvestDeadlineDay - today : null;
  const busy = op.isPending || harvest.isPending || clear.isPending;
  const meta = CROP_META[plot.cropId];

  return (
    <article
      className="bh-card bh-plot-card"
      data-testid={`plot-row-${plot.id}`}
      data-plot-status={plot.status}
    >
      <div className="bh-row between">
        <button
          type="button"
          className="bh-row"
          style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}
          onClick={() => select(plot.parcelId, { focus: true })}
          title="Show on map"
        >
          <span className="bh-crop-swatch" style={{ background: meta.swatch }} aria-hidden="true" />
          <span>
            <strong>{info?.name ?? meta.label}</strong>{' '}
            <span className="faint">· {plot.parcelId}</span>
          </span>
        </button>
        <Chip
          tone={plot.status === 'ready' ? 'success' : plot.status === 'failed' ? 'danger' : 'info'}
        >
          {plot.status === 'growing' ? humanize(plot.stage) : humanize(plot.status)}
        </Chip>
      </div>
      <ProgressBar
        value={plot.progress}
        label="Growth"
        tone={plot.status === 'ready' ? 'success' : plot.status === 'failed' ? 'danger' : undefined}
      />
      <div className="bh-grid-3" style={{ fontSize: 12 }}>
        <span title="Plant health">
          <Icon name="leaf" size={13} /> Health{' '}
          <strong className={`tone-${riskTone(1 - unit(plot.health))}`}>
            {formatFraction(unit(plot.health))}
          </strong>
        </span>
        <span title="Water stress (higher is worse)">
          <Icon name="droplet" size={13} /> Stress{' '}
          <strong className={`tone-${riskTone(plot.waterStress)}`}>
            {formatFraction(unit(plot.waterStress))}
          </strong>
        </span>
        <span title="Pest pressure (higher is worse)">
          <Icon name="bug" size={13} /> Pests{' '}
          <strong className={`tone-${riskTone(plot.pestPressure)}`}>
            {formatFraction(unit(plot.pestPressure))}
          </strong>
        </span>
      </div>
      <div className="bh-row between muted" style={{ fontSize: 12 }}>
        <span>
          Expected {formatKg(plot.expectedHarvestKg)} · quality {Math.round(plot.expectedQuality)}
        </span>
        {plot.status === 'growing' && plot.readyDay != null ? (
          <span>Ready {relativeDay(plot.readyDay, today)}</span>
        ) : null}
        {plot.status === 'ready' && deadlineLeft != null ? (
          <span
            className={
              deadlineLeft <= 3
                ? 'tone-danger'
                : deadlineLeft <= 7
                  ? 'tone-warning'
                  : 'tone-success'
            }
          >
            {deadlineLeft >= 0
              ? `Harvest within ${deadlineLeft} day${deadlineLeft === 1 ? '' : 's'}`
              : `Overripe — losing yield`}
          </span>
        ) : null}
      </div>
      {plot.status === 'growing' ? (
        <div className="bh-row wrap" style={{ gap: 6 }}>
          <Button
            size="sm"
            icon="droplet"
            disabled={busy}
            onClick={() =>
              op.mutate({
                plotId: plot.id,
                parcelId: plot.parcelId,
                body: { op: plot.irrigated ? 'irrigation_off' : 'irrigation_on' },
              })
            }
            title={
              plot.irrigated
                ? 'Stop irrigating to save the daily cost'
                : 'Requires water access or a pump set'
            }
            data-testid="irrigation-toggle"
          >
            {plot.irrigated
              ? 'Stop irrigation'
              : `Irrigate ${irrigationDaily ? `(${money(irrigationDaily)}/day)` : ''}`}
          </Button>
          {!plot.fertilized ? (
            <Button
              size="sm"
              icon="leaf"
              disabled={busy}
              onClick={() =>
                op.mutate({ plotId: plot.id, parcelId: plot.parcelId, body: { op: 'fertilize' } })
              }
              data-testid="fertilize-button"
            >
              Fertilise {fertCost != null ? `(${money(fertCost)})` : ''}
            </Button>
          ) : (
            <Chip tone="success">Fertilised</Chip>
          )}
          {protectedLeft != null && protectedLeft > 0 ? (
            <Chip tone="success" title="Pest control protection remaining">
              Protected {protectedLeft}d
            </Chip>
          ) : (
            <Button
              size="sm"
              icon="bug"
              disabled={busy}
              onClick={() =>
                op.mutate({
                  plotId: plot.id,
                  parcelId: plot.parcelId,
                  body: { op: 'pest_control' },
                })
              }
              data-testid="pest-control-button"
            >
              Pest control {pestCost != null ? `(${money(pestCost)})` : ''}
            </Button>
          )}
        </div>
      ) : null}
      {plot.status === 'ready' ? (
        <Button
          variant="primary"
          icon="tractor"
          busy={harvest.isPending}
          onClick={() => harvest.mutate({ plotId: plot.id, parcelId: plot.parcelId })}
          data-testid="harvest-button"
          data-plot-id={plot.id}
        >
          Harvest {harvestCost != null ? `· labour ${money(harvestCost)}` : ''}
        </Button>
      ) : null}
      {plot.status === 'failed' ? (
        <Button
          variant="danger"
          busy={clear.isPending}
          onClick={() => clear.mutate({ plotId: plot.id, parcelId: plot.parcelId })}
          data-testid="clear-plot-button"
        >
          Clear failed crop
        </Button>
      ) : null}
    </article>
  );
}

export function FarmPanel({ areaById }: { areaById: Map<string, ParcelSummaryDto> }) {
  const close = useUiStore((s) => s.closePanel);
  const openPanel = useUiStore((s) => s.openPanel);
  const plots = usePlots();
  const world = useWorld();
  const stale = useIsStale();
  const today = world.data?.gameDay ?? 0;
  return (
    <Panel
      title="Farm"
      subtitle={stale ? 'Showing last known state' : 'Live crop status and field operations'}
      onClose={close}
      testId="farm-panel"
    >
      <QueryView query={plots}>
        {(data) => {
          const live = data.plots
            .filter((p) => p.status === 'growing' || p.status === 'ready' || p.status === 'failed')
            .sort(
              (a, b) =>
                (a.status === 'ready' ? -1 : 0) - (b.status === 'ready' ? -1 : 0) ||
                (a.readyDay ?? 0) - (b.readyDay ?? 0),
            );
          if (live.length === 0) {
            return (
              <EmptyState icon="farm" title="No crops in the ground">
                Select a parcel you own or lease and choose <strong>Plant crop</strong>.{' '}
                <Button size="sm" onClick={() => openPanel('map')}>
                  Open map
                </Button>
              </EmptyState>
            );
          }
          return (
            <div className="bh-stack">
              {live.map((p) => (
                <PlotCard
                  key={p.id}
                  plot={p}
                  areaHa={areaById.get(p.parcelId)?.areaHa ?? null}
                  today={today}
                />
              ))}
            </div>
          );
        }}
      </QueryView>
    </Panel>
  );
}
