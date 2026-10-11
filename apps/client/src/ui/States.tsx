import type { ReactNode } from 'react';
import { describeError } from '../api/errors';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

export function Skeleton({
  height = 14,
  width = '100%',
  style,
}: {
  height?: number;
  width?: number | string;
  style?: React.CSSProperties;
}) {
  return <div className="bh-skeleton" style={{ height, width, ...style }} aria-hidden="true" />;
}

export function SkeletonRows({ rows = 5, height = 18 }: { rows?: number; height?: number }) {
  return (
    <div className="bh-stack" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} width={`${92 - ((i * 13) % 30)}%`} />
      ))}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const d = describeError(error);
  return (
    <div className="bh-state error" role="alert" style={compact ? { padding: 12 } : undefined}>
      <Icon name="alert" size={22} className="tone-danger" />
      <div className="title">{d.title}</div>
      <div style={{ fontSize: 12.5 }}>{d.message}</div>
      {onRetry ? (
        <Button size="sm" icon="refresh" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon = 'info',
  title,
  children,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="bh-state">
      <Icon name={icon} size={22} className="faint" />
      <div className="title">{title}</div>
      {children ? <div style={{ fontSize: 12.5 }}>{children}</div> : null}
    </div>
  );
}

interface QueryLike<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/** Renders skeleton / error-with-retry / content for a query. */
export function QueryView<T>({
  query,
  children,
  skeletonRows = 5,
}: {
  query: QueryLike<T>;
  children: (data: T) => ReactNode;
  skeletonRows?: number;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <SkeletonRows rows={skeletonRows} />;
}
