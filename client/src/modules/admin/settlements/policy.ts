import { segment, type Send } from '../../../core/http.js';
import type { RequestType } from '../../../types/activity.js';
import type { RequestOptions } from '../../../types/common.js';
import type { SettlementPolicy, UpdateSettlementPolicy } from '../../../types/settlement.js';

function policyPath(poolId: string, type: RequestType): string {
  return `/v1/admin/pools/${segment(poolId)}/settlement-policy/${segment(type)}`;
}

/**
 * One queue's stored batching settings.
 *
 * They belong to that queue of the pool and survive a restart, so this read,
 * not anything the browser kept, is what says how the queue is configured.
 */
export async function getSettlementPolicy(
  send: Send,
  poolId: string,
  type: RequestType,
  options?: RequestOptions,
): Promise<SettlementPolicy> {
  return send<SettlementPolicy>({ method: 'GET', path: policyPath(poolId, type) }, options);
}

/**
 * Saves one queue's settings and answers with what was committed.
 *
 * `expectedVersion` must be the version the caller last read for this queue.
 * A stale one is refused with a conflict rather than overwriting whoever saved
 * in between, and the refused settings stay unchanged. The other queues of
 * the pool keep their own settings and versions.
 */
export async function updateSettlementPolicy(
  send: Send,
  poolId: string,
  type: RequestType,
  input: UpdateSettlementPolicy,
  options?: RequestOptions,
): Promise<SettlementPolicy> {
  return send<SettlementPolicy>(
    { method: 'PUT', path: policyPath(poolId, type), body: input },
    options,
  );
}
