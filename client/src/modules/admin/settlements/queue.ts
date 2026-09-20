import type { Send } from '../../../core/http.js';
import type { RequestOptions } from '../../../types/common.js';
import type { SettlementQueueFilter, SettlementRequest } from '../../../types/settlement.js';

/**
 * One pool's outstanding requests, in the order they arrived.
 *
 * The route defaults to `READY`, which is what the venue has recorded as
 * ready rather than what a batch would manage to settle. Pass `active` for
 * every request that has not reached a terminal status, including the blocked
 * head and everything already in flight. No other value is accepted.
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
