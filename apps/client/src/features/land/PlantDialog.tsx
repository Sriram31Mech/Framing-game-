import type { CropInfoDto, SuitabilityDto } from '@bh/contracts';
import type { CropId, MachineryType } from '@bh/domain';
import { useMemo, useState } from 'react';
import { describeError } from '../../api/errors';
import { usePlant } from '../../api/mutations';
import {
  useCrops,
  useMachinery,
  useMarkets,
  useMe,
  useOverview,
  useParcel,
  useSuitability,
  useWorld,
} from '../../api/queries';
import { machineryEffects, plantingQuote } from '../../lib/economics';
import {
  formatDays,
  formatHa,
  formatKg,
  money,
  moneyCompact,
  monthName,
  perKg,
} from '../../lib/format';
import { useUiStore } from '../../store/ui';
import { GradeChip, SectionTitle } from '../../ui/Bits';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { ErrorState, SkeletonRows } from '../../ui/States';
import { CROP_META as CROP_LOOK } from '../../lib/cropMeta';

function CropOption({
  s,
  info,
  selected,
  onSelect,
  blockedReason,
}: {
  s: SuitabilityDto;
  info: CropInfoDto | undefined;
  selected: boolean;
  onSelect: () => void;
  blockedReason: string | null;
}) {
  const disabled = !s.sowingOpen || !!blockedReason;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className="bh-crop-option"
      disabled={disabled}
      onClick={onSelect}
      data-testid={`plant-crop-${s.cropId}`}
      title={
        blockedReason ??
        (disabled
          ? `Sowing window closed — opens in ${monthName(s.nextSowingMonth, true)}`
          : undefined)
      }
    >
      <span
        className="bh-crop-swatch"
        style={{ background: CROP_LOOK[s.cropId].swatch }}
        aria-hidden="true"
      />
      <span style={{ minWidth: 0 }}>
        <span style={{ fontWeight: 650 }}>{info?.name ?? CROP_LOOK[s.cropId].label}</span>
        {info?.localName ? <span className="faint"> · {info.localName}</span> : null}
        <span className="faint" style={{ display: 'block', fontSize: 12 }}>
          {blockedReason
            ? blockedReason
            : disabled
              ? `Opens in ${monthName(s.nextSowingMonth, true)}`
              : `${formatKg(s.yieldKgPerHa.expected)}/ha expected · ${info ? formatDays(info.durationDays) : ''} · ${info?.waterNeed ?? ''} water`}
        </span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
        <GradeChip grade={s.grade} />
        <span className="num faint" style={{ fontSize: 11 }}>
          score {Math.round(s.score)}
        </span>
      </span>
    </button>
  );
}

export function PlantDialog({ parcelId }: { parcelId: string }) {
  const close = useUiStore((s) => s.closePlant);
  const parcelQ = useParcel(parcelId);
  const suitQ = useSuitability(parcelId);
  const crops = useCrops();
  const machinery = useMachinery();
  const markets = useMarkets();
  const overview = useOverview();
  const me = useMe();
  const plant = usePlant();
  const world = useWorld();
  const today = world.data?.gameDay ?? 0;
  const leaseEnd = parcelQ.data?.parcel.lease?.endDay ?? null;
  const blockedFor = (id: CropId): string | null => {
    const dur = crops.data?.crops.find((c) => c.id === id)?.durationDays;
    if (leaseEnd == null || dur == null) return null;
    return today + dur > leaseEnd
      ? `Would not mature before the lease ends (day ${leaseEnd})`
      : null;
  };

  const sorted = useMemo(
    () =>
      [...(suitQ.data?.results ?? [])].sort(
        (a, b) => Number(b.sowingOpen) - Number(a.sowingOpen) || b.score - a.score,
      ),
    [suitQ.data],
  );
  const [picked, setPicked] = useState<CropId | null>(null);
  const cropId =
    picked ?? sorted.find((s) => s.sowingOpen && !blockedFor(s.cropId))?.cropId ?? null;
  const irrigationAvailable = suitQ.data?.irrigationAvailable ?? false;
  const [irrigate, setIrrigate] = useState(true);
  const [fertilize, setFertilize] = useState(true);
  const irrigateOn = irrigate && irrigationAvailable;

  const parcel = parcelQ.data?.parcel;
  const areaHa = parcel?.areaHa ?? 0;
  const info = crops.data?.crops.find((c) => c.id === cropId);
  const suit = sorted.find((s) => s.cropId === cropId);
  const effects = machineryEffects(
    (machinery.data?.owned ?? []).map((m) => m.type as MachineryType),
  );
  const quote = info
    ? plantingQuote(info, areaHa, { fertilize, irrigate: irrigateOn, effects })
    : null;
  const cash = overview.data?.company.cashPaise ?? me.data?.company?.cashPaise ?? 0;

  const market =
    markets.data?.markets.find((m) => m.id === parcel?.nearestMarketId) ?? markets.data?.markets[0];
  const price =
    market?.prices.find((p) => p.itemId === cropId)?.pricePaisePerKg ??
    info?.basePricePaisePerKg ??
    0;
  const yieldLow = suit ? suit.yieldKgPerHa.low * areaHa : 0;
  const yieldExp = suit ? suit.yieldKgPerHa.expected * areaHa : 0;
  const yieldHigh = suit ? suit.yieldKgPerHa.high * areaHa : 0;
  const duration = info?.durationDays ?? 0;
  const irrigationTotal = quote ? quote.dailyIrrigationPaise * duration : 0;
  const cycleCost = quote ? quote.totalPaise + irrigationTotal + quote.harvestLaborPaise : 0;
  const revenueExp = Math.round(yieldExp * price);
  const err = plant.isError ? describeError(plant.error) : null;
  const loading = parcelQ.isPending || suitQ.isPending || crops.isPending;
  const failed = parcelQ.isError
    ? parcelQ.error
    : suitQ.isError
      ? suitQ.error
      : crops.isError
        ? crops.error
        : null;

  const submit = () => {
    if (!cropId || !quote) return;
    plant.mutate(
      { parcelId, cropId, irrigate: irrigateOn, fertilize, expectedCostPaise: quote.totalPaise },
      { onSuccess: close },
    );
  };

  return (
    <Dialog
      title={`Plant on ${parcelId}${parcel ? ` · ${formatHa(areaHa)}` : ''}`}
      onClose={close}
      wide
      testId="plant-dialog"
      dismissible={!plant.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={plant.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="farm"
            onClick={submit}
            busy={plant.isPending}
            disabled={!cropId || !quote || quote.totalPaise > cash}
            data-testid="plant-confirm"
          >
            {quote && info ? `Sow ${info.name} · ${moneyCompact(quote.totalPaise)}` : 'Sow'}
          </Button>
        </>
      }
    >
      {failed ? <ErrorState error={failed} /> : null}
      {loading && !failed ? <SkeletonRows rows={6} height={40} /> : null}
      {!loading && !failed ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)',
            gap: 20,
          }}
        >
          <div className="bh-stack" role="radiogroup" aria-label="Crop" style={{ gap: 6 }}>
            <SectionTitle>Crop (best suited first)</SectionTitle>
            {sorted.map((s) => (
              <CropOption
                key={s.cropId}
                s={s}
                info={crops.data?.crops.find((c) => c.id === s.cropId)}
                selected={s.cropId === cropId}
                onSelect={() => setPicked(s.cropId)}
                blockedReason={blockedFor(s.cropId)}
              />
            ))}
            {sorted.every((s) => !s.sowingOpen) ? (
              <div className="bh-callout warning">
                No crop can be sown this month. Sowing windows follow the Kharif / Rabi / Zaid
                calendar.
              </div>
            ) : null}
          </div>
          <div className="bh-stack">
            <SectionTitle>Inputs</SectionTitle>
            <label
              className={`bh-toggle${irrigationAvailable ? '' : ' disabled'}`}
              title={
                irrigationAvailable
                  ? undefined
                  : 'No water source — buy a pump set to irrigate dry land'
              }
            >
              <input
                type="checkbox"
                checked={irrigateOn}
                disabled={!irrigationAvailable}
                onChange={(e) => setIrrigate(e.target.checked)}
                data-testid="plant-irrigate"
              />
              <span className="grow">
                <Icon name="droplet" size={14} /> Irrigate
                <span className="faint" style={{ display: 'block', fontSize: 12 }}>
                  {irrigationAvailable
                    ? `${quote ? money(quote.dailyIrrigationPaise || mulDaily(info, areaHa, effects.irrigationCostMultiplier)) : '—'} per day while growing; protects against dry spells`
                    : 'Not available: no water access on this parcel'}
                </span>
              </span>
            </label>
            <label className="bh-toggle">
              <input
                type="checkbox"
                checked={fertilize}
                onChange={(e) => setFertilize(e.target.checked)}
                data-testid="plant-fertilize"
              />
              <span className="grow">
                <Icon name="leaf" size={14} /> Fertilise at sowing
                <span className="faint" style={{ display: 'block', fontSize: 12 }}>
                  Lifts yield on low-fertility soil
                </span>
              </span>
            </label>
            {quote && info ? (
              <>
                <SectionTitle>Cost to sow now</SectionTitle>
                <dl className="bh-kv">
                  <dt>Seed</dt>
                  <dd>{money(quote.seedPaise)}</dd>
                  <dt>
                    Sowing labour{effects.sowingLaborMultiplier < 1 ? ' (tractor discount)' : ''}
                  </dt>
                  <dd>{money(quote.sowingLaborPaise)}</dd>
                  {fertilize ? (
                    <>
                      <dt>Fertiliser</dt>
                      <dd>{money(quote.fertilizerPaise)}</dd>
                    </>
                  ) : null}
                  <dt className="total">Charged now</dt>
                  <dd className="total" data-testid="plant-cost">
                    {money(quote.totalPaise)}
                  </dd>
                </dl>
                <SectionTitle>Whole season estimate</SectionTitle>
                <dl className="bh-kv">
                  <dt>Irrigation ({formatDays(duration)})</dt>
                  <dd>{irrigateOn ? money(irrigationTotal) : '—'}</dd>
                  <dt>Harvest labour</dt>
                  <dd>{money(quote.harvestLaborPaise)}</dd>
                  <dt>Pest control (per spray, if needed)</dt>
                  <dd className="muted">{money(quote.pestControlPaise)}</dd>
                  <dt>Yield (low · expected · high)</dt>
                  <dd>
                    {formatKg(yieldLow)} · <strong>{formatKg(yieldExp)}</strong> ·{' '}
                    {formatKg(yieldHigh)}
                  </dd>
                  <dt>
                    At today&apos;s {market?.name ?? 'mandi'} price ({perKg(price)})
                  </dt>
                  <dd>
                    {moneyCompact(Math.round(yieldLow * price))} –{' '}
                    {moneyCompact(Math.round(yieldHigh * price))}
                  </dd>
                  <dt className="total">Expected margin</dt>
                  <dd
                    className={`total ${revenueExp - cycleCost >= 0 ? 'tone-success' : 'tone-danger'}`}
                  >
                    {money(revenueExp - cycleCost)}
                  </dd>
                </dl>
                {suit && suit.grade !== 'excellent' && suit.grade !== 'good' ? (
                  <div className="bh-callout warning">
                    {suit.grade === 'unsuitable'
                      ? 'This crop is unsuitable here — expect a failed or very poor harvest.'
                      : 'Marginal suitability: yields will likely land near the low end.'}
                    {suit.limitingFactor ? ` Limiting factor: ${suit.limitingFactor}.` : ''}
                  </div>
                ) : null}
                {quote.totalPaise > cash ? (
                  <div className="bh-callout danger">
                    Not enough cash ({money(cash)}) to cover sowing.
                  </div>
                ) : null}
                <div className="faint" style={{ fontSize: 11.5 }}>
                  Prices move daily; harvest within {info.harvestWindowDays} days of maturity to
                  avoid losses. Produce keeps about {formatDays(info.shelfLifeDays)}.
                </div>
              </>
            ) : null}
            {err ? (
              <div className="bh-callout danger" role="alert">
                <strong>{err.title}.</strong> {err.message}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function mulDaily(info: CropInfoDto | undefined, areaHa: number, mult: number): number {
  if (!info) return 0;
  return Math.round(info.costs.irrigationPaisePerHaPerDay * areaHa * mult);
}
