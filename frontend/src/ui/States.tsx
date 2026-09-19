import type { ReactNode } from 'react';
import type { AsyncResult } from '../app/useAsync';
import { Callout } from './Badge';
import { Button } from './Button';

export function Loading({ label }: { label: string }) {
  return (
    <div className="empty" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{label}…</span>
    </div>
  );
}

export function SkeletonRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div style={{ padding: '1rem' }}>
      <span className="sr-only" role="status">
        {label}…
      </span>
      <div className="stack-sm" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="skeleton" style={{ height: '1.25rem' }} />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  icon = '◇',
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">
        {icon}
      </span>
      <p className="empty-title">{title}</p>
      {description ? <p>{description}</p> : null}
      {action ? <div style={{ marginTop: '0.75rem' }}>{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="empty" role="alert">
      <span className="empty-icon" aria-hidden="true">
        !
      </span>
      <p className="empty-title">Something went wrong</p>
      <p>{error.message}</p>
      {onRetry ? (
        <div style={{ marginTop: '0.75rem' }}>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Renders the loading, error, empty and loaded states of one request.
 *
 * Data already on screen survives a later failure, so a poll that fails once
 * reports itself without wiping what the reader was looking at.
 */
export function AsyncSection<T>({
  result,
  label,
  empty,
  rows,
  children,
}: {
  result: AsyncResult<T>;
  label: string;
  empty?: ReactNode;
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  const { data, error, loading, reload } = result;

  if (data === undefined) {
    if (error) return <ErrorState error={error} onRetry={reload} />;
    if (loading) return <SkeletonRows rows={rows} label={label} />;
    return null;
  }

  const isEmpty = Array.isArray(data) && data.length === 0;
  return (
    <>
      {error ? (
        <div style={{ padding: '0 1.25rem', marginTop: '0.75rem' }}>
          <RefreshFailure error={error} onRetry={reload} />
        </div>
      ) : null}
      {isEmpty && empty ? empty : children(data)}
    </>
  );
}

/**
 * A refresh that failed while data is already on screen. The data stays, and
 * the reader is given a way back rather than a page reload.
 */
export function RefreshFailure({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <Callout tone="warning" title="Could not refresh">
      {error.message}{' '}
      <button type="button" className="table-link" onClick={onRetry}>
        Try again
      </button>
    </Callout>
  );
}
