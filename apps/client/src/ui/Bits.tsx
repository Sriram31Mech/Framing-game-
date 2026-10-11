import type { ReactNode } from 'react';
import { money, moneyCompact } from '../lib/format';

export type ChipTone =
  | 'excellent'
  | 'good'
  | 'fair'
  | 'poor'
  | 'unsuitable'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'neutral'
  | 'accent';

export function Chip({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: ChipTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`bh-chip chip-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function GradeChip({
  grade,
}: {
  grade: 'excellent' | 'good' | 'fair' | 'poor' | 'unsuitable';
}) {
  return <Chip tone={grade}>{grade.charAt(0).toUpperCase() + grade.slice(1)}</Chip>;
}

export function ProgressBar({
  value,
  tone,
  label,
}: {
  /** 0..1 */
  value: number;
  tone?: 'success' | 'danger' | 'warning' | 'info';
  label: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={`bh-progress${tone ? ` ${tone}` : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  title,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  title?: string;
  testId?: string;
}) {
  return (
    <div className="bh-stat" title={title}>
      <span className="label">{label}</span>
      <span className="value" data-testid={testId}>
        {value}
      </span>
      {sub ? <span className="sub">{sub}</span> : null}
    </div>
  );
}

/** Compact INR with the exact amount as a tooltip. */
export function Money({
  paise,
  compact = true,
  signed,
  className,
}: {
  paise: number;
  compact?: boolean;
  signed?: boolean;
  className?: string;
}) {
  const text = compact ? moneyCompact(paise) : money(paise);
  const tone = signed ? (paise > 0 ? 'tone-success' : paise < 0 ? 'tone-danger' : '') : '';
  return (
    <span className={[className, tone, 'num'].filter(Boolean).join(' ')} title={money(paise)}>
      {signed && paise > 0 ? '+' : ''}
      {text}
    </span>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: ReactNode; testId?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="bh-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
          data-testid={t.testId}
          type="button"
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="bh-segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Callout({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
}) {
  return (
    <div className={`bh-callout ${tone}`} role={tone === 'danger' ? 'alert' : 'note'}>
      <div>{children}</div>
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="bh-section-title">{children}</h3>;
}
