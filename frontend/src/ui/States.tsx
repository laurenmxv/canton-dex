import {
  Banner,
  Button,
  EmptyState as KitEmptyState,
} from '@openzeppelin/ui-components';
import type { ReactNode } from 'react';
import { TextLink } from './Link';
import type { AsyncResult } from '../app/useAsync';

/** The ring this venue spins while it waits, at text size. */
function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-4 flex-none animate-spin rounded-full border-2 border-current/25 border-t-current"
    />
  );
}

const SHELL = 'flex flex-col items-center gap-1.5 px-5 py-11 text-center text-sm text-muted-foreground';

export function Loading({ label }: { label: string }) {
  return (
    <div className={SHELL} role="status">
      <Spinner />
      <span>{label}…</span>
    </div>
  );
}

export function SkeletonRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="p-4">
      <span className="sr-only" role="status">
        {label}…
      </span>
      <div className="flex flex-col gap-2" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="bg-muted h-5 animate-pulse rounded-sm" />
        ))}
      </div>
    </div>
  );
}

/**
 * Nothing to show, and what to do about it.
 *
 * The kit draws the empty state. It takes no action of its own, and most of
 * this venue's empty screens exist to send the reader somewhere, so the action
 * sits under it.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center">
      <KitEmptyState
        size="small"
        icon={icon ?? <span aria-hidden="true">◇</span>}
        title={title}
        description={description ?? ''}
      />
      {action ? <div className="pb-6">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center" role="alert">
      <KitEmptyState
        size="small"
        icon={<span aria-hidden="true">!</span>}
        title="Something went wrong"
        description={error.message}
      />
      {onRetry ? (
        <div className="pb-6">
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
        <div className="mt-3 px-5">
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
    <Banner variant="warning" size="compact" title="Could not refresh" dismissible={false}>
      {error.message}{' '}
      <TextLink onClick={onRetry}>Try again</TextLink>
    </Banner>
  );
}
