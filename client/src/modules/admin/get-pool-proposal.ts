import { segment, type Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { PoolProposal } from '../../types/pool.js';

export async function getPoolProposal(
  send: Send,
  proposalId: string,
  options?: RequestOptions,
): Promise<PoolProposal> {
  return send<PoolProposal>(
    { method: 'GET', path: `/v1/admin/pool-proposals/${segment(proposalId)}` },
    options,
  );
}
