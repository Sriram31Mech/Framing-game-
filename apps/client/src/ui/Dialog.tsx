import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { Icon } from './Icon';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide,
  testId,
  dismissible = true,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  testId?: string;
  /** Allow Esc / backdrop click to close (disable while a command is in flight). */
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first =
      ref.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    return () => prev?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (dismissible) onClose();
      return;
    }
    if (e.key === 'Tab' && ref.current) {
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div
      className="bh-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissible) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={ref}
        className={`bh-dialog bh-scroll${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
        </header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export interface CostLine {
  label: string;
  value: string;
  tone?: 'success' | 'danger' | 'warning' | 'muted';
  total?: boolean;
  hint?: string;
}

/**
 * Confirmation for expensive / irreversible actions. Explains costs and risks BEFORE the player
 * commits; shows server errors inline (and stays open) so the player can re-review.
 */
export function ConfirmDialog({
  title,
  description,
  lines,
  warnings = [],
  confirmLabel,
  danger,
  busy,
  error,
  onConfirm,
  onCancel,
  children,
  confirmDisabled,
}: {
  title: string;
  description?: ReactNode;
  lines: CostLine[];
  warnings?: string[];
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: { title: string; message: string } | null;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
  confirmDisabled?: boolean;
}) {
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      testId="confirm-dialog"
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy} data-testid="confirm-cancel">
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            busy={busy}
            disabled={confirmDisabled}
            data-testid="confirm-ok"
            data-autofocus
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="bh-stack">
        {description ? <div className="muted">{description}</div> : null}
        {children}
        {lines.length > 0 ? (
          <dl className="bh-kv" aria-label="Cost breakdown">
            {lines.map((l) => (
              <div key={l.label} style={{ display: 'contents' }}>
                <dt className={l.total ? 'total' : undefined} title={l.hint}>
                  {l.label}
                </dt>
                <dd
                  className={[
                    l.total ? 'total' : '',
                    l.tone ? (l.tone === 'muted' ? 'muted' : `tone-${l.tone}`) : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {l.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {warnings.map((w) => (
          <div key={w} className="bh-callout warning" role="note">
            <Icon name="alert" size={16} className="tone-warning" />
            <span>{w}</span>
          </div>
        ))}
        {error ? (
          <div className="bh-callout danger" role="alert">
            <Icon name="alert" size={16} className="tone-danger" />
            <div>
              <strong>{error.title}.</strong> {error.message}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
