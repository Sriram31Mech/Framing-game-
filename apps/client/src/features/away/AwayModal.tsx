import { useState } from 'react';
import { useAwaySummary, useCompanyId } from '../../api/queries';
import { moneySigned } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';

const COLOR = {
  info: 'var(--info)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
} as const;

function dismissKey(companyId: string, toDay: number) {
  return `bh.away.${companyId}.${toDay}`;
}

function wasDismissed(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** "While you were away" — shown once per session per summary when there is something to report. */
export function AwayModal() {
  const companyId = useCompanyId();
  const away = useAwaySummary();
  const [closed, setClosed] = useState(false);
  const s = away.data;
  if (!companyId || !s || closed || s.highlights.length === 0) return null;
  const key = dismissKey(companyId, s.toDay);
  if (wasDismissed(key)) return null;
  const close = () => {
    try {
      sessionStorage.setItem(key, '1');
    } catch {
      // ignore
    }
    setClosed(true);
  };
  const days = s.toDay - s.fromDay;
  return (
    <Dialog
      title="While you were away"
      onClose={close}
      testId="away-modal"
      footer={
        <Button variant="primary" onClick={close} data-testid="away-close" data-autofocus>
          Back to the farm
        </Button>
      }
    >
      <div className="bh-stack">
        <div className="muted">
          {days} game day{days === 1 ? '' : 's'} passed (day {s.fromDay} → {s.toDay}). Cash changed
          by{' '}
          <strong className={s.cashChangePaise >= 0 ? 'tone-success' : 'tone-danger'}>
            {moneySigned(s.cashChangePaise)}
          </strong>
          .
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="bh-stack">
          {s.highlights.map((h, i) => (
            <li key={i} className="bh-row" style={{ alignItems: 'flex-start' }}>
              <Icon
                name={h.severity === 'success' ? 'check' : h.severity === 'info' ? 'info' : 'alert'}
                size={16}
                style={{ color: COLOR[h.severity], flex: 'none', marginTop: 2 }}
              />
              <span>{h.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
