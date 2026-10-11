import type { ParcelSummaryDto } from '@bh/contracts';
import { useEffect, useRef } from 'react';
import { formatFraction, formatHa, humanize, moneyCompact } from '../../lib/format';
import { useUiStore } from '../../store/ui';
import { CROP_META as CROP_LOOK } from '../../lib/cropMeta';

const pointer = { x: 0, y: 0 };
let listener: (() => void) | null = null;

/** Called from the 3D pointer handler; moves the tooltip without a React render. */
export function setHoverPointer(x: number, y: number): void {
  pointer.x = x;
  pointer.y = y;
  listener?.();
}

function statusText(p: ParcelSummaryDto, myCompanyId: string | null): string {
  if (myCompanyId && (p.ownerCompanyId === myCompanyId || p.operatorCompanyId === myCompanyId)) {
    return p.status === 'leased'
      ? 'Leased by you'
      : p.status === 'for_sale'
        ? 'Yours · listed for sale'
        : 'Yours';
  }
  if (p.status === 'for_sale')
    return `For sale · ${p.listPricePaise != null ? moneyCompact(p.listPricePaise) : '—'}`;
  if (p.status === 'reserved') return 'Reserved starter plot';
  if (p.status === 'leased') return `Leased${p.ownerName ? ` from ${p.ownerName}` : ''}`;
  return p.ownerName ? `Owned by ${p.ownerName}` : 'Owned';
}

export function HoverTooltip({
  parcels,
  myCompanyId,
}: {
  parcels: Map<string, ParcelSummaryDto>;
  myCompanyId: string | null;
}) {
  const hovered = useUiStore((s) => s.hoveredParcelId);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listener = () => {
      if (!ref.current) return;
      const w = ref.current.offsetWidth;
      const x = pointer.x + 16 + w > window.innerWidth ? pointer.x - w - 12 : pointer.x + 16;
      ref.current.style.transform = `translate(${x}px, ${pointer.y + 16}px)`;
    };
    listener();
    return () => {
      listener = null;
    };
  }, [hovered]);
  const p = hovered ? parcels.get(hovered) : undefined;
  if (!p) return null;
  return (
    <div ref={ref} className="bh-tooltip bh-glass" role="tooltip">
      <div style={{ fontWeight: 700 }}>
        {p.id}{' '}
        <span className="muted" style={{ fontWeight: 500 }}>
          · {formatHa(p.areaHa)} · {humanize(p.soilTexture)}
        </span>
      </div>
      <div className="muted">{statusText(p, myCompanyId)}</div>
      {p.crop ? (
        <div className="muted">
          {CROP_LOOK[p.crop.cropId].label} ·{' '}
          {p.crop.status === 'ready'
            ? 'ready to harvest'
            : p.crop.status === 'failed'
              ? 'failed'
              : formatFraction(p.crop.progress)}
        </div>
      ) : null}
    </div>
  );
}
