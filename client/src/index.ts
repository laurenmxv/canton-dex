export { createDexClient } from './client.js';
export type { DexClient } from './client.js';

export type { AdminApi } from './modules/admin/index.js';
export type { OnboardingApi } from './modules/onboarding/index.js';
export type { PoolsApi } from './modules/pools/index.js';

export { DexClientError } from './errors.js';
export type { DexClientErrorKind, ProblemDetails } from './errors.js';

export type { DexClientConfig, RequestOptions } from './types/common.js';
export type {
  CreatePoolProposal,
  InstrumentAdmin,
  InstrumentId,
  PoolAccount,
  PoolCreationOptions,
  PoolDetail,
  PoolProposal,
  PoolProposalStatus,
  PoolSummary,
  PoolTerms,
} from './types/pool.js';
export type { Profile, Role } from './types/profile.js';
export type {
  DocumentCategory,
  LedgerStep,
  LedgerStepStatus,
  Onboarding,
  OnboardingApplication,
  OnboardingApplicationInput,
  OnboardingDocument,
  OnboardingReview,
  OnboardingStatus,
  PartyMode,
  PartyPreparation,
  PartyPreparationInput,
  PartyStatus,
  PartySubmissionInput,
  ReviewDecisionInput,
  ReviewDecisionValue,
} from './types/onboarding.js';
