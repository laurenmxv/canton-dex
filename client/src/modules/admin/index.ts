import type { Send } from '../../core/http.js';
import { createPoolProposal } from './create-pool-proposal.js';
import { getPoolProposal } from './get-pool-proposal.js';
import { listOnboardings } from './list-onboardings.js';
import { listPoolProposals } from './list-pool-proposals.js';
import { listPoolDetails } from './list-pools.js';
import { poolCreationOptions } from './pool-creation-options.js';
import { reviewOnboarding } from './review-onboarding.js';
import { withdrawPoolProposal } from './withdraw-pool-proposal.js';
import type { AdminApi } from './types.js';

export function createAdminApi(send: Send): AdminApi {
  return {
    listOnboardings: (options) => listOnboardings(send, options),
    reviewOnboarding: (onboardingId, input, options) =>
      reviewOnboarding(send, onboardingId, input, options),
    poolCreationOptions: (options) => poolCreationOptions(send, options),
    listPoolProposals: (options) => listPoolProposals(send, options),
    createPoolProposal: (input, options) => createPoolProposal(send, input, options),
    getPoolProposal: (proposalId, options) => getPoolProposal(send, proposalId, options),
    withdrawPoolProposal: (proposalId, options) => withdrawPoolProposal(send, proposalId, options),
    listPools: (options) => listPoolDetails(send, options),
  };
}

export type { AdminApi } from './types.js';
