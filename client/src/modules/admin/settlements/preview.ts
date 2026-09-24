import { segment, type Send } from '../../../core/http.js';
import type { RequestType } from '../../../types/activity.js';
import type { RequestOptions } from '../../../types/common.js';
import type { SettlementPreview, SettlementRequestRef } from '../../../types/settlement.js';

function previewPath(poolId: string): string {
  return `/v1/admin/pools/${segment(poolId)}/settlement-preview`;
}

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
    { method: 'GET', path: previewPath(poolId), query: { type, retryOf } },
    options,
  );
}

/**
 * One queued request previewed alone, as a batch of one.
 *
 * It can come from anywhere in its queue, ahead of the requests before it,
 * and faces the same checks as any batch under its queue's policy. A request
 * that cannot run alone now, such as a deferred or expired one, fails as a
 * conflict.
 */
export async function previewSettlementRequest(
  send: Send,
  poolId: string,
  request: SettlementRequestRef,
  options?: RequestOptions,
): Promise<SettlementPreview> {
  return send<SettlementPreview>(
    {
      method: 'GET',
      path: previewPath(poolId),
      query: { type: request.type, requestId: request.requestId },
    },
    options,
  );
}
