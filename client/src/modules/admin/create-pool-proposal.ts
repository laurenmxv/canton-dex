import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { CreatePoolProposal, PoolProposal } from '../../types/pool.js';

/**
 * Propose a pool. The venue accepts the proposal and submits it; the answer
 * says where it got to, which may already be `PENDING` or still `SUBMITTING`.
 *
 * A pair that already has a pool or a pending proposal, in either direction,
 * answers 409. Nothing is retried on the caller's behalf.
 */
export async function createPoolProposal(
  send: Send,
  input: CreatePoolProposal,
  options?: RequestOptions,
): Promise<PoolProposal> {
  return send<PoolProposal>(
    { method: 'POST', path: '/v1/admin/pool-proposals', body: input },
    options,
  );
}
