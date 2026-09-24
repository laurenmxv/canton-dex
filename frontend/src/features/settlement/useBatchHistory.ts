import { useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAsync, type AsyncResult } from '../../app/useAsync';
import type {
  RequestType,
  SettlementHistory,
  SettlementStatus,
} from '../../lib/api/types';

/** The venue's own default page, asked for by name so every page reads the same length. */
const PAGE_SIZE = 25;

/** A batch that can still change: its outcome is not known yet. */
export const IN_FLIGHT_STATUSES: ReadonlySet<SettlementStatus> = new Set(['PREPARING', 'SUBMITTING', 'UNRESOLVED']);

export interface HistoryFilter {
  type: RequestType | null;
  status: SettlementStatus | null;
}

export interface BatchHistoryRead {
  page: AsyncResult<SettlementHistory>;
  filter: HistoryFilter;
  /** A new filter starts again from the newest page. */
  setFilter: (filter: HistoryFilter) => void;
  olderCursor: string | undefined;
  canShowNewer: boolean;
  showOlder: (cursor: string) => void;
  showNewer: () => void;
}

/**
 * Every batch one pool ran, a page at a time, newest first.
 *
 * The venue filters and pages it, so nothing old is cut off at a fixed length.
 * The newest page keeps being read, which is where a new batch appears, and so
 * does any page with a batch still moving.
 */
export function useBatchHistory(poolId: string): BatchHistoryRead {
  const client = useDexClient();
  const [filter, setFilter] = useState<HistoryFilter>({ type: null, status: null });
  const [trail, setTrail] = useState<readonly string[]>([]);
  const before = trail.at(-1);

  const page = useAsync(
    (signal) =>
      client.admin.settlements.history(
        poolId,
        {
          type: filter.type ?? undefined,
          status: filter.status ?? undefined,
          before,
          limit: PAGE_SIZE,
        },
        { signal },
      ),
    [client, poolId, filter.type, filter.status, before],
    {
      pollWhile: (history) =>
        before === undefined || history.items.some((batch) => IN_FLIGHT_STATUSES.has(batch.status)),
    },
  );

  return {
    page,
    filter,
    setFilter: (next) => {
      setFilter(next);
      setTrail([]);
    },
    olderCursor: page.data?.nextCursor ?? undefined,
    canShowNewer: trail.length > 0,
    showOlder: (cursor) => setTrail((seen) => [...seen, cursor]),
    showNewer: () => setTrail((seen) => seen.slice(0, -1)),
  };
}
