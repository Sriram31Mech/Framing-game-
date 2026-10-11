import type { ContractDto } from '@bh/contracts';
import { CONTRACT_DEFAULT_PENALTY_BPS, ITEM_IDS, P2P_TRADE_FEE_BPS, type ItemId } from '@bh/domain';
import { useState } from 'react';
import { describeError } from '../../api/errors';
import {
  useAcceptContract,
  useCancelContract,
  useCreateContract,
  useDeliverContract,
} from '../../api/mutations';
import {
  useCompanyId,
  useContracts,
  useInventory,
  useMe,
  useOverview,
  useWorld,
} from '../../api/queries';
import { CROP_META } from '../../lib/cropMeta';
import { parseKg, parseRupees } from '../../lib/economics';
import { formatKg, humanize, money, moneyCompact, perKg, relativeDay } from '../../lib/format';
import { useUiStore } from '../../store/ui';
import { Chip, Tabs, type ChipTone } from '../../ui/Bits';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/Dialog';
import { Panel } from '../../ui/Panel';
import { EmptyState, QueryView } from '../../ui/States';

type Tab = 'open' | 'mine' | 'create';

const STATUS_TONE: Record<ContractDto['status'], ChipTone> = {
  open: 'info',
  accepted: 'accent',
  fulfilled: 'success',
  cancelled: 'neutral',
  defaulted: 'danger',
  expired: 'neutral',
};

function deadlineTone(daysLeft: number): string {
  return daysLeft <= 3 ? 'tone-danger' : daysLeft <= 10 ? 'tone-warning' : 'muted';
}

function OpenContracts() {
  const companyId = useCompanyId();
  const contracts = useContracts('open');
  const world = useWorld();
  const accept = useAcceptContract();
  const [pending, setPending] = useState<ContractDto | null>(null);
  const today = world.data?.gameDay ?? 0;
  return (
    <>
      <QueryView query={contracts}>
        {(data) => {
          const rows = data.contracts.filter(
            (c) => c.status === 'open' && c.buyerCompanyId !== companyId,
          );
          if (rows.length === 0)
            return (
              <EmptyState icon="contracts" title="No open buy contracts">
                Buyers post forward contracts here.
              </EmptyState>
            );
          return (
            <table className="bh-table" data-testid="open-contracts">
              <thead>
                <tr>
                  <th>Buyer</th>
                  <th>Crop</th>
                  <th className="num">Qty</th>
                  <th className="num">Min q</th>
                  <th className="num">Price</th>
                  <th className="num">Total</th>
                  <th className="num">Deliver by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="muted">{c.buyerName}</td>
                    <td>{CROP_META[c.itemId].label}</td>
                    <td className="num">{formatKg(c.quantityKg)}</td>
                    <td className="num">{c.minQuality}</td>
                    <td className="num">{perKg(c.unitPricePaise)}</td>
                    <td className="num">{moneyCompact(c.totalPaise)}</td>
                    <td className={`num ${deadlineTone(c.deliveryByDay - today)}`}>
                      {relativeDay(c.deliveryByDay, today)}
                    </td>
                    <td className="num">
                      <Button
                        size="sm"
                        onClick={() => setPending(c)}
                        data-testid="contract-accept-button"
                      >
                        Accept…
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }}
      </QueryView>
      {pending ? (
        <ConfirmDialog
          title={`Supply ${formatKg(pending.quantityKg)} of ${CROP_META[pending.itemId].label}?`}
          description={`You commit to deliver at least quality ${pending.minQuality} to ${pending.buyerName} by day ${pending.deliveryByDay} (${relativeDay(pending.deliveryByDay, today)}). The buyer's money is already in escrow.`}
          lines={[
            { label: 'Contract value', value: money(pending.totalPaise) },
            {
              label: `Trade fee (${(P2P_TRADE_FEE_BPS / 100).toFixed(0)}%)`,
              value: `−${money(Math.round((pending.totalPaise * P2P_TRADE_FEE_BPS) / 10_000))}`,
              tone: 'muted',
            },
            {
              label: 'Penalty if you fail to deliver',
              value: money(
                Math.round((pending.totalPaise * CONTRACT_DEFAULT_PENALTY_BPS) / 10_000),
              ),
              tone: 'danger',
            },
          ]}
          warnings={[
            'A default pays the buyer a penalty from your cash — this can push your company into distress.',
          ]}
          confirmLabel="Accept contract"
          busy={accept.isPending}
          error={accept.isError ? describeError(accept.error) : null}
          onCancel={() => {
            setPending(null);
            accept.reset();
          }}
          onConfirm={() =>
            accept.mutate(
              {
                contractId: pending.id,
                body: { expectedVersion: pending.version, termsHash: pending.termsHash },
              },
              { onSuccess: () => setPending(null) },
            )
          }
        />
      ) : null}
    </>
  );
}

function MyContracts() {
  const companyId = useCompanyId();
  const contracts = useContracts('mine');
  const inv = useInventory();
  const world = useWorld();
  const deliver = useDeliverContract();
  const cancel = useCancelContract();
  const today = world.data?.gameDay ?? 0;
  const availableFor = (c: ContractDto) =>
    (inv.data?.lots ?? [])
      .filter((l) => l.itemId === c.itemId && l.quality >= c.minQuality)
      .reduce((s, l) => s + l.availableKg, 0);
  return (
    <QueryView query={contracts}>
      {(data) =>
        data.contracts.length === 0 ? (
          <EmptyState icon="contracts" title="No contracts yet">
            Accept an open contract or post your own buy order.
          </EmptyState>
        ) : (
          <div className="bh-stack" data-testid="my-contracts">
            {data.contracts.map((c) => {
              const buyer = c.buyerCompanyId === companyId;
              const left = c.deliveryByDay - today;
              const stock = availableFor(c);
              return (
                <article key={c.id} className="bh-card bh-stack" style={{ gap: 6 }}>
                  <div className="bh-row between">
                    <strong>
                      {buyer ? 'Buying' : 'Supplying'} {formatKg(c.quantityKg)}{' '}
                      {CROP_META[c.itemId].label}
                    </strong>
                    <Chip tone={STATUS_TONE[c.status]}>{humanize(c.status)}</Chip>
                  </div>
                  <div className="bh-row between muted" style={{ fontSize: 12.5 }}>
                    <span>
                      {buyer
                        ? `Seller: ${c.sellerName ?? 'not yet accepted'}`
                        : `Buyer: ${c.buyerName}`}{' '}
                      · min quality {c.minQuality}
                    </span>
                    <span>
                      {perKg(c.unitPricePaise)} · {money(c.totalPaise)}
                    </span>
                  </div>
                  {c.status === 'open' || c.status === 'accepted' ? (
                    <div className="bh-row between">
                      <span className={deadlineTone(left)} style={{ fontSize: 12.5 }}>
                        Deliver by day {c.deliveryByDay} ({relativeDay(c.deliveryByDay, today)})
                      </span>
                      {buyer && c.status === 'open' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          busy={cancel.isPending && cancel.variables?.contractId === c.id}
                          onClick={() => cancel.mutate({ contractId: c.id })}
                        >
                          Cancel &amp; refund escrow
                        </Button>
                      ) : null}
                      {!buyer && c.status === 'accepted' ? (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={stock < c.quantityKg}
                          title={
                            stock < c.quantityKg
                              ? `You hold ${formatKg(stock)} of qualifying stock`
                              : undefined
                          }
                          busy={deliver.isPending && deliver.variables?.contractId === c.id}
                          onClick={() => deliver.mutate({ contractId: c.id })}
                          data-testid="contract-deliver-button"
                        >
                          Deliver ({formatKg(Math.min(stock, c.quantityKg))}/
                          {formatKg(c.quantityKg)})
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )
      }
    </QueryView>
  );
}

function CreateContract({ onDone }: { onDone: () => void }) {
  const create = useCreateContract();
  const overview = useOverview();
  const me = useMe();
  const [itemId, setItemId] = useState<ItemId>('rice');
  const [qtyText, setQtyText] = useState('1000');
  const [quality, setQuality] = useState(50);
  const [priceText, setPriceText] = useState('');
  const [days, setDays] = useState(30);
  const [confirming, setConfirming] = useState(false);
  const qty = parseKg(qtyText) ?? 0;
  const price = parseRupees(priceText) ?? 0;
  const total = qty * price;
  const cash = overview.data?.company.cashPaise ?? me.data?.company?.cashPaise ?? 0;
  const valid = qty > 0 && price > 0 && days >= 3 && days <= 180;
  return (
    <form
      className="bh-stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) setConfirming(true);
      }}
      data-testid="create-contract-form"
    >
      <div className="bh-callout info">
        A buy contract locks the full value in <strong>escrow</strong> now. It is released to the
        seller (minus a {(P2P_TRADE_FEE_BPS / 100).toFixed(0)}% fee) on delivery, refunded if nobody
        accepts before the deadline, and refunded with a{' '}
        {(CONTRACT_DEFAULT_PENALTY_BPS / 100).toFixed(0)}% penalty paid to you if the seller
        defaults. Up to 10 open contracts.
      </div>
      <div className="bh-grid-2">
        <div className="bh-field">
          <label htmlFor="cc-item">Crop</label>
          <select
            id="cc-item"
            className="bh-select"
            value={itemId}
            onChange={(e) => setItemId(e.target.value as ItemId)}
          >
            {ITEM_IDS.map((i) => (
              <option key={i} value={i}>
                {CROP_META[i].label}
              </option>
            ))}
          </select>
        </div>
        <div className="bh-field">
          <label htmlFor="cc-qty">Quantity (kg)</label>
          <input
            id="cc-qty"
            className="bh-input num"
            inputMode="numeric"
            value={qtyText}
            onChange={(e) => setQtyText(e.target.value)}
          />
        </div>
        <div className="bh-field">
          <label htmlFor="cc-price">Unit price (₹/kg)</label>
          <input
            id="cc-price"
            className="bh-input num"
            inputMode="decimal"
            value={priceText}
            onChange={(e) => setPriceText(e.target.value)}
          />
        </div>
        <div className="bh-field">
          <label htmlFor="cc-q">Minimum quality: {quality}</label>
          <input
            id="cc-q"
            type="range"
            min={0}
            max={100}
            step={5}
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
          />
        </div>
        <div className="bh-field">
          <label htmlFor="cc-days">Delivery within (days)</label>
          <input
            id="cc-days"
            className="bh-input num"
            type="number"
            min={3}
            max={180}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          />
        </div>
        <div className="bh-field">
          <span className="bh-label">Escrowed now</span>
          <strong className="num" style={{ textAlign: 'left', fontSize: 18 }}>
            {money(total)}
          </strong>
        </div>
      </div>
      <Button type="submit" variant="primary" disabled={!valid || total > cash}>
        Review contract
      </Button>
      {total > cash ? (
        <div className="bh-error-text">Escrow exceeds your cash ({money(cash)}).</div>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title="Post buy contract?"
          description={`Buy ${formatKg(qty)} of ${CROP_META[itemId].label} at quality ≥ ${quality}, delivered within ${days} days.`}
          lines={[
            { label: 'Moved to escrow now', value: money(total) },
            {
              label: 'Cash after',
              value: money(cash - total),
              total: true,
              tone: cash - total < 0 ? 'danger' : undefined,
            },
          ]}
          confirmLabel={`Escrow ${moneyCompact(total)}`}
          busy={create.isPending}
          error={create.isError ? describeError(create.error) : null}
          onCancel={() => {
            setConfirming(false);
            create.reset();
          }}
          onConfirm={() =>
            create.mutate(
              {
                itemId,
                quantityKg: qty,
                minQuality: quality,
                unitPricePaise: price,
                deliveryWithinDays: days,
              },
              {
                onSuccess: () => {
                  setConfirming(false);
                  onDone();
                },
              },
            )
          }
        />
      ) : null}
    </form>
  );
}

export function ContractsPanel() {
  const close = useUiStore((s) => s.closePanel);
  const [tab, setTab] = useState<Tab>('open');
  return (
    <Panel
      title="Contracts"
      subtitle="Forward buy contracts with escrow"
      onClose={close}
      size="lg"
      testId="contracts-panel"
    >
      <Tabs
        label="Contract sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'open', label: 'Open contracts' },
          { id: 'mine', label: 'My contracts' },
          { id: 'create', label: 'Post a buy order' },
        ]}
      />
      {tab === 'open' ? <OpenContracts /> : null}
      {tab === 'mine' ? <MyContracts /> : null}
      {tab === 'create' ? <CreateContract onDone={() => setTab('mine')} /> : null}
    </Panel>
  );
}
