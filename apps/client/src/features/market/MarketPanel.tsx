import type { ListingDto, MarketsResponse } from '@bh/contracts';
import { ITEM_IDS, p2pPriceBand, P2P_TRADE_FEE_BPS, type ItemId } from '@bh/domain';
import { useEffect, useMemo, useState } from 'react';
import { describeError } from '../../api/errors';
import { isApiError } from '../../api/http';
import {
  useBuyListing,
  useCancelListing,
  useCreateListing,
  useSellToMarket,
} from '../../api/mutations';
import {
  useCompanyId,
  useInventory,
  useListings,
  useMarkets,
  useMe,
  useOverview,
  usePriceHistory,
  useSaleQuote,
  useWorld,
} from '../../api/queries';
import { CROP_META } from '../../lib/cropMeta';
import { parseKg, parseRupees, safe } from '../../lib/economics';
import {
  formatKg,
  formatSignedPct,
  money,
  moneyCompact,
  perKg,
  relativeDay,
} from '../../lib/format';
import { useDebouncedValue } from '../../lib/hooks';
import { useUiStore } from '../../store/ui';
import { Chip, Segmented, Tabs } from '../../ui/Bits';
import { Button } from '../../ui/Button';
import { Sparkline } from '../../ui/Charts';
import { ConfirmDialog } from '../../ui/Dialog';
import { Panel } from '../../ui/Panel';
import { EmptyState, ErrorState, QueryView, Skeleton } from '../../ui/States';

type Market = MarketsResponse['markets'][number];
type Tab = 'prices' | 'sell' | 'p2p' | 'mine';

/** Slippage guard: accept at most a 2% worse net unit price than quoted. */
export function minNetUnitPrice(netPaise: number, quantityKg: number): number {
  if (quantityKg <= 0) return 0;
  return Math.floor((netPaise / quantityKg) * 0.98);
}

function PricesTable({ market }: { market: Market }) {
  const history = usePriceHistory(market.id, null, 30);
  const seriesByItem = useMemo(
    () =>
      new Map(
        (history.data?.series ?? []).map((s) => [s.itemId, s.points.map((p) => p.pricePaisePerKg)]),
      ),
    [history.data],
  );
  return (
    <table className="bh-table" data-testid="market-prices">
      <thead>
        <tr>
          <th>Crop</th>
          <th className="num">Price</th>
          <th className="num">7 d</th>
          <th>30 d trend</th>
          <th className="num">vs base</th>
          <th className="num">Demand / day</th>
        </tr>
      </thead>
      <tbody>
        {market.prices.map((p) => {
          const vsBase =
            p.basePricePaisePerKg > 0 ? (p.pricePaisePerKg / p.basePricePaisePerKg - 1) * 100 : 0;
          return (
            <tr key={p.itemId}>
              <td>
                <span
                  className="bh-crop-swatch"
                  style={{
                    background: CROP_META[p.itemId].swatch,
                    display: 'inline-block',
                    width: 10,
                    height: 10,
                    marginRight: 8,
                  }}
                />
                {CROP_META[p.itemId].label}
              </td>
              <td className="num">
                <strong>{perKg(p.pricePaisePerKg)}</strong>
              </td>
              <td
                className={`num ${p.changePct7d > 0 ? 'tone-success' : p.changePct7d < 0 ? 'tone-danger' : 'muted'}`}
              >
                {formatSignedPct(p.changePct7d)}
              </td>
              <td>
                {history.isPending ? (
                  <Skeleton width={84} height={20} />
                ) : (
                  <Sparkline
                    values={seriesByItem.get(p.itemId) ?? []}
                    label={`${CROP_META[p.itemId].label} 30-day price`}
                  />
                )}
              </td>
              <td className="num muted">{formatSignedPct(vsBase, 0)}</td>
              <td className="num muted">{formatKg(p.demandKgPerDay)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SellForm({ market }: { market: Market }) {
  const inv = useInventory();
  const prefill = useUiStore((s) => s.sellPrefill);
  const available = useMemo(
    () => (inv.data?.totals ?? []).filter((t) => t.availableKg > 0),
    [inv.data],
  );
  const [itemId, setItemId] = useState<ItemId | null>(prefill);
  const effectiveItem =
    itemId && available.some((a) => a.itemId === itemId) ? itemId : (available[0]?.itemId ?? null);
  const stock = available.find((a) => a.itemId === effectiveItem)?.availableKg ?? 0;
  const [qtyText, setQtyText] = useState('');
  const qty = parseKg(qtyText) ?? 0;
  const debouncedQty = useDebouncedValue(qty, 350);
  const quote = useSaleQuote(market.id, effectiveItem, Math.min(debouncedQty, stock));
  const sell = useSellToMarket();
  const q = quote.data;
  const quoteMatches =
    !quote.isError &&
    !!q &&
    q.itemId === effectiveItem &&
    q.quantityKg === qty &&
    q.marketId === market.id;
  const tooMuch = qty > stock;

  useEffect(() => {
    if (prefill) useUiStore.setState({ sellPrefill: null });
  }, [prefill]);

  if (inv.isPending) return <Skeleton height={120} />;
  if (inv.isError) return <ErrorState error={inv.error} onRetry={() => void inv.refetch()} />;
  if (available.length === 0) {
    return (
      <EmptyState icon="inventory" title="Nothing to sell">
        Harvest a crop first — produce in storage can be sold here.
      </EmptyState>
    );
  }
  const submit = () => {
    if (!q || !effectiveItem || !quoteMatches) return;
    sell.mutate(
      {
        marketId: market.id,
        body: {
          itemId: effectiveItem,
          quantityKg: qty,
          minNetUnitPricePaise: minNetUnitPrice(q.netPaise, q.quantityKg),
        },
      },
      { onSuccess: () => setQtyText('') },
    );
  };
  return (
    <form
      className="bh-stack"
      data-testid="sell-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="bh-grid-2">
        <div className="bh-field">
          <label htmlFor="sell-item">Produce</label>
          <select
            id="sell-item"
            className="bh-select"
            value={effectiveItem ?? ''}
            onChange={(e) => setItemId(e.target.value as ItemId)}
            data-testid="sell-item"
          >
            {available.map((a) => (
              <option key={a.itemId} value={a.itemId}>
                {CROP_META[a.itemId].label} — {formatKg(a.availableKg)} available
              </option>
            ))}
          </select>
        </div>
        <div className="bh-field">
          <label htmlFor="sell-qty">Quantity (kg)</label>
          <div className="bh-row">
            <input
              id="sell-qty"
              className="bh-input num"
              inputMode="numeric"
              value={qtyText}
              onChange={(e) => setQtyText(e.target.value)}
              aria-invalid={tooMuch || (qtyText !== '' && qty <= 0)}
              data-testid="sell-quantity"
            />
            <Button size="sm" onClick={() => setQtyText(String(stock))}>
              Max
            </Button>
          </div>
          {tooMuch ? (
            <div className="bh-error-text">
              Only {formatKg(stock)} available (reserved stock excluded).
            </div>
          ) : null}
        </div>
      </div>
      <div className="bh-card" data-testid="sell-quote" aria-live="polite">
        {qty <= 0 || tooMuch ? (
          <span className="faint">Enter a quantity to get a live quote from {market.name}.</span>
        ) : quote.isError && !quote.isFetching ? (
          isApiError(quote.error) && quote.error.code === 'INSUFFICIENT_STOCK' ? (
            <span className="tone-warning">
              Not enough unreserved stock for that quantity — reduce it or cancel a listing to free
              stock.
            </span>
          ) : (
            <ErrorState error={quote.error} compact />
          )
        ) : !q ? (
          <Skeleton height={90} />
        ) : (
          <dl className="bh-kv" style={{ opacity: quoteMatches ? 1 : 0.55 }}>
            <dt>Realised unit price (quality {Math.round(q.quality)})</dt>
            <dd>{perKg(q.unitPricePaise)}</dd>
            <dt>Gross</dt>
            <dd>{money(q.grossPaise)}</dd>
            <dt>Price impact of this volume</dt>
            <dd className={q.priceImpactPct > 5 ? 'tone-warning' : 'muted'}>
              {formatSignedPct(-Math.abs(q.priceImpactPct))}
            </dd>
            <dt>Mandi fee ({(market.feeBps / 100).toFixed(1)}%)</dt>
            <dd className="tone-danger">−{money(q.feePaise)}</dd>
            <dt>Transport by lorry</dt>
            <dd className="tone-danger">−{money(q.transportPaise)}</dd>
            <dt className="total">You receive</dt>
            <dd className="total tone-success">{money(q.netPaise)}</dd>
            <dt className="faint">Net per kg · guaranteed minimum</dt>
            <dd className="faint">
              {perKg(Math.floor(q.netPaise / Math.max(1, q.quantityKg)))} ·{' '}
              {perKg(minNetUnitPrice(q.netPaise, q.quantityKg))}
            </dd>
          </dl>
        )}
      </div>
      {q && q.priceImpactPct > 8 ? (
        <div className="bh-callout warning">
          Large volume moves the mandi price. Selling in smaller lots over several days, or to a
          market with more demand, may fetch more.
        </div>
      ) : null}
      {sell.isError ? (
        <div className="bh-callout danger" role="alert">
          {describeError(sell.error).message}
        </div>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        busy={sell.isPending}
        disabled={!quoteMatches || tooMuch || qty <= 0}
        data-testid="sell-submit"
      >
        {quoteMatches && q ? `Sell for ${moneyCompact(q.netPaise)}` : 'Sell'}
      </Button>
      <div className="faint" style={{ fontSize: 11.5 }}>
        Rejected automatically if the realised net price falls more than 2% below this quote
        (slippage guard).
      </div>
    </form>
  );
}

function BuyListingDialog({ listing, onClose }: { listing: ListingDto; onClose: () => void }) {
  const [qtyText, setQtyText] = useState(String(listing.remainingKg));
  const qty = parseKg(qtyText) ?? 0;
  const buy = useBuyListing();
  const overview = useOverview();
  const me = useMe();
  const cash = overview.data?.company.cashPaise ?? me.data?.company?.cashPaise ?? 0;
  const total = qty * listing.unitPricePaise;
  const invalid = qty <= 0 || qty > listing.remainingKg;
  return (
    <ConfirmDialog
      title={`Buy ${CROP_META[listing.itemId].label} from ${listing.sellerName}`}
      description={`Quality ${listing.quality}. Delivered into your storage immediately as a new lot with the seller's expiry date.`}
      lines={[
        { label: 'Unit price', value: perKg(listing.unitPricePaise) },
        { label: 'Quantity', value: formatKg(qty) },
        { label: 'Total', value: money(total), total: true },
        {
          label: 'Cash after',
          value: money(cash - total),
          tone: cash - total < 0 ? 'danger' : 'muted',
        },
      ]}
      warnings={cash - total < 0 ? ['Not enough cash for this quantity.'] : []}
      confirmLabel={`Pay ${moneyCompact(total)}`}
      confirmDisabled={invalid || cash < total}
      busy={buy.isPending}
      error={buy.isError ? describeError(buy.error) : null}
      onCancel={onClose}
      onConfirm={() =>
        buy.mutate(
          {
            listingId: listing.id,
            body: { quantityKg: qty, expectedUnitPricePaise: listing.unitPricePaise },
          },
          { onSuccess: onClose },
        )
      }
    >
      <div className="bh-field">
        <label htmlFor="buy-qty">Quantity (kg, up to {formatKg(listing.remainingKg)})</label>
        <input
          id="buy-qty"
          className="bh-input num"
          inputMode="numeric"
          value={qtyText}
          onChange={(e) => setQtyText(e.target.value)}
          aria-invalid={invalid}
          data-testid="listing-buy-quantity"
        />
      </div>
    </ConfirmDialog>
  );
}

function P2PListings() {
  const companyId = useCompanyId();
  const [item, setItem] = useState<ItemId | 'all'>('all');
  const listings = useListings({
    status: 'open',
    itemId: item === 'all' ? undefined : item,
    limit: 50,
  });
  const world = useWorld();
  const [buying, setBuying] = useState<ListingDto | null>(null);
  const today = world.data?.gameDay ?? 0;
  return (
    <div className="bh-stack">
      <div className="bh-row between">
        <span className="muted" style={{ fontSize: 12.5 }}>
          Buy directly from other companies. Prices are bounded to a band around mandi prices.
        </span>
        <select
          className="bh-select"
          style={{ width: 160 }}
          value={item}
          onChange={(e) => setItem(e.target.value as ItemId | 'all')}
          aria-label="Filter by crop"
        >
          <option value="all">All crops</option>
          {ITEM_IDS.map((i) => (
            <option key={i} value={i}>
              {CROP_META[i].label}
            </option>
          ))}
        </select>
      </div>
      <QueryView query={listings}>
        {(data) => {
          const rows = data.listings.filter((l) => l.sellerCompanyId !== companyId);
          if (rows.length === 0)
            return (
              <EmptyState title="No open listings">Check back later or post your own.</EmptyState>
            );
          return (
            <table className="bh-table" data-testid="p2p-listings">
              <thead>
                <tr>
                  <th>Crop</th>
                  <th>Seller</th>
                  <th className="num">Quality</th>
                  <th className="num">Remaining</th>
                  <th className="num">Price</th>
                  <th className="num">Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id}>
                    <td>{CROP_META[l.itemId].label}</td>
                    <td className="muted">{l.sellerName}</td>
                    <td className="num">{l.quality}</td>
                    <td className="num">{formatKg(l.remainingKg)}</td>
                    <td className="num">{perKg(l.unitPricePaise)}</td>
                    <td className="num muted">{relativeDay(l.expiresDay, today)}</td>
                    <td className="num">
                      <Button
                        size="sm"
                        onClick={() => setBuying(l)}
                        data-testid="listing-buy-button"
                      >
                        Buy…
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }}
      </QueryView>
      {buying ? <BuyListingDialog listing={buying} onClose={() => setBuying(null)} /> : null}
    </div>
  );
}

function MyListings({ markets }: { markets: Market[] }) {
  const inv = useInventory();
  const listings = useListings({ status: 'open', mine: true, limit: 50 });
  const cancel = useCancelListing();
  const create = useCreateListing();
  const world = useWorld();
  const today = world.data?.gameDay ?? 0;
  const available = (inv.data?.totals ?? []).filter((t) => t.availableKg > 0);
  const [itemId, setItemId] = useState<ItemId | null>(null);
  const item = itemId ?? available[0]?.itemId ?? null;
  const [qtyText, setQtyText] = useState('');
  const [priceText, setPriceText] = useState('');
  const [days, setDays] = useState(14);
  const qty = parseKg(qtyText) ?? 0;
  const price = parseRupees(priceText) ?? 0;
  const best = item
    ? Math.max(
        0,
        ...markets.map((m) => m.prices.find((p) => p.itemId === item)?.pricePaisePerKg ?? 0),
      )
    : 0;
  const band = best > 0 ? safe<[number, number] | null>(() => p2pPriceBand(best), null) : null;
  const stock = available.find((a) => a.itemId === item)?.availableKg ?? 0;
  const outOfBand = !!band && price > 0 && (price < band[0] || price > band[1]);
  const valid = !!item && qty > 0 && qty <= stock && price > 0 && !outOfBand;
  return (
    <div className="bh-stack">
      <form
        className="bh-card bh-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && item) {
            create.mutate(
              { itemId: item, quantityKg: qty, unitPricePaise: price, durationDays: days },
              {
                onSuccess: () => {
                  setQtyText('');
                  setPriceText('');
                },
              },
            );
          }
        }}
        data-testid="create-listing-form"
      >
        <strong>Post a listing</strong>
        {available.length === 0 ? (
          <span className="faint">No unreserved stock to list.</span>
        ) : (
          <>
            <div className="bh-grid-2">
              <div className="bh-field">
                <label htmlFor="cl-item">Produce</label>
                <select
                  id="cl-item"
                  className="bh-select"
                  value={item ?? ''}
                  onChange={(e) => setItemId(e.target.value as ItemId)}
                >
                  {available.map((a) => (
                    <option key={a.itemId} value={a.itemId}>
                      {CROP_META[a.itemId].label} — {formatKg(a.availableKg)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="bh-field">
                <label htmlFor="cl-qty">Quantity (kg)</label>
                <input
                  id="cl-qty"
                  className="bh-input num"
                  inputMode="numeric"
                  value={qtyText}
                  onChange={(e) => setQtyText(e.target.value)}
                  aria-invalid={qty > stock}
                />
              </div>
              <div className="bh-field">
                <label htmlFor="cl-price">Unit price (₹/kg)</label>
                <input
                  id="cl-price"
                  className="bh-input num"
                  inputMode="decimal"
                  value={priceText}
                  onChange={(e) => setPriceText(e.target.value)}
                  aria-invalid={outOfBand}
                />
                <span className={`bh-hint${outOfBand ? ' tone-danger' : ''}`}>
                  {band
                    ? `Allowed ${perKg(band[0])} – ${perKg(band[1])} (best mandi ${perKg(best)})`
                    : 'Must lie within the band around mandi prices'}
                </span>
              </div>
              <div className="bh-field">
                <label htmlFor="cl-days">Open for</label>
                <select
                  id="cl-days"
                  className="bh-select"
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                >
                  {[3, 7, 14, 30, 60].map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="faint" style={{ fontSize: 12 }}>
              Up to 20 open listings. The quantity is reserved from your best lot until sold,
              cancelled or expired. A {(P2P_TRADE_FEE_BPS / 100).toFixed(0)}% trade fee is deducted
              from each sale.
              {qty > 0 && price > 0 ? ` Gross if fully sold: ${money(qty * price)}.` : ''}
            </div>
            {create.isError ? (
              <div className="bh-callout danger">{describeError(create.error).message}</div>
            ) : null}
            <Button type="submit" variant="primary" disabled={!valid} busy={create.isPending}>
              Publish listing
            </Button>
          </>
        )}
      </form>
      <QueryView query={listings}>
        {(data) =>
          data.listings.length === 0 ? (
            <EmptyState title="You have no open listings" />
          ) : (
            <table className="bh-table" data-testid="my-listings">
              <thead>
                <tr>
                  <th>Crop</th>
                  <th className="num">Remaining</th>
                  <th className="num">Price</th>
                  <th className="num">Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.listings.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {CROP_META[l.itemId].label} <Chip tone="neutral">q{l.quality}</Chip>
                    </td>
                    <td className="num">
                      {formatKg(l.remainingKg)} / {formatKg(l.quantityKg)}
                    </td>
                    <td className="num">{perKg(l.unitPricePaise)}</td>
                    <td className="num muted">{relativeDay(l.expiresDay, today)}</td>
                    <td className="num">
                      <Button
                        size="sm"
                        variant="ghost"
                        busy={cancel.isPending && cancel.variables?.listingId === l.id}
                        onClick={() => cancel.mutate({ listingId: l.id })}
                      >
                        Cancel
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </QueryView>
    </div>
  );
}

export function MarketPanel() {
  const close = useUiStore((s) => s.closePanel);
  const prefill = useUiStore((s) => s.sellPrefill);
  const markets = useMarkets();
  const [tab, setTab] = useState<Tab>(prefill ? 'sell' : 'prices');
  const [marketId, setMarketId] = useState<string | null>(null);
  const list = markets.data?.markets ?? [];
  const market = list.find((m) => m.id === marketId) ?? list[0];
  return (
    <Panel
      title="Markets"
      subtitle="APMC mandi prices, sales and player trade"
      onClose={close}
      size="lg"
      testId="market-panel"
    >
      <Tabs
        label="Market sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'prices', label: 'Mandi prices', testId: 'market-tab-prices' },
          { id: 'sell', label: 'Sell to mandi', testId: 'market-tab-sell' },
          { id: 'p2p', label: 'Player listings', testId: 'market-tab-p2p' },
          { id: 'mine', label: 'My listings', testId: 'market-tab-mine' },
        ]}
      />
      {(tab === 'prices' || tab === 'sell') && list.length > 1 ? (
        <div style={{ marginBottom: 12 }}>
          <Segmented
            label="Market"
            value={market?.id ?? ''}
            onChange={setMarketId}
            options={list.map((m) => ({ id: m.id, label: m.name }))}
          />
          {market ? (
            <span className="faint" style={{ fontSize: 12, marginLeft: 10 }}>
              Fee {(market.feeBps / 100).toFixed(1)}% · price ×{market.priceScale.toFixed(2)}
            </span>
          ) : null}
        </div>
      ) : null}
      {markets.isError ? (
        <ErrorState error={markets.error} onRetry={() => void markets.refetch()} />
      ) : null}
      {markets.isPending ? <Skeleton height={200} /> : null}
      {market && tab === 'prices' ? <PricesTable market={market} /> : null}
      {market && tab === 'sell' ? <SellForm key={market.id} market={market} /> : null}
      {tab === 'p2p' ? <P2PListings /> : null}
      {tab === 'mine' ? <MyListings markets={list} /> : null}
    </Panel>
  );
}
