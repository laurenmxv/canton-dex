export { createDexClient } from './client.js';
export type { DexClient } from './client.js';

export type { AdminApi, SettlementsApi } from './modules/admin/index.js';
export type { LpApi } from './modules/lp/index.js';
export type { OnboardingApi } from './modules/onboarding/index.js';
export type { PoolsApi } from './modules/pools/index.js';
export type { SwapsApi } from './modules/swaps/index.js';
export type { TokensApi } from './modules/tokens/index.js';

export { DexClientError } from './errors.js';
export type { DexClientErrorKind, ProblemDetails } from './errors.js';

export type { DexClientConfig, RequestOptions } from './types/common.js';
export type { Activity, ActivityQuery, RequestType, TaggedRequest } from './types/activity.js';
export type {
  CreatePoolProposal,
  InstrumentId,
  MarketCandle,
  MarketData,
  MarketDataQuery,
  MarketTrade,
  PoolAccount,
  PoolCreationOptions,
  PoolDetail,
  PoolProposal,
  PoolProposalStatus,
  PoolProposalTerms,
  PoolSummary,
  PoolTerms,
  RegisteredInstrument,
} from './types/pool.js';
export type {
  DepositMode,
  DepositPreparation,
  DepositQuote,
  DepositQuoteInput,
  DepositRequest,
  DepositResult,
  DepositTerms,
  LiquidityAction,
  LiquidityActivity,
  LiquidityActivityQuery,
  LiquidityKind,
  LiquidityPreparation,
  LiquidityRequest,
  LiquidityStatus,
  LpPosition,
  LpPositions,
  PrepareDepositInput,
  PrepareWithdrawalInput,
  RecoveryEffect,
  RecoveryKind,
  WithdrawalPreparation,
  WithdrawalQuote,
  WithdrawalQuoteInput,
  WithdrawalRequest,
  WithdrawalResult,
  WithdrawalTerms,
} from './types/liquidity.js';
export type { Profile, Role } from './types/profile.js';
export type {
  PoolHealth,
  PoolReserves,
  PoolSnapshot,
  ProjectedPoolState,
  RunSettlementInput,
  Settlement,
  SettlementFill,
  SettlementHistory,
  SettlementHistoryQuery,
  SettlementMonitoring,
  SettlementOutputCheck,
  SettlementPolicy,
  SettlementPreview,
  SettlementPreviewStep,
  SettlementQueueFilter,
  SettlementRequest,
  SettlementRequestRef,
  SettlementSelection,
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
