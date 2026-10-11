import type { ItemId } from '@bh/domain';
import { useInventory, useWorld } from '../../api/queries';
import { CROP_META } from '../../lib/cropMeta';
import { formatKg, money, qualityLabel } from '../../lib/format';
import { useUiStore } from '../../store/ui';
import { Chip, ProgressBar, SectionTitle, Stat } from '../../ui/Bits';
import { Button } from '../../ui/Button';
import { Panel } from '../../ui/Panel';
import { EmptyState, QueryView } from '../../ui/States';

export function expiryTone(daysLeft: number): 'danger' | 'warning' | 'success' {
  if (daysLeft <= 3) return 'danger';
  if (daysLeft <= 10) return 'warning';
  return 'success';
}

export function InventoryPanel() {
  const close = useUiStore((s) => s.closePanel);
  const openSell = useUiStore((s) => s.openSell);
  const inv = useInventory();
  const world = useWorld();
  const today = world.data?.gameDay ?? 0;
  return (
    <Panel
      title="Inventory"
      subtitle="Produce in storage, by lot"
      onClose={close}
      size="lg"
      testId="inventory-panel"
    >
      <QueryView query={inv}>
        {(data) => {
          const used = data.lots.reduce((s, l) => s + l.quantityKg, 0);
          const cap = data.storageCapacityKg;
          return (
            <div className="bh-stack">
              <div className="bh-grid-3">
                <Stat label="Stored" value={formatKg(used)} />
                <Stat label="Capacity" value={cap > 0 ? formatKg(cap) : '—'} />
                <Stat
                  label="Value at cost"
                  value={money(data.lots.reduce((s, l) => s + l.costBasisPaise, 0))}
                />
              </div>
              {cap > 0 ? (
                <ProgressBar
                  value={used / cap}
                  tone={used / cap > 0.9 ? 'danger' : used / cap > 0.7 ? 'warning' : 'success'}
                  label="Storage used"
                />
              ) : null}
              {data.totals.length > 0 ? (
                <>
                  <SectionTitle>By crop</SectionTitle>
                  <table className="bh-table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="num">Total</th>
                        <th className="num">Available</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.totals.map((t) => (
                        <tr key={t.itemId}>
                          <td>
                            <span
                              className="bh-crop-swatch"
                              style={{
                                background: CROP_META[t.itemId].swatch,
                                display: 'inline-block',
                                width: 10,
                                height: 10,
                                marginRight: 8,
                              }}
                            />
                            {CROP_META[t.itemId].label}
                          </td>
                          <td className="num">{formatKg(t.quantityKg)}</td>
                          <td className="num">{formatKg(t.availableKg)}</td>
                          <td className="num">
                            <Button
                              size="sm"
                              disabled={t.availableKg <= 0}
                              onClick={() => openSell(t.itemId as ItemId)}
                              data-testid={`inventory-sell-${t.itemId}`}
                            >
                              Sell…
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}
              <SectionTitle>Lots</SectionTitle>
              {data.lots.length === 0 ? (
                <EmptyState icon="inventory" title="Storage is empty">
                  Harvested produce lands here. Perishables spoil after their shelf life.
                </EmptyState>
              ) : (
                <table className="bh-table" data-testid="inventory-lots">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Qty</th>
                      <th className="num">Reserved</th>
                      <th>Quality</th>
                      <th>Source</th>
                      <th className="num">Cost basis</th>
                      <th className="num">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.lots]
                      .sort((a, b) => a.expiresDay - b.expiresDay)
                      .map((l) => {
                        const left = l.expiresDay - today;
                        return (
                          <tr key={l.id}>
                            <td>{CROP_META[l.itemId].label}</td>
                            <td className="num">{formatKg(l.quantityKg)}</td>
                            <td className="num">
                              {l.reservedKg > 0 ? formatKg(l.reservedKg) : '—'}
                            </td>
                            <td>
                              <Chip
                                tone={
                                  l.quality >= 70
                                    ? 'success'
                                    : l.quality >= 45
                                      ? 'neutral'
                                      : 'warning'
                                }
                              >
                                {l.quality} · {qualityLabel(l.quality)}
                              </Chip>
                            </td>
                            <td className="muted">{l.source}</td>
                            <td className="num">{money(l.costBasisPaise)}</td>
                            <td className="num">
                              <span className={`tone-${expiryTone(left)}`}>
                                {left <= 0 ? 'Today' : `${left} d`}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              )}
            </div>
          );
        }}
      </QueryView>
    </Panel>
  );
}
