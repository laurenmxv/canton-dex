import { useEffect, useRef } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAsync, useChange, type AsyncResult } from '../../app/useAsync';
import type { SettlementPreview } from '../../lib/api/types';
import type { Family } from './queueRows';
import { STALE_OBSERVATION_SECONDS } from './reserves';

export interface PreviewRead extends AsyncResult<SettlementPreview> {
  /** The pool, its policy or this queue has moved on since the preview was read, or it has aged. */
  stale: boolean;
}

interface Received {
  preview: SettlementPreview;
  /** The queue as this screen last read it when the preview was asked for. */
  queue: string | undefined;
  /** Timed on this machine, so a clock that differs from the venue's cannot age it. */
  receivedAt: number;
}

/**
 * The next batch of one queue, kept in step with what it was projected from.
 *
 * It is read again when the pool, the policy or the queue changes, and once
 * it has aged, but never polled blindly: every read checks each request
 * against the ledger. Until a new read lands, the old one counts as stale,
 * even when that read fails.
 */
export function usePreview({
  poolId,
  family,
  retryOf,
  poolVersion,
  policyVersion,
  queue,
  now,
}: {
  poolId: string;
  family: Family;
  retryOf: string | null;
  /** The pool version monitoring last observed, which a current preview matches. */
  poolVersion: string | undefined;
  policyVersion: number | undefined;
  /** This family's queue as a token that changes whenever a request in it does. */
  queue: string | undefined;
  now: number;
}): PreviewRead {
  const client = useDexClient();
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const read = useAsync(
    async (signal): Promise<Received> => {
      const basis = queueRef.current;
      const preview = await client.admin.settlements.preview(poolId, family, retryOf ?? undefined, {
        signal,
      });
      return { preview, queue: basis, receivedAt: Date.now() };
    },
    [client, poolId, family, retryOf],
  );
  const { data, reload } = read;

  useChange(poolVersion, reload);
  useChange(policyVersion === undefined ? undefined : String(policyVersion), reload);
  useChange(queue, reload);

  const aged = data !== undefined && now - data.receivedAt > STALE_OBSERVATION_SECONDS * 1000;
  useEffect(() => {
    if (aged) reload();
  }, [aged, reload]);

  const selection = data?.preview.selection;
  const stale =
    selection !== undefined &&
    (aged ||
      (poolVersion !== undefined && selection.stateVersion !== poolVersion) ||
      (policyVersion !== undefined && selection.policyVersion !== policyVersion) ||
      (data?.queue !== undefined && queue !== undefined && data.queue !== queue));

  return { data: data?.preview, error: read.error, loading: read.loading, reload, stale };
}
