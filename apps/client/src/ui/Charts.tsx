/**
 * Minimal inline SVG charts (no chart library): a sparkline and a labelled area chart.
 */
import { useId } from 'react';

export function Sparkline({
  values,
  width = 84,
  height = 24,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  label: string;
}) {
  if (values.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label={`${label}: not enough data`}>
        <line
          x1={0}
          x2={width}
          y1={height / 2}
          y2={height / 2}
          stroke="rgba(255,238,214,0.15)"
          strokeDasharray="2 3"
        />
      </svg>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 2) + 1;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const up = values[values.length - 1]! >= values[0]!;
  const color = up ? 'var(--success)' : 'var(--danger)';
  const last = pts[pts.length - 1]!.split(',');
  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={`${label}: ${up ? 'rising' : 'falling'} trend`}
    >
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={Number(last[0])} cy={Number(last[1])} r={2} fill={color} />
    </svg>
  );
}

/** Area chart for a daily series (e.g. cash). x = day, y = value; labels formatted by caller. */
export function AreaChart({
  points,
  height = 140,
  formatY,
  formatX,
  label,
}: {
  points: { x: number; y: number }[];
  height?: number;
  formatY: (v: number) => string;
  formatX: (v: number) => string;
  label: string;
}) {
  const gradId = useId();
  const width = 400;
  const padL = 52;
  const padR = 8;
  const padT = 8;
  const padB = 20;
  if (points.length < 2) {
    return (
      <div className="faint" style={{ fontSize: 12 }}>
        Not enough history yet.
      </div>
    );
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(...ys, 1);
  const sx = (x: number) => padL + ((x - minX) / (maxX - minX || 1)) * (width - padL - padR);
  const sy = (y: number) => padT + (1 - (y - minY) / (maxY - minY || 1)) * (height - padT - padB);
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
    .join('');
  const area = `${line}L${sx(maxX).toFixed(1)},${sy(minY).toFixed(1)}L${sx(minX).toFixed(1)},${sy(minY).toFixed(1)}Z`;
  const ticks = [minY, (minY + maxY) / 2, maxY];
  const last = points[points.length - 1]!;
  return (
    <svg
      className="bh-chart"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={width - padR} y1={sy(t)} y2={sy(t)} stroke="rgba(255,238,214,0.08)" />
          <text x={padL - 6} y={sy(t) + 3} textAnchor="end">
            {formatY(t)}
          </text>
        </g>
      ))}
      {minY < 0 ? (
        <line
          x1={padL}
          x2={width - padR}
          y1={sy(0)}
          y2={sy(0)}
          stroke="rgba(239,91,68,0.5)"
          strokeDasharray="3 3"
        />
      ) : null}
      <path d={area} fill={`url(#${gradId})`} />
      <path
        d={line}
        fill="none"
        stroke="var(--accent-strong)"
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      <circle cx={sx(last.x)} cy={sy(last.y)} r={3} fill="var(--accent-strong)" />
      <text x={padL} y={height - 4}>
        {formatX(minX)}
      </text>
      <text x={width - padR} y={height - 4} textAnchor="end">
        {formatX(maxX)}
      </text>
    </svg>
  );
}
