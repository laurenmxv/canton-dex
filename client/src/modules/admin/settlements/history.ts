import { segment, type Send } from '../../../core/http.js';
import type { RequestOptions } from '../../../types/common.js';
import type { Settlement } from '../../../types/settlement.js';

/** Batches for one pool, or for every pool when no pool is named. */
export async function listSettlements(
  send: Send,
  poolId?: string,
  options?: RequestOptions,
): Promise<Settlement[]> {
  return send<Settlement[]>(
    { method: 'GET', path: '/v1/admin/settlements', query: { poolId } },
    options,
  );
}

/** One batch, with its frozen membership and its per-request fills. */
export async function getSettlement(
  send: Send,
  settlementId: string,
  options?: RequestOptions,
): Promise<Settlement> {
  return send<Settlement>(
    { method: 'GET', path: `/v1/admin/settlements/${segment(settlementId)}` },
    options,
  );
}
