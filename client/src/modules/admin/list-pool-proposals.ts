import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { PoolProposal } from '../../types/pool.js';

/** Newest first, as the venue orders them. Operators only. */
export async function listPoolProposals(
  send: Send,
  options?: RequestOptions,
): Promise<PoolProposal[]> {
  return send<PoolProposal[]>({ method: 'GET', path: '/v1/admin/pool-proposals' }, options);
}
