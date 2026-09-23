import { useEffect, useRef, useState } from 'react';
import { useAsync, type AsyncResult } from '../../app/useAsync';
import type {
  LiquidityActivity,
  LiquidityActivityQuery,
  LiquidityRequest,
} from '../../lib/api/types';
import { hasOutstanding, resolved } from './terms';

const PAGE_SIZE = 20;

export interface RequestHistory<R extends LiquidityRequest> {
  activity: AsyncResult<LiquidityActivity<R>>;
  /** A sent request whose submission is not yet known to have taken effect. */
  recovering: string | undefined;
  /** Hands a sent request to the history, which reads its first page until the request resolves. */
  dispatched: (requestId: string | undefined) => void;
  olderCursor: string | undefined;
  canShowNewer: boolean;
  showOlder: (cursor: string) => void;
  showNewer: () => void;
}

/**
 * One kind of liquidity request, paged, since funds stay recoverable however
 * old a request is. A sent signature is spent, so an unknown outcome is read
 * back until the venue reports it rather than signed again.
 */
export function useRequestHistory<R extends LiquidityRequest>(
  load: (query: LiquidityActivityQuery, signal: AbortSignal) => Promise<LiquidityActivity<R>>,
  deps: readonly unknown[],
): RequestHistory<R> {
  const [trail, setTrail] = useState<readonly string[]>([]);
  const [recovering, setRecovering] = useState<string>();
  const recoveringRef = useRef(recovering);
  recoveringRef.current = recovering;

  const cursor = trail.at(-1);
  const activity = useAsync((signal) => load({ limit: PAGE_SIZE, cursor }, signal), [...deps, cursor], {
    pollWhile: (page) => hasOutstanding(page) || !resolved(page, recoveringRef.current),
  });

  useEffect(() => {
    if (recovering !== undefined && resolved(activity.data, recovering)) setRecovering(undefined);
  }, [activity.data, recovering]);

  return {
    activity,
    recovering,
    dispatched: (requestId) => {
      setRecovering(requestId);
      setTrail([]);
      activity.reload();
    },
    olderCursor: activity.data?.nextCursor ?? undefined,
    canShowNewer: trail.length > 0,
    showOlder: (next) => setTrail((seen) => [...seen, next]),
    showNewer: () => setTrail((seen) => seen.slice(0, -1)),
  };
}
