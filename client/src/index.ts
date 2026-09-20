export { createDexClient } from './client.js';
export type { DexClient } from './client.js';

export type { AdminApi, SettlementsApi } from './modules/admin/index.js';
export type { OnboardingApi } from './modules/onboarding/index.js';
export type { PoolsApi } from './modules/pools/index.js';
export type { SwapsApi } from './modules/swaps/index.js';
export type { TokensApi } from './modules/tokens/index.js';

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
  PoolHealth,
  PoolReserves,
  PoolSnapshot,
  RunSettlementInput,
  Settlement,
  SettlementFill,
  SettlementMonitoring,
  SettlementPolicy,
  SettlementQueueFilter,
  SettlementRequest,
  SettlementStatus,
  SettlementTrigger,
  UpdateSettlementPolicy,
} from './types/settlement.js';
export type {
  PrepareSwapInput,
  SubmitSignatureInput,
  Swap,
  SwapAction,
  SwapActivity,
  SwapActivityQuery,
  SwapDirection,
  SwapPreparation,
  SwapQuote,
  SwapQuoteInput,
  SwapStatus,
  SwapTerms,
} from './types/swap.js';
export type {
  FaucetPreparation,
  FaucetResult,
  FaucetStatus,
  TokenAmount,
  TokenBalance,
  TokenBalances,
} from './types/token.js';
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
