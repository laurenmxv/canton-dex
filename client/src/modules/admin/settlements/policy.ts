import { segment, type Send } from '../../../core/http.js';
import type { RequestOptions } from '../../../types/common.js';
import type { SettlementPolicy, UpdateSettlementPolicy } from '../../../types/settlement.js';

/**
 * This pool's stored batching settings.
 *
 * They belong to the pool and survive a restart, so this read, not anything the
 * browser kept, is what says how the pool is configured.
 */
export async function getSettlementPolicy(
  send: Send,
  poolId: string,
  options?: RequestOptions,
): Promise<SettlementPolicy> {
  return send<SettlementPolicy>(
    { method: 'GET', path: `/v1/admin/pools/${segment(poolId)}/settlement-policy` },
    options,
  );
}

/**
 * Saves this pool's settings and answers with what was committed.
 *
 * `expectedVersion` must be the version the caller last read. A stale one is
 * refused with a conflict rather than overwriting whoever saved in between, and
 * the refused settings stay unchanged.
 */
export async function updateSettlementPolicy(
  send: Send,
  poolId: string,
  input: UpdateSettlementPolicy,
  options?: RequestOptions,
): Promise<SettlementPolicy> {
  return send<SettlementPolicy>(
    {
      method: 'PUT',
      path: `/v1/admin/pools/${segment(poolId)}/settlement-policy`,
      body: input,
    },
    options,
  );
}
