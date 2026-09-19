import type { PoolProposal } from '../../lib/api/types';

/** Every required approver must sign before a proposal can become a pool. */
export function approvalCount(proposal: PoolProposal): { approved: number; required: number } {
  return {
    approved: proposal.approvals.filter((approval) => approval.approved).length,
    required: proposal.approvals.length,
  };
}
