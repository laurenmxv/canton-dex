import type { RequestOptions } from '../../types/common.js';
import type { Onboarding, ReviewDecisionInput } from '../../types/onboarding.js';
import type {
  CreatePoolProposal,
  PoolCreationOptions,
  PoolDetail,
  PoolProposal,
} from '../../types/pool.js';

/** What an operator can do with the onboarding queue and the pool catalogue. */
export interface AdminApi {
  listOnboardings(options?: RequestOptions): Promise<Onboarding[]>;
  reviewOnboarding(
    onboardingId: string,
    input: ReviewDecisionInput,
    options?: RequestOptions,
  ): Promise<Onboarding>;
  poolCreationOptions(options?: RequestOptions): Promise<PoolCreationOptions>;
  listPoolProposals(options?: RequestOptions): Promise<PoolProposal[]>;
  createPoolProposal(input: CreatePoolProposal, options?: RequestOptions): Promise<PoolProposal>;
  getPoolProposal(proposalId: string, options?: RequestOptions): Promise<PoolProposal>;
  withdrawPoolProposal(proposalId: string, options?: RequestOptions): Promise<PoolProposal>;
  listPools(options?: RequestOptions): Promise<PoolDetail[]>;
}
