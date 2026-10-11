import type { ReactNode } from 'react';
import { IconButton } from './Button';

export function Panel({
  title,
  subtitle,
  onClose,
  size = 'md',
  actions,
  footer,
  children,
  testId,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  size?: 'md' | 'lg';
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className={`bh-panel bh-glass${size === 'lg' ? ' lg' : ''}`}
      aria-label={typeof title === 'string' ? title : undefined}
      data-testid={testId}
    >
      <header className="bh-panel-header">
        <div className="grow">
          <h2>{title}</h2>
          {subtitle ? <div className="subtitle">{subtitle}</div> : null}
        </div>
        <div className="bh-row">
          {actions}
          <IconButton icon="close" label="Close panel (Esc)" onClick={onClose} />
        </div>
      </header>
      <div className="bh-panel-body">{children}</div>
      {footer ? <footer className="bh-panel-footer">{footer}</footer> : null}
    </section>
  );
}
