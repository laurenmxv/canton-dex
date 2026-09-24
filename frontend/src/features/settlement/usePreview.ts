import { useEffect, useRef } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAsync, useChange, type AsyncResult } from '../../app/useAsync';
import type { SettlementPreview, SettlementRequestRef } from '../../lib/api/types';
import type { Family } from './queueRows';
import { STALE_OBSERVATION_SECONDS } from './reserves';

export interface PreviewRead extends AsyncResult<SettlementPreview> {
  /** The pool, this queue or its policy has moved on since the preview was read, or it has aged. */
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
 * The next batch of one queue, or one request alone, kept in step with what
 * it was projected from.
 *
 * It is read again when the pool, the queue or its policy changes, and once
 * it has aged, but never polled blindly: every read checks each request
 * against the ledger. Until a new read lands, the old one counts as stale,
 * even when that read fails. Another queue's policy is not part of it.
 */
export function usePreview({
  poolId,
  family,
  retryOf,
  request,
  enabled = true,
  poolVersion,
  policyVersion,
  queue,
  now,
}: {
  poolId: string;
  /** The queue previewed, which is the request's own when there is one. */
  family: Family;
  retryOf: string | null;
  /** One request to preview alone, in place of its queue's next batch. */
  request?: SettlementRequestRef;
  /** False while there is nothing to preview. The last read is then dropped. */
  enabled?: boolean;
  /** The pool version monitoring last observed, which a current preview matches. */
  poolVersion: string | undefined;
  /** The previewed queue's newest confirmed policy version. */
  policyVersion: number | undefined;
  /** What was previewed, as a token that changes whenever a request in it does. */
  queue: string | undefined;
  now: number;
}): PreviewRead {
  const client = useDexClient();
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const read = useAsync(
    async (signal): Promise<Received> => {
      const basis = queueRef.current;
      const preview = request
        ? await client.admin.settlements.previewRequest(poolId, request, { signal })
        : await client.admin.settlements.preview(poolId, family, retryOf ?? undefined, { signal });
      return { preview, queue: basis, receivedAt: Date.now() };
    },
    [client, poolId, family, retryOf, request?.type, request?.requestId],
    { enabled },
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
