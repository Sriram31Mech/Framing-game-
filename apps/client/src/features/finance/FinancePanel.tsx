import type { LoanDto, MachineryResponse } from '@bh/contracts';
import { MACHINERY, type MachineryType } from '@bh/domain';
import { useState } from 'react';
import { describeError } from '../../api/errors';
import { useBuyMachinery, useRepayLoan, useSellMachinery, useTakeLoan } from '../../api/mutations';
import { useLedger, useLoans, useMachinery, useOverview, useWorld } from '../../api/queries';
import { loanPreview, parseRupees, safe } from '../../lib/economics';
import {
  formatFraction,
  formatKg,
  formatRateBps,
  humanize,
  money,
  moneyCompact,
  relativeDay,
} from '../../lib/format';
import { useUiStore } from '../../store/ui';
import { Chip, Money, SectionTitle, Stat, Tabs } from '../../ui/Bits';
import { Button } from '../../ui/Button';
import { AreaChart } from '../../ui/Charts';
import { ConfirmDialog } from '../../ui/Dialog';
import { Panel } from '../../ui/Panel';
import { EmptyState, QueryView } from '../../ui/States';

type Tab = 'overview' | 'pnl' | 'loans' | 'machinery' | 'ledger';

function OverviewTab() {
  const overview = useOverview();
  const world = useWorld();
  const today = world.data?.gameDay ?? 0;
  return (
    <QueryView query={overview}>
      {(o) => {
        const b = o.balanceSheet;
        return (
          <div className="bh-stack">
            <div className="bh-grid-3">
              <Stat
                label="Valuation"
                value={<Money paise={o.valuationPaise} />}
                sub="assets − liabilities"
              />
              <Stat
                label="Cash"
                value={<Money paise={b.cashPaise} />}
                sub={b.escrowPaise ? `+ ${moneyCompact(b.escrowPaise)} in escrow` : undefined}
              />
              <Stat
                label={`Net (${o.profitAndLoss.periodDays} d)`}
                value={<Money paise={o.profitAndLoss.netPaise} signed />}
              />
            </div>
            <SectionTitle>Cash, last {o.cashSeries.length} days</SectionTitle>
            <AreaChart
              points={o.cashSeries.map((p) => ({ x: p.day, y: p.cashPaise }))}
              formatY={(v) => moneyCompact(Math.round(v))}
              formatX={(d) => `Day ${d}`}
              label="Daily cash balance"
            />
            <div className="bh-grid-2" style={{ alignItems: 'start' }}>
              <div>
                <SectionTitle>Assets</SectionTitle>
                <dl className="bh-kv">
                  <dt>Cash</dt>
                  <dd>{money(b.cashPaise)}</dd>
                  <dt>Escrow</dt>
                  <dd>{money(b.escrowPaise)}</dd>
                  <dt>Inventory</dt>
                  <dd>{money(b.inventoryValuePaise)}</dd>
                  <dt>Land</dt>
                  <dd>{money(b.landValuePaise)}</dd>
                  <dt>Machinery (book)</dt>
                  <dd>{money(b.machineryBookValuePaise)}</dd>
                  <dt className="total">Total assets</dt>
                  <dd className="total">{money(b.totalAssetsPaise)}</dd>
                </dl>
              </div>
              <div>
                <SectionTitle>Liabilities &amp; equity</SectionTitle>
                <dl className="bh-kv">
                  <dt>Loans outstanding</dt>
                  <dd>{money(b.loanOutstandingPaise)}</dd>
                  <dt className="total">Total liabilities</dt>
                  <dd className="total">{money(b.totalLiabilitiesPaise)}</dd>
                  <dt className="total">Equity</dt>
                  <dd className={`total ${b.equityPaise < 0 ? 'tone-danger' : ''}`}>
                    {money(b.equityPaise)}
                  </dd>
                </dl>
              </div>
            </div>
            <SectionTitle>Upcoming</SectionTitle>
            {o.upcoming.length === 0 ? (
              <span className="faint">Nothing scheduled.</span>
            ) : (
              <table className="bh-table">
                <tbody>
                  {o.upcoming.map((u, i) => (
                    <tr key={`${u.kind}-${u.entityId ?? i}-${u.day}`}>
                      <td className={u.day - today <= 3 ? 'tone-warning' : 'muted'}>
                        {relativeDay(u.day, today)}
                      </td>
                      <td>{u.label}</td>
                      <td className="num">{u.amountPaise != null ? money(u.amountPaise) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      }}
    </QueryView>
  );
}

function PnlTab() {
  const overview = useOverview();
  return (
    <QueryView query={overview}>
      {(o) => {
        const pl = o.profitAndLoss;
        return (
          <div className="bh-stack">
            <div className="bh-grid-3">
              <Stat label="Revenue" value={<Money paise={pl.revenuePaise} />} />
              <Stat label="Expenses" value={<Money paise={pl.expensesPaise} />} />
              <Stat label="Net" value={<Money paise={pl.netPaise} signed />} />
            </div>
            <SectionTitle>Trailing {pl.periodDays} days by account</SectionTitle>
            {pl.lines.length === 0 ? (
              <EmptyState title="No activity in this period" />
            ) : (
              <table className="bh-table" data-testid="pnl-lines">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {pl.lines.map((l) => (
                    <tr key={l.accountCode}>
                      <td>
                        {l.label} <span className="faint">· {l.accountCode}</span>
                      </td>
                      <td className="num">
                        <Money paise={l.amountPaise} compact={false} signed />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      }}
    </QueryView>
  );
}

function RepayForm({ loan }: { loan: LoanDto }) {
  const repay = useRepayLoan();
  const [text, setText] = useState(
    String(Math.ceil(Math.min(loan.emiPaise, loan.outstandingPaise) / 100)),
  );
  const amount = parseRupees(text);
  return (
    <form
      className="bh-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (amount && amount > 0)
          repay.mutate({
            loanId: loan.id,
            body: { amountPaise: Math.min(amount, loan.outstandingPaise) },
          });
      }}
    >
      <input
        className="bh-input num"
        style={{ width: 120 }}
        inputMode="decimal"
        aria-label="Repayment amount in rupees"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button size="sm" type="submit" busy={repay.isPending} disabled={!amount}>
        Repay
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setText(String(Math.ceil(loan.outstandingPaise / 100)))}
      >
        Full
      </Button>
    </form>
  );
}

function LoansTab() {
  const loans = useLoans();
  const overview = useOverview();
  const world = useWorld();
  const take = useTakeLoan();
  const today = world.data?.gameDay ?? 0;
  const [principalText, setPrincipalText] = useState('');
  const [term, setTerm] = useState(12);
  const [confirm, setConfirm] = useState(false);
  return (
    <QueryView query={loans}>
      {(data) => {
        const offer = data.offer;
        const principal = parseRupees(principalText) ?? 0;
        const preview = loanPreview(principal, offer.annualRateBps, term);
        const active = data.loans.filter((l) => l.status === 'active');
        const valid = principal > 0 && principal <= offer.maxPrincipalPaise && active.length < 5;
        const cash = overview.data?.company.cashPaise ?? 0;
        return (
          <div className="bh-stack">
            {data.loans.length === 0 ? (
              <EmptyState icon="coin" title="No loans">
                Borrow against your net assets to buy land or machinery.
              </EmptyState>
            ) : (
              <table className="bh-table" data-testid="loans-table">
                <thead>
                  <tr>
                    <th>Loan</th>
                    <th className="num">EMI</th>
                    <th className="num">Outstanding</th>
                    <th className="num">Next due</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.loans.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {money(l.principalPaise)} · {formatRateBps(l.annualRateBps)}
                        <div className="faint" style={{ fontSize: 11 }}>
                          {l.instalmentsPaid}/{l.termMonths} paid
                          {l.missedPayments > 0 ? (
                            <span className="tone-danger"> · {l.missedPayments} missed</span>
                          ) : null}
                          {l.status !== 'active' ? ` · ${humanize(l.status)}` : ''}
                        </div>
                      </td>
                      <td className="num">{money(l.emiPaise)}</td>
                      <td className="num">{money(l.outstandingPaise)}</td>
                      <td className="num muted">
                        {l.status === 'active' ? relativeDay(l.nextDueDay, today) : '—'}
                      </td>
                      <td className="num">
                        {l.status === 'active' ? <RepayForm loan={l} /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <SectionTitle>Borrow</SectionTitle>
            <div className="bh-card bh-stack">
              <div className="muted" style={{ fontSize: 12.5 }}>
                Offer: up to <strong>{money(offer.maxPrincipalPaise)}</strong> at{' '}
                {formatRateBps(offer.annualRateBps)}, up to {offer.maxTermMonths} monthly
                instalments (one every 30 days). Early repayment is free. Max 5 active loans.
              </div>
              <div className="bh-grid-2">
                <div className="bh-field">
                  <label htmlFor="loan-principal">Principal (₹)</label>
                  <input
                    id="loan-principal"
                    className="bh-input num"
                    inputMode="decimal"
                    value={principalText}
                    onChange={(e) => setPrincipalText(e.target.value)}
                    aria-invalid={principal > offer.maxPrincipalPaise}
                    data-testid="loan-principal"
                  />
                </div>
                <div className="bh-field">
                  <label htmlFor="loan-term">Term</label>
                  <select
                    id="loan-term"
                    className="bh-select"
                    value={term}
                    onChange={(e) => setTerm(Number(e.target.value))}
                  >
                    {Array.from({ length: offer.maxTermMonths }, (_, i) => i + 1)
                      .filter((m) => m <= 6 || m % 3 === 0)
                      .map((m) => (
                        <option key={m} value={m}>
                          {m} month{m > 1 ? 's' : ''}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              {preview ? (
                <dl className="bh-kv">
                  <dt>Monthly instalment (EMI)</dt>
                  <dd>
                    <strong>{money(preview.emiPaise)}</strong>
                  </dd>
                  <dt>Total repayable</dt>
                  <dd>{money(preview.totalRepayablePaise)}</dd>
                  <dt>Total interest</dt>
                  <dd className="tone-warning">
                    {money(preview.totalRepayablePaise - preview.principalPaise)}
                  </dd>
                </dl>
              ) : null}
              {principal > offer.maxPrincipalPaise ? (
                <div className="bh-error-text">Above your borrowing limit.</div>
              ) : null}
              <Button
                variant="primary"
                disabled={!valid || !preview}
                onClick={() => setConfirm(true)}
                data-testid="loan-take-button"
              >
                Review loan
              </Button>
            </div>
            {confirm && preview ? (
              <ConfirmDialog
                title={`Borrow ${moneyCompact(principal)}?`}
                description="Instalments are debited automatically every 30 days. A missed instalment (insufficient cash) pushes cash negative and starts the distress grace period."
                lines={[
                  { label: 'Principal received', value: money(principal), tone: 'success' },
                  { label: 'Rate', value: formatRateBps(offer.annualRateBps) },
                  { label: `EMI × ${term}`, value: money(preview.emiPaise) },
                  {
                    label: 'Interest cost',
                    value: money(preview.totalRepayablePaise - principal),
                    tone: 'warning',
                  },
                  { label: 'Cash after', value: money(cash + principal), total: true },
                ]}
                confirmLabel="Take loan"
                busy={take.isPending}
                error={take.isError ? describeError(take.error) : null}
                onCancel={() => {
                  setConfirm(false);
                  take.reset();
                }}
                onConfirm={() =>
                  take.mutate(
                    {
                      principalPaise: principal,
                      termMonths: term,
                      expectedRateBps: offer.annualRateBps,
                    },
                    {
                      onSuccess: () => {
                        setConfirm(false);
                        setPrincipalText('');
                      },
                    },
                  )
                }
              />
            ) : null}
          </div>
        );
      }}
    </QueryView>
  );
}

function effectsText(type: MachineryType): string[] {
  const e = safe(() => MACHINERY[type]?.effects, undefined);
  if (!e) return [];
  const out: string[] = [];
  const pct = (m: number) => formatFraction(1 - m);
  if (e.sowingLaborMultiplier !== undefined && e.sowingLaborMultiplier < 1)
    out.push(`Sowing labour −${pct(e.sowingLaborMultiplier)}`);
  if (e.harvestLaborMultiplier !== undefined && e.harvestLaborMultiplier < 1)
    out.push(`Harvest labour −${pct(e.harvestLaborMultiplier)}`);
  if (e.transportCostMultiplier !== undefined && e.transportCostMultiplier < 1)
    out.push(`Transport −${pct(e.transportCostMultiplier)}`);
  if (e.irrigationCostMultiplier !== undefined && e.irrigationCostMultiplier !== 1)
    out.push(`Irrigation cost ×${e.irrigationCostMultiplier}`);
  if (e.enablesDryIrrigation) out.push('Irrigate parcels without water access');
  if (e.shelfLifeMultiplier !== undefined && e.shelfLifeMultiplier > 1)
    out.push(`Shelf life ×${e.shelfLifeMultiplier}`);
  if (e.storageCapacityKg) out.push(`+${formatKg(e.storageCapacityKg)} storage`);
  return out;
}

function MachineryTab() {
  const machinery = useMachinery();
  const overview = useOverview();
  const buy = useBuyMachinery();
  const sell = useSellMachinery();
  const [buying, setBuying] = useState<MachineryResponse['catalog'][number] | null>(null);
  const cash = overview.data?.company.cashPaise ?? 0;
  return (
    <QueryView query={machinery}>
      {(data) => (
        <div className="bh-stack">
          <SectionTitle>Owned</SectionTitle>
          {data.owned.length === 0 ? (
            <span className="faint">No machinery yet — everything is hired labour.</span>
          ) : (
            <table className="bh-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">Paid</th>
                  <th className="num">Book value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.owned.map((m) => (
                  <tr key={m.id}>
                    <td>
                      {m.name} <span className="faint">· day {m.purchasedDay}</span>
                    </td>
                    <td className="num">{money(m.purchasePricePaise)}</td>
                    <td className="num">{money(m.bookValuePaise)}</td>
                    <td className="num">
                      <Button
                        size="sm"
                        variant="ghost"
                        busy={sell.isPending && sell.variables?.assetId === m.id}
                        onClick={() => sell.mutate({ assetId: m.id })}
                        title="Sold at a price based on current book value"
                      >
                        Sell
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <SectionTitle>Dealer catalogue</SectionTitle>
          <div className="bh-grid-2">
            {data.catalog.map((c) => (
              <article key={c.type} className="bh-card bh-stack" style={{ gap: 6 }}>
                <div className="bh-row between">
                  <strong>{c.name}</strong>
                  <span className="num">{moneyCompact(c.pricePaise)}</span>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {c.description}
                </div>
                <div className="bh-row wrap" style={{ gap: 4 }}>
                  {effectsText(c.type as MachineryType).map((t) => (
                    <Chip key={t} tone="success">
                      {t}
                    </Chip>
                  ))}
                </div>
                <div className="faint" style={{ fontSize: 11.5 }}>
                  Maintenance {money(c.maintenancePaisePerDay)}/day · depreciates daily
                </div>
                <Button
                  size="sm"
                  onClick={() => setBuying(c)}
                  data-testid={`machinery-buy-${c.type}`}
                >
                  Buy…
                </Button>
              </article>
            ))}
          </div>
          {buying ? (
            <ConfirmDialog
              title={`Buy ${buying.name}?`}
              description={buying.description}
              lines={[
                { label: 'Price', value: money(buying.pricePaise) },
                {
                  label: 'Maintenance (30 days)',
                  value: money(buying.maintenancePaisePerDay * 30),
                  tone: 'muted',
                },
                {
                  label: 'Cash after',
                  value: money(cash - buying.pricePaise),
                  total: true,
                  tone: cash < buying.pricePaise ? 'danger' : undefined,
                },
              ]}
              warnings={cash < buying.pricePaise ? ['Not enough cash.'] : []}
              confirmLabel={`Buy for ${moneyCompact(buying.pricePaise)}`}
              confirmDisabled={cash < buying.pricePaise}
              busy={buy.isPending}
              error={buy.isError ? describeError(buy.error) : null}
              onCancel={() => {
                setBuying(null);
                buy.reset();
              }}
              onConfirm={() =>
                buy.mutate(
                  { type: buying.type, expectedPricePaise: buying.pricePaise },
                  { onSuccess: () => setBuying(null) },
                )
              }
            />
          ) : null}
        </div>
      )}
    </QueryView>
  );
}

function LedgerTab() {
  const [account, setAccount] = useState('');
  const ledger = useLedger(account.trim() || null);
  const entries = ledger.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <div className="bh-stack">
      <input
        className="bh-input"
        placeholder="Filter by account code (e.g. cash)"
        value={account}
        onChange={(e) => setAccount(e.target.value)}
        aria-label="Filter by account code"
      />
      <QueryView query={{ ...ledger, data: ledger.data ? entries : undefined }}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No ledger entries" />
          ) : (
            <>
              <table className="bh-table" data-testid="ledger-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Description</th>
                    <th>Account</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id}>
                      <td className="muted">{e.gameDay}</td>
                      <td>
                        {e.description} <span className="faint">· {humanize(e.kind)}</span>
                      </td>
                      <td className="muted">{e.accountCode}</td>
                      <td className="num">
                        <Money paise={e.amountPaise} compact={false} signed />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ledger.hasNextPage ? (
                <Button
                  size="sm"
                  busy={ledger.isFetchingNextPage}
                  onClick={() => void ledger.fetchNextPage()}
                >
                  Load more
                </Button>
              ) : null}
            </>
          )
        }
      </QueryView>
    </div>
  );
}

export function FinancePanel() {
  const close = useUiStore((s) => s.closePanel);
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <Panel
      title="Finance"
      subtitle="Balance sheet, P&L, loans, machinery and ledger"
      onClose={close}
      size="lg"
      testId="finance-panel"
    >
      <Tabs
        label="Finance sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'pnl', label: 'Profit & loss' },
          { id: 'loans', label: 'Loans', testId: 'finance-tab-loans' },
          { id: 'machinery', label: 'Machinery', testId: 'finance-tab-machinery' },
          { id: 'ledger', label: 'Ledger', testId: 'finance-tab-ledger' },
        ]}
      />
      {tab === 'overview' ? <OverviewTab /> : null}
      {tab === 'pnl' ? <PnlTab /> : null}
      {tab === 'loans' ? <LoansTab /> : null}
      {tab === 'machinery' ? <MachineryTab /> : null}
      {tab === 'ledger' ? <LedgerTab /> : null}
    </Panel>
  );
}
