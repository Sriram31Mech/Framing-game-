/**
 * A real map segment (assembly-constituency area): district climate and soils, the crops that
 * do best here, and the farm holdings in it as simple cards. Choosing a holding opens the
 * land inspector (buy / lease / plant).
 */
import type { SegmentDetailResponse } from '@bh/contracts';
import { computeAllSuitability, districtClimate, type ParcelEnvironment } from '@bh/domain';
import { useMemo } from 'react';
import { useCompanyId, useSegment } from '../../api/queries';
import { CROP_META } from '../../lib/cropMeta';
import { formatHa, humanize, monthName, moneyCompact } from '../../lib/format';
import { useUiStore } from '../../store/ui';
import { Chip, GradeChip } from '../../ui/Bits';
import { Button } from '../../ui/Button';
import { Panel } from '../../ui/Panel';
import { EmptyState, QueryView } from '../../ui/States';

type Holding = SegmentDetailResponse['holdings'][number];

const WATER_LABEL: Record<string, string> = {
  river: 'River water',
  canal: 'Canal / tank',
  well: 'Borewell',
  none: 'Rain-fed only',
};

function RainBars({ rain, temp }: { rain: number[]; temp: number[] }) {
  const max = Math.max(...rain, 1);
  return (
    <figure className="tn-rain" aria-label="Monthly rainfall and temperature">
      <div className="tn-rain-bars">
        {rain.map((mm, i) => (
          <div
            key={i}
            className="tn-rain-col"
            title={`${monthName(i + 1)}: ${Math.round(mm)} mm, ${temp[i]?.toFixed(1)} °C`}
          >
            <div className="tn-rain-bar" style={{ height: `${Math.max(4, (mm / max) * 100)}%` }} />
            <span>{monthName(i + 1).slice(0, 1)}</span>
          </div>
        ))}
      </div>
      <figcaption className="muted">
        Rain {Math.round(rain.reduce((a, b) => a + b, 0))} mm/yr · {Math.min(...temp).toFixed(0)}–
        {Math.max(...temp).toFixed(0)} °C
      </figcaption>
    </figure>
  );
}

function bestCrop(env: ParcelEnvironment) {
  const climate = districtClimate(env.districtId ?? 'thanjavur');
  return computeAllSuitability(env, climate)[0];
}

function HoldingCard({ h, myCompanyId }: { h: Holding; myCompanyId: string | null }) {
  const selectParcel = useUiStore((s) => s.selectParcel);
  const env: ParcelEnvironment = {
    areaHa: h.areaHa,
    elevationM: h.elevationM,
    slopePct: 1,
    soilTexture: h.soilTexture as ParcelEnvironment['soilTexture'],
    soilPh: 7,
    fertility: 0.5,
    drainage: 'moderate',
    waterAccess: h.waterAccess as ParcelEnvironment['waterAccess'],
    roadDistanceKm: 1,
    districtId: h.districtId ?? undefined,
  };
  const best = bestCrop(env);
  const mine = h.operatorCompanyId !== null && h.operatorCompanyId === myCompanyId;
  const status = mine
    ? { label: 'Yours', tone: 'accent' as const }
    : h.status === 'for_sale'
      ? { label: 'For sale', tone: 'success' as const }
      : h.status === 'reserved'
        ? { label: 'Starter plot', tone: 'neutral' as const }
        : { label: h.ownerName ? `Owned · ${h.ownerName}` : 'Leased', tone: 'neutral' as const };
  return (
    <li className="tn-holding">
      <div className="tn-holding-main">
        <div className="bh-row" style={{ justifyContent: 'space-between' }}>
          <strong>{formatHa(h.areaHa)}</strong>
          <Chip tone={status.tone}>{status.label}</Chip>
        </div>
        <div className="tn-holding-tags">
          <span>{humanize(h.soilTexture)} soil</span>
          <span>{WATER_LABEL[h.waterAccess] ?? humanize(h.waterAccess)}</span>
          {h.crop ? <span>Growing {CROP_META[h.crop.cropId].label}</span> : null}
        </div>
        {best ? (
          <div className="tn-holding-best">
            Best: <span style={{ color: CROP_META[best.cropId].swatch }}>●</span>{' '}
            {CROP_META[best.cropId].label} <GradeChip grade={best.grade} />
          </div>
        ) : null}
      </div>
      <div className="tn-holding-side">
        {h.status === 'for_sale' && h.listPricePaise !== null ? (
          <>
            <div className="tn-price">{moneyCompact(h.listPricePaise)}</div>
            <div className="muted tn-sub">
              or lease {moneyCompact(h.leaseRentPaisePerSeason)}/season
            </div>
          </>
        ) : (
          <div className="muted tn-sub">Value {moneyCompact(h.basePricePaise)}</div>
        )}
        <Button
          size="sm"
          variant={h.status === 'for_sale' || mine ? 'primary' : 'ghost'}
          onClick={() => selectParcel(h.id, { focus: false })}
          data-testid={`holding-${h.id}`}
        >
          {mine ? 'Manage' : h.status === 'for_sale' ? 'View & buy' : 'View'}
        </Button>
      </div>
    </li>
  );
}

export function SegmentPanel({ segmentId }: { segmentId: string }) {
  const q = useSegment(segmentId);
  const myCompanyId = useCompanyId();
  const close = useUiStore((s) => s.closePanel);
  const inArea = useUiStore((s) => s.areaSegmentId === segmentId);
  const title = q.data?.segment.name ?? 'Loading area…';
  const sorted = useMemo(() => {
    const rank = (h: Holding) =>
      h.operatorCompanyId && h.operatorCompanyId === myCompanyId
        ? 0
        : h.status === 'for_sale'
          ? 1
          : 2;
    return [...(q.data?.holdings ?? [])].sort(
      (a, b) => rank(a) - rank(b) || (a.listPricePaise ?? 0) - (b.listPricePaise ?? 0),
    );
  }, [q.data, myCompanyId]);

  return (
    <Panel
      title={title}
      subtitle={
        q.data ? (
          <>
            {q.data.district.name} <span lang="ta">({q.data.district.tamilName})</span> ·{' '}
            {q.data.district.zoneLabel}
          </>
        ) : null
      }
      onClose={close}
      testId="segment-panel"
    >
      <QueryView query={q}>
        {(d) => (
          <div className="bh-stack">
            <div className="tn-facts">
              <div>
                <span className="muted">For sale</span>
                <strong>{d.segment.holdingsForSale}</strong>
              </div>
              <div>
                <span className="muted">From</span>
                <strong>
                  {d.segment.minPricePaise ? moneyCompact(d.segment.minPricePaise) : '—'}
                </strong>
              </div>
              <div>
                <span className="muted">Farmland</span>
                <strong>{formatHa(d.segment.farmlandHa)}</strong>
              </div>
            </div>
            {inArea ? null : (
              <Button
                variant="primary"
                icon="farm"
                block
                onClick={() => useUiStore.getState().enterArea(segmentId)}
                data-testid="enter-area"
              >
                Walk the fields in 3D
              </Button>
            )}
            <RainBars rain={d.district.monthlyRainMm} temp={d.district.monthlyMeanTempC} />
            <div className="tn-holding-tags">
              {Object.keys(d.district.soils).map((s) => (
                <span key={s}>{humanize(s)}</span>
              ))}
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Known for {d.district.knownFor.join(', ')}.
            </p>
            <h3 className="tn-h3">Farm holdings</h3>
            {sorted.length === 0 ? (
              <EmptyState title="No farmland here">
                This is an urban area. Try a neighbouring segment.
              </EmptyState>
            ) : (
              <ul className="tn-holdings">
                {sorted.map((h) => (
                  <HoldingCard key={h.id} h={h} myCompanyId={myCompanyId} />
                ))}
              </ul>
            )}
          </div>
        )}
      </QueryView>
    </Panel>
  );
}
