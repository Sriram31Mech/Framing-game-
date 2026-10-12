/**
 * Search Tamil Nadu by district or place name and jump to areas with land for sale.
 */
import type { RegionMapResponse } from '@bh/contracts';
import { useMemo, useState } from 'react';
import { moneyCompact } from '../../lib/format';
import { useUiStore } from '../../store/ui';
import { Panel } from '../../ui/Panel';

export function FindLandPanel({ map }: { map?: RegionMapResponse }) {
  const [q, setQ] = useState('');
  const [onlyForSale, setOnlyForSale] = useState(true);
  const [sort, setSort] = useState<'name' | 'cheapest'>('name');
  const close = useUiStore((s) => s.closePanel);
  const selectSegment = useUiStore((s) => s.selectSegment);

  const groups = useMemo(() => {
    if (!map) return [];
    const needle = q.trim().toLowerCase();
    const groups = map.districts
      .map((d) => {
        const districtHit =
          !needle || d.name.toLowerCase().includes(needle) || d.tamilName.includes(q.trim());
        const segments = map.segments
          .filter((s) => s.districtId === d.id)
          .filter((s) => !onlyForSale || s.holdingsForSale > 0 || s.mine > 0)
          .filter((s) => districtHit || s.name.toLowerCase().includes(needle))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { d, segments };
      })
      .filter((g) => g.segments.length > 0);
    if (sort === 'cheapest') {
      const cheapest = (segs: (typeof groups)[number]['segments']) =>
        Math.min(...segs.map((s) => s.minPricePaise ?? Number.POSITIVE_INFINITY));
      for (const g of groups) {
        g.segments.sort((a, b) => (a.minPricePaise ?? Infinity) - (b.minPricePaise ?? Infinity));
      }
      return groups.sort((a, b) => cheapest(a.segments) - cheapest(b.segments));
    }
    return groups.sort((a, b) => a.d.name.localeCompare(b.d.name));
  }, [map, q, onlyForSale, sort]);

  return (
    <Panel
      title="Find land"
      subtitle="Tamil Nadu · 32 districts · 234 areas"
      onClose={close}
      testId="find-land"
    >
      <div className="bh-stack">
        <input
          className="bh-input"
          placeholder="Search a district or town — e.g. Thanjavur, Pollachi"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search places"
          autoFocus
        />
        <label className="bh-row" style={{ fontSize: 13 }}>
          Sort
          <select
            className="bh-input"
            style={{ width: 'auto' }}
            value={sort}
            onChange={(e) => setSort(e.target.value as 'name' | 'cheapest')}
            data-testid="find-sort"
          >
            <option value="name">District A–Z</option>
            <option value="cheapest">Cheapest land first</option>
          </select>
        </label>
        <label className="bh-row" style={{ fontSize: 13 }}>
          <input
            type="checkbox"
            checked={onlyForSale}
            onChange={(e) => setOnlyForSale(e.target.checked)}
          />
          Only areas with land for sale
        </label>
        {groups.map(({ d, segments }) => (
          <section key={d.id} className="tn-find-group">
            <h3 className="tn-h3">
              {d.name}{' '}
              <span lang="ta" className="muted">
                {d.tamilName}
              </span>
            </h3>
            <div className="muted" style={{ fontSize: 12 }}>
              {d.zone} · {d.annualRainMm} mm rain · {d.knownFor.slice(0, 3).join(', ')}
            </div>
            <ul className="tn-find-list">
              {segments.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => selectSegment(s.id, { focus: true })}>
                    <span>{s.name}</span>
                    <span className="muted">
                      {s.mine > 0 ? `${s.mine} yours · ` : ''}
                      {s.holdingsForSale} for sale
                      {s.minPricePaise ? ` · from ${moneyCompact(s.minPricePaise)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {map && groups.length === 0 ? <p className="muted">No matching areas.</p> : null}
      </div>
    </Panel>
  );
}
