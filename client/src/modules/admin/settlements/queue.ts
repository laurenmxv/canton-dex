import { segment, type Send } from '../../../core/http.js';
import type { RequestOptions } from '../../../types/common.js';
import type {
  SettlementQueueFilter,
  SettlementRequest,
  SettlementRequestRef,
} from '../../../types/settlement.js';

/**
 * One pool's queued requests, in the order they arrived. `status` selects the
 * part of the queue, as `SettlementQueueFilter` describes; the route defaults
 * to `READY`.
 */
export async function listSettlementRequests(
  send: Send,
  poolId: string,
  status?: SettlementQueueFilter,
  options?: RequestOptions,
): Promise<SettlementRequest[]> {
  return send<SettlementRequest[]>(
    { method: 'GET', path: '/v1/admin/settlement-requests', query: { poolId, status } },
    options,
  );
}

/**
 * Holds one request back from batches, or returns it to the tail of its queue.
 *
 * The hold is a scheduling choice the venue stores, not a ledger change: the
 * request keeps its allocations locked and its original deadline. Only a ready
 * or blocked request whose deadline has not passed can change, and not while
 * the pool has a batch in flight. A repeated change does nothing more.
 */
export async function setSettlementRequestDeferred(
  send: Send,
  poolId: string,
  request: SettlementRequestRef,
  deferred: boolean,
  options?: RequestOptions,
): Promise<void> {
  await send<void>(
    {
      method: 'PUT',
      path: `/v1/admin/pools/${segment(poolId)}/settlement-requests/${segment(request.type)}/${segment(request.requestId)}/deferred`,
      body: { deferred },
      empty: true,
    },
    options,
  );
}
