import { segment, type Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { PoolProposal } from '../../types/pool.js';

/**
 * Withdraw a proposal the venue is still holding.
 *
 * Only a `PENDING` proposal can be withdrawn, and a pool that exists cannot be
 * undone this way. Repeating a confirmed withdrawal returns the same record.
 */
export async function withdrawPoolProposal(
  send: Send,
  proposalId: string,
  options?: RequestOptions,
): Promise<PoolProposal> {
  return send<PoolProposal>(
    {
      method: 'POST',
      path: `/v1/admin/pool-proposals/${segment(proposalId)}/withdraw`,
      body: {},
    },
    options,
  );
}
