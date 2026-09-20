import { segment, type Send } from '../../../core/http.js';
import type { RequestOptions } from '../../../types/common.js';
import type { RunSettlementInput, Settlement } from '../../../types/settlement.js';

/**
 * Settles the earliest eligible requests, up to this pool's configured size.
 *
 * It can settle fewer than the target, and it never reorders the queue to
 * reach it. `idempotencyKey` is what makes a repeated call safe: the same key
 * always answers with the same batch rather than starting a second one, so a
 * caller whose reply was lost must reuse it rather than mint a new one.
 */
export async function runSettlement(
  send: Send,
  poolId: string,
  input: RunSettlementInput,
  options?: RequestOptions,
): Promise<Settlement> {
  return send<Settlement>(
    { method: 'POST', path: `/v1/admin/pools/${segment(poolId)}/settlements`, body: input },
    options,
  );
}
