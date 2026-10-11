/**
 * Display formatting. Money always goes through the domain `formatInr` so the client
 * shows exactly the same Indian-format strings as notifications and server text.
 */
import { formatInr } from '@bh/domain';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const intFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const oneDp = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});
const twoDp = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

/** Exact rupee amount, e.g. "₹1,23,456.78". */
export function money(paise: number): string {
  if (!Number.isFinite(paise)) return '—';
  return formatInr(Math.round(paise));
}

/** Compact rupee amount, e.g. "₹1.23 L". */
export function moneyCompact(paise: number): string {
  if (!Number.isFinite(paise)) return '—';
  return formatInr(Math.round(paise), { compact: true });
}

/** Signed money with an explicit plus for gains. */
export function moneySigned(paise: number, compact = false): string {
  const s = compact ? moneyCompact(Math.abs(paise)) : money(Math.abs(paise));
  if (paise > 0) return `+${s}`;
  if (paise < 0) return `−${s}`;
  return s;
}

/** Unit price per kg. */
export function perKg(paisePerKg: number): string {
  return `${money(paisePerKg)}/kg`;
}

export function formatInt(n: number): string {
  return intFmt.format(Math.round(n));
}

/** Quantities: kg below one tonne, tonnes above (Indian digit grouping). */
export function formatKg(kg: number): string {
  if (!Number.isFinite(kg)) return '—';
  if (Math.abs(kg) < 1000) return `${intFmt.format(Math.round(kg))} kg`;
  const t = kg / 1000;
  return `${Math.abs(t) < 100 ? oneDp.format(t) : intFmt.format(Math.round(t))} t`;
}

/** Area in hectares, two decimals. */
export function formatHa(ha: number): string {
  return `${twoDp.format(ha)} ha`;
}

/** 0..1 fraction → "42%". */
export function formatFraction(f: number, digits = 0): string {
  if (!Number.isFinite(f)) return '—';
  return `${(f * 100).toFixed(digits)}%`;
}

/** A value already expressed in percent → "+3.2%" (always signed). */
export function formatSignedPct(pct: number, digits = 1): string {
  if (!Number.isFinite(pct)) return '—';
  const v = Number(pct.toFixed(digits));
  if (v > 0) return `+${v.toFixed(digits)}%`;
  if (v < 0) return `−${Math.abs(v).toFixed(digits)}%`;
  return `${(0).toFixed(digits)}%`;
}

/** Basis points → "11.50% p.a.". */
export function formatRateBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}% p.a.`;
}

export function formatDays(n: number): string {
  const v = Math.round(n);
  return `${v} ${Math.abs(v) === 1 ? 'day' : 'days'}`;
}

/** Relative phrase for a game day vs today: "today", "in 3 days", "2 days ago". */
export function relativeDay(day: number, today: number): string {
  const d = day - today;
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}

/** Milliseconds → "m:ss" (clamped at zero). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** 1..12 → "Jan". */
export function monthName(month: number, long = false): string {
  const list = long ? MONTHS_LONG : MONTHS;
  return list[(((month - 1) % 12) + 12) % 12] ?? '';
}

/** "sandy_loam" → "Sandy loam". */
export function humanize(id: string): string {
  const s = id.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Quality 0..100 → letter-ish label. */
export function qualityLabel(q: number): string {
  if (q >= 85) return 'Premium';
  if (q >= 70) return 'Grade A';
  if (q >= 50) return 'Grade B';
  if (q >= 30) return 'Grade C';
  return 'Low';
}

export function seasonLabel(season: 'kharif' | 'rabi' | 'zaid'): string {
  return season === 'kharif' ? 'Kharif' : season === 'rabi' ? 'Rabi' : 'Zaid';
}
