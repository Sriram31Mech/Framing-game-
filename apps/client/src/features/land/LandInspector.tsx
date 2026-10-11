import type { SuitabilityDto } from '@bh/contracts';
import { LAND_SELL_TO_STATE_FRACTION, mulPaise, SEASON_LENGTH_DAYS } from '@bh/domain';
import { useState } from 'react';
import { describeError } from '../../api/errors';
import {
  useDelistParcel,
  useLeaseParcel,
  useListParcel,
  usePurchaseParcel,
  useSellParcelToState,
} from '../../api/mutations';
import {
  useCompanyId,
  useCrops,
  useMachinery,
  useMe,
  useOverview,
  useParcel,
  usePlots,
  useSuitability,
  useWorld,
} from '../../api/queries';
import { monthlyObligationsPaise, parseRupees, safe } from '../../lib/economics';
import {
  formatDays,
  formatFraction,
  formatHa,
  formatKg,
  humanize,
  money,
  moneyCompact,
  relativeDay,
} from '../../lib/format';
import { useUiStore } from '../../store/ui';
import { Chip, GradeChip, ProgressBar, SectionTitle, Stat } from '../../ui/Bits';
import { Button } from '../../ui/Button';
import { ConfirmDialog, type CostLine } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { Panel } from '../../ui/Panel';
import { EmptyState, ErrorState, SkeletonRows } from '../../ui/States';
import { CROP_META as CROP_LOOK } from '../../lib/cropMeta';
import {
  cropLocalName,
  cropName,
  gradeTone,
  sowingWindowText,
  statusLabel,
  type ParcelDetail,
} from './landHelpers';

type DialogKind = 'buy' | 'lease' | 'sell-state' | 'list' | null;

function SuitabilityRow({
  s,
  areaHa,
  crops,
  expanded,
  onToggle,
}: {
  s: SuitabilityDto;
  areaHa: number;
  crops: Parameters<typeof cropName>[1];
  expanded: boolean;
  onToggle: () => void;
}) {
  const local = cropLocalName(s.cropId, crops);
  const limiting = s.limitingFactor;
  return (
    <div className="bh-card" style={{ padding: '8px 12px' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'grid',
          gridTemplateColumns: '14px 1fr auto',
          gap: 10,
          alignItems: 'center',
          width: '100%',
        }}
        data-testid={`suitability-${s.cropId}`}
      >
        <span
          className="bh-crop-swatch"
          style={{ background: CROP_LOOK[s.cropId].swatch, width: 12, height: 12 }}
          aria-hidden="true"
        />
        <span style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 620 }}>{cropName(s.cropId, crops)}</span>
          {local ? (
            <span className="faint" style={{ fontSize: 12 }}>
              {' '}
              · {local}
            </span>
          ) : null}
          <span
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 34px',
              gap: 8,
              alignItems: 'center',
              marginTop: 4,
            }}
          >
            <ProgressBar
              value={s.score / 100}
              tone={gradeTone(s.score / 100)}
              label={`${cropName(s.cropId, crops)} suitability`}
            />
            <span className="num" style={{ fontSize: 12 }}>
              {Math.round(s.score)}
            </span>
          </span>
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
          <GradeChip grade={s.grade} />
          <span className={s.sowingOpen ? 'tone-success' : 'faint'} style={{ fontSize: 11 }}>
            {sowingWindowText(s)}
          </span>
        </span>
      </button>
      {expanded ? (
        <div style={{ marginTop: 8 }}>
          <div className="bh-grid-3" style={{ marginBottom: 8 }}>
            <Stat
              label="Low"
              value={formatKg(s.yieldKgPerHa.low * areaHa)}
              sub={`${formatKg(s.yieldKgPerHa.low)}/ha`}
            />
            <Stat
              label="Expected"
              value={formatKg(s.yieldKgPerHa.expected * areaHa)}
              sub={`${formatKg(s.yieldKgPerHa.expected)}/ha`}
            />
            <Stat
              label="High"
              value={formatKg(s.yieldKgPerHa.high * areaHa)}
              sub={`${formatKg(s.yieldKgPerHa.high)}/ha`}
            />
          </div>
          <div className="faint" style={{ fontSize: 11.5, marginBottom: 4 }}>
            Yield range for this parcel
            {s.irrigationAssumed ? ', assuming irrigation' : ', rain-fed'}. Weather, pests and
            management decide the actual harvest.
          </div>
          {[...s.factors]
            .sort((a, b) => a.score - b.score)
            .map((f) => (
              <div key={f.key} className="bh-factor">
                <div className="head">
                  <span>
                    {f.label}
                    {limiting === f.key ? (
                      <Chip tone="danger" title="The weakest factor limits the overall score">
                        limiting
                      </Chip>
                    ) : null}
                  </span>
                  <ProgressBar
                    value={f.score}
                    tone={gradeTone(f.score)}
                    label={`${f.label} score`}
                  />
                  <span
                    className="num faint"
                    style={{ fontSize: 11 }}
                    title="Weight in the overall score"
                  >
                    {formatFraction(f.weight)}
                  </span>
                </div>
                <p className="detail">{f.detail}</p>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}

function EnvGrid({ parcel }: { parcel: ParcelDetail }) {
  const e = parcel.env;
  const rows: [string, string][] = [
    ['Area', formatHa(e.areaHa)],
    ['Elevation', `${Math.round(e.elevationM)} m`],
    ['Slope', `${e.slopePct.toFixed(1)}%`],
    ['Soil', humanize(e.soilTexture)],
    ['Soil pH', e.soilPh.toFixed(1)],
    ['Fertility', formatFraction(e.fertility > 1 ? e.fertility / 100 : e.fertility)],
    ['Drainage', humanize(e.drainage)],
    ['Water access', humanize(e.waterAccess)],
    ['To road', `${e.roadDistanceKm.toFixed(2)} km`],
    ['To mandi', `${parcel.marketDistanceKm.toFixed(1)} km`],
  ];
  return (
    <dl className="bh-kv" style={{ gridTemplateColumns: '1fr auto 1fr auto' }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LandInspector({ parcelId }: { parcelId: string }) {
  const close = useUiStore((s) => s.closePanel);
  const openPlant = useUiStore((s) => s.openPlant);
  const openPanel = useUiStore((s) => s.openPanel);
  const requestFocus = useUiStore((s) => s.requestFocus);
  const companyId = useCompanyId();
  const parcelQ = useParcel(parcelId);
  const suitQ = useSuitability(parcelId);
  const crops = useCrops();
  const me = useMe();
  const overview = useOverview();
  const plots = usePlots();
  const machinery = useMachinery();
  const world = useWorld();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [seasons, setSeasons] = useState(1);
  const [listPrice, setListPrice] = useState('');

  const purchase = usePurchaseParcel();
  const lease = useLeaseParcel();
  const list = useListParcel();
  const delist = useDelistParcel();
  const sellState = useSellParcelToState();

  const detail = parcelQ.data;
  const parcel = detail?.parcel;
  const cash = overview.data?.company.cashPaise ?? me.data?.company?.cashPaise ?? 0;
  const monthly = monthlyObligationsPaise(overview.data, plots.data?.plots, machinery.data);
  const today = world.data?.gameDay ?? 0;
  const isMine =
    !!parcel &&
    !!companyId &&
    (parcel.ownerCompanyId === companyId || parcel.operatorCompanyId === companyId);

  const closeDialog = () => {
    setDialog(null);
    purchase.reset();
    lease.reset();
    list.reset();
    sellState.reset();
  };

  const reasons = detail?.actions.reasons ?? {};
  const reasonFor = (...keys: string[]) => keys.map((k) => reasons[k]).find(Boolean);

  const affordWarnings = (costPaise: number, extraMonthly: number): string[] => {
    const after = cash - costPaise;
    const burn = monthly + extraMonthly;
    const w: string[] = [];
    if (after < 0) w.push(`You are ${money(-after)} short. The server will reject this purchase.`);
    else if (burn > 0 && after < burn * 3) {
      w.push(
        `After this you would hold ${moneyCompact(after)} — less than 3 months of your estimated obligations (${moneyCompact(burn)}/month). One poor harvest could push the company into distress.`,
      );
    }
    return w;
  };

  const errorFor = (m: { isError: boolean; error: unknown }) =>
    m.isError ? describeError(m.error) : null;

  let dialogNode = null;
  if (parcel && dialog === 'buy' && parcel.listPricePaise != null) {
    const price = parcel.listPricePaise;
    const lines: CostLine[] = [
      { label: 'Purchase price', value: money(price) },
      {
        label: 'Land tax (per 30-day month)',
        value: money(parcel.monthlyLandTaxPaise),
        tone: 'muted',
      },
      { label: 'Cash now', value: money(cash), tone: 'muted' },
      {
        label: 'Cash after purchase',
        value: money(cash - price),
        total: true,
        tone: cash - price < 0 ? 'danger' : undefined,
      },
    ];
    if (monthly > 0)
      lines.splice(2, 0, {
        label: 'Your current monthly obligations',
        value: money(monthly),
        tone: 'muted',
      });
    dialogNode = (
      <ConfirmDialog
        title={`Buy parcel ${parcel.id}?`}
        description={
          <>
            {formatHa(parcel.areaHa)} of {humanize(parcel.env.soilTexture)} soil
            {parcel.ownerName ? ` from ${parcel.ownerName}` : ' from the state'}. Land tax is
            charged on the 1st of every month; land can be resold or sold back to the state for{' '}
            {formatFraction(LAND_SELL_TO_STATE_FRACTION)} of its base value.
          </>
        }
        lines={lines}
        warnings={affordWarnings(price, parcel.monthlyLandTaxPaise)}
        confirmLabel={`Buy for ${moneyCompact(price)}`}
        confirmDisabled={cash < price}
        busy={purchase.isPending}
        error={errorFor(purchase)}
        onCancel={closeDialog}
        onConfirm={() =>
          purchase.mutate(
            {
              parcelId: parcel.id,
              body: { expectedVersion: parcel.version, expectedPricePaise: price },
            },
            { onSuccess: closeDialog },
          )
        }
      />
    );
  } else if (parcel && dialog === 'lease') {
    const rent = parcel.leaseRentPaisePerSeason * seasons;
    dialogNode = (
      <ConfirmDialog
        title={`Lease parcel ${parcel.id}?`}
        description={`Rent is paid upfront for the whole term (${seasons} × ${SEASON_LENGTH_DAYS} days). You farm the land and pay its land tax; ownership stays with the state and the lease simply ends at the term.`}
        lines={[
          { label: 'Rent per season', value: money(parcel.leaseRentPaisePerSeason) },
          { label: `Total rent (${seasons} season${seasons > 1 ? 's' : ''})`, value: money(rent) },
          {
            label: 'Land tax (per month)',
            value: money(parcel.monthlyLandTaxPaise),
            tone: 'muted',
          },
          {
            label: 'Cash after',
            value: money(cash - rent),
            total: true,
            tone: cash - rent < 0 ? 'danger' : undefined,
          },
        ]}
        warnings={[
          ...affordWarnings(rent, parcel.monthlyLandTaxPaise),
          'A crop still in the ground when the lease ends may be lost — plan the sowing calendar around the term.',
        ]}
        confirmLabel={`Lease for ${moneyCompact(rent)}`}
        confirmDisabled={cash < rent}
        busy={lease.isPending}
        error={errorFor(lease)}
        onCancel={closeDialog}
        onConfirm={() =>
          lease.mutate(
            {
              parcelId: parcel.id,
              body: { expectedVersion: parcel.version, seasons, expectedRentPaise: rent },
            },
            { onSuccess: closeDialog },
          )
        }
      >
        <div className="bh-field">
          <label htmlFor="lease-seasons">Term</label>
          <select
            id="lease-seasons"
            className="bh-select"
            value={seasons}
            onChange={(e) => setSeasons(Number(e.target.value))}
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n} season{n > 1 ? 's' : ''} ({n * SEASON_LENGTH_DAYS} days)
              </option>
            ))}
          </select>
        </div>
      </ConfirmDialog>
    );
  } else if (parcel && dialog === 'sell-state') {
    const amount = safe(
      () => mulPaise(parcel.basePricePaise, LAND_SELL_TO_STATE_FRACTION),
      Math.round(parcel.basePricePaise * LAND_SELL_TO_STATE_FRACTION),
    );
    dialogNode = (
      <ConfirmDialog
        title={`Sell ${parcel.id} back to the state?`}
        description="The state buys land instantly at a discount to its base value. This cannot be undone; you would have to buy the parcel back at full price."
        lines={[
          { label: 'Base value', value: money(parcel.basePricePaise), tone: 'muted' },
          {
            label: `State pays (${formatFraction(LAND_SELL_TO_STATE_FRACTION)})`,
            value: money(amount),
            tone: 'success',
          },
          {
            label: 'Monthly land tax saved',
            value: money(parcel.monthlyLandTaxPaise),
            tone: 'muted',
          },
          { label: 'Cash after', value: money(cash + amount), total: true },
        ]}
        warnings={['Listing the parcel for other players may fetch a better price.']}
        confirmLabel={`Sell for ${moneyCompact(amount)}`}
        danger
        busy={sellState.isPending}
        error={errorFor(sellState)}
        onCancel={closeDialog}
        onConfirm={() =>
          sellState.mutate(
            {
              parcelId: parcel.id,
              body: { expectedVersion: parcel.version, expectedPricePaise: amount },
            },
            { onSuccess: closeDialog },
          )
        }
      />
    );
  } else if (parcel && dialog === 'list') {
    const pricePaise = parseRupees(listPrice);
    // Server rule: owner list price must lie within 0.25–4× the parcel's base value.
    const minList = Math.ceil(parcel.basePricePaise * 0.25);
    const maxList = Math.floor(parcel.basePricePaise * 4);
    const outOfBand = !!pricePaise && (pricePaise < minList || pricePaise > maxList);
    dialogNode = (
      <ConfirmDialog
        title={`List ${parcel.id} for sale`}
        description="Other companies (players and AI) can buy it at your asking price at any time while it is listed. You keep farming rights until it sells and can withdraw the listing whenever you like."
        lines={
          pricePaise
            ? [
                { label: 'Asking price', value: money(pricePaise) },
                { label: 'Base value', value: money(parcel.basePricePaise), tone: 'muted' },
                {
                  label: 'vs base value',
                  value: formatFraction(pricePaise / parcel.basePricePaise - 1),
                  tone: pricePaise >= parcel.basePricePaise ? 'success' : 'warning',
                },
              ]
            : []
        }
        confirmLabel="Publish listing"
        confirmDisabled={!pricePaise || pricePaise <= 0 || outOfBand}
        busy={list.isPending}
        error={errorFor(list)}
        onCancel={closeDialog}
        onConfirm={() => {
          if (pricePaise)
            list.mutate({ parcelId: parcel.id, body: { pricePaise } }, { onSuccess: closeDialog });
        }}
      >
        <div className="bh-field">
          <label htmlFor="list-price">Asking price (₹)</label>
          <input
            id="list-price"
            className="bh-input num"
            inputMode="decimal"
            placeholder={String(Math.round(parcel.basePricePaise / 100))}
            value={listPrice}
            onChange={(e) => setListPrice(e.target.value)}
            data-testid="parcel-list-price"
            aria-invalid={(listPrice !== '' && !pricePaise) || outOfBand}
          />
          <span className={`bh-hint${outOfBand ? ' tone-danger' : ''}`}>
            Allowed range {moneyCompact(minList)} – {moneyCompact(maxList)} (0.25–4× base value).
          </span>
        </div>
      </ConfirmDialog>
    );
  }

  const title = `Parcel ${parcelId}`;
  return (
    <Panel
      title={title}
      testId="parcel-inspector"
      subtitle={
        parcel ? (
          <span className="bh-row wrap" style={{ gap: 6 }}>
            <Chip tone={isMine ? 'accent' : parcel.status === 'for_sale' ? 'info' : 'neutral'}>
              {isMine ? 'Yours' : statusLabel(parcel.status)}
            </Chip>
            {parcel.isStarterPlot ? <Chip tone="success">Starter plot</Chip> : null}
            <span>
              {formatHa(parcel.areaHa)} · {humanize(parcel.env.soilTexture)} ·{' '}
              {humanize(parcel.env.waterAccess)} water
            </span>
          </span>
        ) : undefined
      }
      onClose={close}
      actions={
        <button
          type="button"
          className="bh-icon-btn"
          aria-label="Focus camera on parcel"
          title="Focus camera"
          onClick={() => requestFocus(parcelId)}
        >
          <Icon name="target" />
        </button>
      }
      footer={
        detail && parcel ? (
          <div className="bh-stack" style={{ gap: 8 }}>
            <div className="bh-row wrap">
              {detail.actions.canPurchase && parcel.listPricePaise != null ? (
                <Button
                  variant="primary"
                  icon="coin"
                  onClick={() => setDialog('buy')}
                  data-testid="parcel-buy-button"
                >
                  Buy {moneyCompact(parcel.listPricePaise)}
                </Button>
              ) : null}
              {detail.actions.canLease ? (
                <Button onClick={() => setDialog('lease')} data-testid="parcel-lease-button">
                  Lease {moneyCompact(parcel.leaseRentPaisePerSeason)}/season
                </Button>
              ) : null}
              {detail.actions.canPlant ? (
                <Button
                  variant="primary"
                  icon="farm"
                  onClick={() => openPlant(parcel.id)}
                  data-testid="parcel-plant-button"
                >
                  Plant crop
                </Button>
              ) : null}
              {detail.actions.canListForSale ? (
                <Button onClick={() => setDialog('list')} data-testid="parcel-list-button">
                  List for sale
                </Button>
              ) : null}
              {isMine && parcel.status === 'for_sale' ? (
                <Button
                  busy={delist.isPending}
                  onClick={() => delist.mutate({ parcelId: parcel.id })}
                  data-testid="parcel-delist-button"
                >
                  Withdraw listing
                </Button>
              ) : null}
              {detail.actions.canSellToState ? (
                <Button
                  variant="ghost"
                  onClick={() => setDialog('sell-state')}
                  data-testid="parcel-sell-state-button"
                >
                  Sell to state
                </Button>
              ) : null}
            </div>
            {(() => {
              const why =
                !detail.actions.canPurchase && parcel.status === 'for_sale' && !isMine
                  ? reasonFor('purchase', 'canPurchase')
                  : null;
              const plantWhy =
                isMine && !detail.actions.canPlant && !detail.plot
                  ? reasonFor('plant', 'canPlant')
                  : null;
              const text = why ?? plantWhy;
              return text ? (
                <div className="faint" style={{ fontSize: 12 }} data-testid="parcel-action-reason">
                  <Icon name="info" size={13} /> {text}
                </div>
              ) : null;
            })()}
          </div>
        ) : null
      }
    >
      {parcelQ.isError ? (
        <ErrorState error={parcelQ.error} onRetry={() => void parcelQ.refetch()} />
      ) : null}
      {!detail && parcelQ.isPending ? <SkeletonRows rows={8} /> : null}
      {detail && parcel ? (
        <div className="bh-stack">
          <div className="bh-grid-3">
            {parcel.status === 'for_sale' && parcel.listPricePaise != null ? (
              <Stat
                label="Asking price"
                value={moneyCompact(parcel.listPricePaise)}
                title={money(parcel.listPricePaise)}
                testId="parcel-price"
              />
            ) : (
              <Stat
                label="Base value"
                value={moneyCompact(parcel.basePricePaise)}
                title={money(parcel.basePricePaise)}
              />
            )}
            <Stat
              label="Land tax / mo"
              value={moneyCompact(parcel.monthlyLandTaxPaise)}
              title={money(parcel.monthlyLandTaxPaise)}
            />
            <Stat
              label="Lease / season"
              value={moneyCompact(parcel.leaseRentPaisePerSeason)}
              title={money(parcel.leaseRentPaisePerSeason)}
            />
          </div>
          {overview.data && overview.data.company.status !== 'active' ? (
            <div className="bh-callout danger" role="note">
              {overview.data.company.status === 'distressed'
                ? 'Your company is distressed: only selling, repaying, delisting, harvesting and deliveries are allowed until cash is positive again.'
                : 'Your company is bankrupt: actions are suspended until the restructuring completes.'}
            </div>
          ) : null}
          <div className="muted" style={{ fontSize: 12.5 }}>
            {parcel.ownerName
              ? `Owner: ${parcel.ownerName}`
              : 'Owner: State of Karnataka (land bank)'}
            {parcel.lease
              ? ` · Leased to ${parcel.lease.lesseeName} until day ${parcel.lease.endDay} (${relativeDay(parcel.lease.endDay, today)})`
              : ''}
          </div>

          {detail.plot ? (
            <>
              <SectionTitle>Current crop</SectionTitle>
              <div className="bh-card bh-stack" style={{ gap: 8 }}>
                <div className="bh-row between">
                  <strong>{cropName(detail.plot.cropId, crops.data?.crops)}</strong>
                  <Chip
                    tone={
                      detail.plot.status === 'ready'
                        ? 'success'
                        : detail.plot.status === 'failed'
                          ? 'danger'
                          : 'info'
                    }
                  >
                    {detail.plot.status === 'growing'
                      ? humanize(detail.plot.stage)
                      : humanize(detail.plot.status)}
                  </Chip>
                </div>
                <ProgressBar
                  value={detail.plot.progress}
                  label="Growth progress"
                  tone={detail.plot.status === 'ready' ? 'success' : undefined}
                />
                <div className="bh-row between faint" style={{ fontSize: 12 }}>
                  <span>
                    Health{' '}
                    {formatFraction(
                      detail.plot.health > 1 ? detail.plot.health / 100 : detail.plot.health,
                    )}
                  </span>
                  <span>Expected {formatKg(detail.plot.expectedHarvestKg)}</span>
                  {detail.plot.readyDay != null ? (
                    <span>Ready {relativeDay(detail.plot.readyDay, today)}</span>
                  ) : null}
                </div>
                {isMine ? (
                  <Button size="sm" onClick={() => openPanel('farm')}>
                    Manage in Farm panel
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}

          <SectionTitle>Environment</SectionTitle>
          <EnvGrid parcel={parcel} />

          <SectionTitle>Crop suitability</SectionTitle>
          {suitQ.isError ? (
            <ErrorState error={suitQ.error} onRetry={() => void suitQ.refetch()} compact />
          ) : null}
          {!suitQ.data && suitQ.isPending ? <SkeletonRows rows={6} height={34} /> : null}
          {suitQ.data ? (
            suitQ.data.results.length === 0 ? (
              <EmptyState title="No suitability data" />
            ) : (
              <div className="bh-stack" style={{ gap: 6 }} data-testid="suitability-table">
                {!suitQ.data.irrigationAvailable ? (
                  <div className="bh-callout warning" style={{ fontSize: 12 }}>
                    No irrigation source on this parcel — scores assume rain-fed farming. A pump set
                    enables well irrigation.
                  </div>
                ) : null}
                {[...suitQ.data.results]
                  .sort((a, b) => b.score - a.score)
                  .map((s) => (
                    <SuitabilityRow
                      key={s.cropId}
                      s={s}
                      areaHa={parcel.areaHa}
                      crops={crops.data?.crops}
                      expanded={expanded === s.cropId}
                      onToggle={() => setExpanded(expanded === s.cropId ? null : s.cropId)}
                    />
                  ))}
              </div>
            )
          ) : null}
          <div className="faint" style={{ fontSize: 11.5 }}>
            Version {parcel.version} · nearest market {parcel.nearestMarketId} ·{' '}
            {formatDays(SEASON_LENGTH_DAYS)} per lease season
          </div>
        </div>
      ) : null}
      {dialogNode}
    </Panel>
  );
}
