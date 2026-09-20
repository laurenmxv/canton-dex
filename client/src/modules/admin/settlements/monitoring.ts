import type { Send } from '../../../core/http.js';
import type { RequestOptions } from '../../../types/common.js';
import type { SettlementMonitoring } from '../../../types/settlement.js';

/**
 * One pool's queue counts, blocked head, active batch and observed state.
 *
 * Every figure is an observation the venue made at a stated offset and time,
 * not a rolling metric, so a stale read is recognisable as stale.
 */
export async function getSettlementMonitoring(
  send: Send,
  poolId: string,
  options?: RequestOptions,
): Promise<SettlementMonitoring> {
  return send<SettlementMonitoring>(
    { method: 'GET', path: '/v1/admin/monitoring', query: { poolId } },
    options,
  );
}
