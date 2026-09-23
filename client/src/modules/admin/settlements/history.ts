import { segment, type Send } from '../../../core/http.js';
import type { RequestOptions } from '../../../types/common.js';
import type {
  Settlement,
  SettlementHistory,
  SettlementHistoryQuery,
} from '../../../types/settlement.js';

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

/**
 * One page of a pool's batches, newest first, however far back they go.
 *
 * The venue applies `type` and `status` itself, so a filtered page is a whole
 * page of matching batches rather than what survived a filter of one.
 */
export async function settlementHistory(
  send: Send,
  poolId: string,
  query: SettlementHistoryQuery = {},
  options?: RequestOptions,
): Promise<SettlementHistory> {
  return send<SettlementHistory>(
    {
      method: 'GET',
      path: `/v1/admin/pools/${segment(poolId)}/settlement-history`,
      query: { type: query.type, status: query.status, before: query.before, limit: query.limit },
    },
    options,
  );
}

/**
 * One batch, with its membership and its per-request fills.
 *
 * A manual batch's id is the idempotency key it was run with, so this is also
 * how a caller whose reply was lost finds out what that key made. Not found
 * means the key has made no batch yet.
 */
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
