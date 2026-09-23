import { segment, type Send } from '../../../core/http.js';
import type { RequestType } from '../../../types/activity.js';
import type { RequestOptions } from '../../../types/common.js';
import type { SettlementPreview } from '../../../types/settlement.js';

/**
 * The batch one queue would run next, checked request by request against the
 * pool's current state.
 *
 * It is a read: it holds nothing and starts nothing. `retryOf` previews what a
 * rejected or cancelled batch still has eligible, instead of the head of the
 * queue. A preview the venue cannot compute fails as an error, never as steps
 * nobody checked.
 */
export async function previewSettlement(
  send: Send,
  poolId: string,
  type: RequestType,
  retryOf?: string,
  options?: RequestOptions,
): Promise<SettlementPreview> {
  return send<SettlementPreview>(
    {
      method: 'GET',
      path: `/v1/admin/pools/${segment(poolId)}/settlement-preview`,
      query: { type, retryOf },
    },
    options,
  );
}
