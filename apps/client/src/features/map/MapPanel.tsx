import type { ParcelSummaryDto, RegionMapResponse } from '@bh/contracts';
import { useMemo, useState } from 'react';
import { formatHa, humanize, moneyCompact } from '../../lib/format';
import { useUiStore } from '../../store/ui';
import { Chip, Segmented } from '../../ui/Bits';
import { Panel } from '../../ui/Panel';
import { EmptyState, SkeletonRows } from '../../ui/States';
import { CROP_META as CROP_LOOK } from '../../lib/cropMeta';
import { ownershipClass } from '../../world/ownership';

type Filter = 'all' | 'for_sale' | 'mine';
type Sort = 'id' | 'price' | 'area';

const STROKE: Record<string, string> = {
  mine: '#ffad33',
  ai: '#6f8fe0',
  forSale: '#f3eee2',
  reserved: '#8f8676',
  other: '#b3a68f',
};

function Minimap({
  map,
  classes,
  selectedId,
  onPick,
}: {
  map: RegionMapResponse;
  classes: Map<string, string>;
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  const h = map.region.halfSizeM;
  const path = (p: ParcelSummaryDto) =>
    `M${p.polygon.map((pt) => `${pt.x.toFixed(0)},${pt.y.toFixed(0)}`).join('L')}Z`;
  return (
    <svg
      className="bh-minimap"
      viewBox={`${-h} ${-h} ${h * 2} ${h * 2}`}
      role="img"
      aria-label="Region map: parcels coloured by ownership"
    >
      <path
        d={`M${map.river.points.map((p) => `${p.x},${p.y}`).join('L')}`}
        stroke="#4f8d95"
        strokeWidth={map.river.widthM * 1.6}
        fill="none"
        strokeLinecap="round"
      />
      {map.roads.map((r) => (
        <path
          key={r.id}
          d={`M${r.points.map((p) => `${p.x},${p.y}`).join('L')}`}
          stroke={r.kind === 'highway' || r.kind === 'district' ? '#5b5751' : '#9b6b45'}
          strokeWidth={Math.max(8, r.widthM * 2)}
          fill="none"
          strokeLinecap="round"
        />
      ))}
      {map.parcels.map((p) => {
        const cls = classes.get(p.id) ?? 'other';
        const fill = p.crop
          ? CROP_LOOK[p.crop.cropId].swatch
          : cls === 'forSale'
            ? '#7b7651'
            : '#6b5d43';
        return (
          <path
            key={p.id}
            className="parcel"
            d={path(p)}
            fill={fill}
            fillOpacity={0.85}
            stroke={p.id === selectedId ? '#ffcf5c' : STROKE[cls]}
            strokeDasharray={cls === 'forSale' ? '10 8' : undefined}
            onClick={() => onPick(p.id)}
          >
            <title>{`${p.id} · ${formatHa(p.areaHa)}`}</title>
          </path>
        );
      })}
      {map.markets.map((m) => (
        <g key={m.id}>
          <circle cx={m.x} cy={m.y} r={45} fill="#e8892c" stroke="#fff" strokeWidth={10} />
        </g>
      ))}
    </svg>
  );
}

export function MapPanel({
  map,
  aiIds,
  myCompanyId,
}: {
  map: RegionMapResponse | undefined;
  aiIds: ReadonlySet<string>;
  myCompanyId: string | null;
}) {
  const close = useUiStore((s) => s.closePanel);
  const select = useUiStore((s) => s.selectParcel);
  const selectedId = useUiStore((s) => s.selectedParcelId);
  const [filter, setFilter] = useState<Filter>('for_sale');
  const [sort, setSort] = useState<Sort>('price');
  const classes = useMemo(
    () =>
      new Map(
        (map?.parcels ?? []).map((p) => [
          p.id,
          ownershipClass(p, { myCompanyId, aiCompanyIds: aiIds }),
        ]),
      ),
    [map, myCompanyId, aiIds],
  );
  const rows = useMemo(() => {
    const list = (map?.parcels ?? []).filter((p) =>
      filter === 'all'
        ? true
        : filter === 'mine'
          ? classes.get(p.id) === 'mine'
          : p.status === 'for_sale' && classes.get(p.id) !== 'mine',
    );
    return list.sort((a, b) =>
      sort === 'price'
        ? (a.listPricePaise ?? Infinity) - (b.listPricePaise ?? Infinity)
        : sort === 'area'
          ? b.areaHa - a.areaHa
          : a.id.localeCompare(b.id),
    );
  }, [map, filter, sort, classes]);
  const pick = (id: string) => select(id, { focus: true });

  return (
    <Panel
      title={map?.region.name ?? 'Region map'}
      subtitle="Pick a parcel to inspect it and fly the camera there"
      onClose={close}
      testId="map-panel"
    >
      {!map ? (
        <SkeletonRows rows={8} />
      ) : (
        <div className="bh-stack">
          <Minimap map={map} classes={classes} selectedId={selectedId} onPick={pick} />
          <div className="bh-row between wrap">
            <Segmented
              label="Filter parcels"
              value={filter}
              onChange={setFilter}
              options={[
                { id: 'for_sale', label: 'For sale' },
                { id: 'mine', label: 'Mine' },
                { id: 'all', label: 'All' },
              ]}
            />
            <select
              className="bh-select"
              style={{ width: 130 }}
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              aria-label="Sort parcels"
            >
              <option value="price">Sort: price</option>
              <option value="area">Sort: area</option>
              <option value="id">Sort: id</option>
            </select>
          </div>
          {rows.length === 0 ? (
            <EmptyState title={filter === 'mine' ? 'You do not hold any land yet' : 'Nothing here'}>
              {filter === 'mine'
                ? 'Browse parcels for sale and buy or lease one to start farming.'
                : null}
            </EmptyState>
          ) : (
            <table className="bh-table" data-testid="parcel-list">
              <thead>
                <tr>
                  <th>Parcel</th>
                  <th>Soil · water</th>
                  <th className="num">Area</th>
                  <th className="num">Price</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr
                    key={p.id}
                    className={`clickable${p.id === selectedId ? ' selected' : ''}`}
                    onClick={() => pick(p.id)}
                    data-testid={`parcel-row-${p.id}`}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        pick(p.id);
                      }
                    }}
                  >
                    <td>
                      <strong>{p.id}</strong>{' '}
                      {p.isStarterPlot ? <Chip tone="success">starter</Chip> : null}
                      {p.crop ? (
                        <div className="faint" style={{ fontSize: 11 }}>
                          {CROP_LOOK[p.crop.cropId].label}
                        </div>
                      ) : null}
                    </td>
                    <td className="muted">
                      {humanize(p.soilTexture)} · {humanize(p.waterAccess)}
                    </td>
                    <td className="num">{formatHa(p.areaHa)}</td>
                    <td className="num">
                      {p.listPricePaise != null && p.status === 'for_sale'
                        ? moneyCompact(p.listPricePaise)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}
