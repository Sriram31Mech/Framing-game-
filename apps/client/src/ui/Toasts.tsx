import { useEffect } from 'react';
import { useToastStore, type Toast } from '../store/toasts';
import { IconButton } from './Button';
import { Icon, type IconName } from './Icon';

const ICONS: Record<Toast['severity'], IconName> = {
  info: 'info',
  success: 'check',
  warning: 'alert',
  danger: 'alert',
};

function ToastItem({ t }: { t: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  useEffect(() => {
    if (t.ttlMs <= 0) return;
    const id = setTimeout(() => dismiss(t.id), t.ttlMs);
    return () => clearTimeout(id);
  }, [t.id, t.ttlMs, dismiss]);
  return (
    <div
      className={`bh-toast bh-glass ${t.severity}`}
      role={t.severity === 'danger' ? 'alert' : 'status'}
    >
      <Icon name={ICONS[t.severity]} size={18} className={`tone-${t.severity}`} />
      <div className="grow">
        <div className="t-title">{t.title}</div>
        {t.body ? <div className="t-body">{t.body}</div> : null}
      </div>
      <IconButton
        icon="close"
        label="Dismiss notification"
        size={14}
        onClick={() => dismiss(t.id)}
      />
    </div>
  );
}

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="bh-toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}
