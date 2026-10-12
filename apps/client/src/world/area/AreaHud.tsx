/** Overlay for the area view: where you are, a legend, and the way back to the state map. */
import { useSegment } from '../../api/queries';
import { useUiStore } from '../../store/ui';
import { Button } from '../../ui/Button';
import { biomeFor } from './layout';

const BLURB = {
  hills: 'Misty hills, tea gardens and pines',
  delta: 'Paddy country, canals and coconut palms',
  dry: 'Red soil, millets and hardy scrub',
  plain: 'Mixed farmland',
} as const;

const LEGEND: [string, string][] = [
  ['Yours', '#d86f12'],
  ['For sale', '#2e8b47'],
  ['AI farm', '#7a52c7'],
  ['Other farmer', '#2f6fb8'],
  ['Ready', '#f2c14e'],
];

export function AreaHud({ segmentId }: { segmentId: string }) {
  const q = useSegment(segmentId);
  const d = q.data;
  return (
    <div className="area-hud bh-glass" data-testid="area-hud">
      <Button
        size="sm"
        icon="map"
        className="area-back"
        onClick={() => useUiStore.getState().exitArea()}
      >
        Back to Tamil Nadu
      </Button>
      <div className="area-title">
        <strong>{d?.segment.name ?? 'Loading…'}</strong>
        {d ? (
          <span className="muted">
            {d.district.name} ·{' '}
            {BLURB[biomeFor(`${d.district.zone} ${d.district.zoneLabel}`, d.district.id)]}
          </span>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon="info"
        onClick={() => useUiStore.setState({ panel: 'segment', selectedSegmentId: segmentId })}
      >
        Area details
      </Button>
      <div className="area-legend" aria-label="Plot colours">
        {LEGEND.map(([label, color]) => (
          <span key={label}>
            <i style={{ background: color }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
