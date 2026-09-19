/**
 * The data the screens render.
 *
 * Onboarding, the pool catalogue and the caller's profile come from
 * `@canton-dex/client`, which owns the backend's JSON contract. The richer pool
 * and swap shapes below have no route behind them and belong to the demo.
 */

/** Basis points denominator, as the Daml fee arithmetic uses it. */
export const BPS_SCALE = 10_000;
/** Ceiling this webapp offers for a swap's slippage tolerance. */
export const MAX_SLIPPAGE_BPS = 5_000;
/** Fractional digits a Daml `Decimal` carries. */
export const DECIMAL_SCALE = 10;
/** ISO 3166-1 alpha-2, the form the backend accepts. */
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/** Renders an amount the way the ledger stores it, rejecting what it cannot hold. */
export function toDecimal(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError('Amount is out of range');
  return value.toFixed(DECIMAL_SCALE);
}

/** Blank is not zero. Every numeric form field goes through here. */
export function parseAmount(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------- what the backend serves

/**
 * The backend owns these shapes, so the SDK package defines them and the webapp
 * re-exports them here. Screens import from one path and this file adds nothing
 * of its own to the wire contract.
 */
export type {
  CreatePoolProposal,
  DocumentCategory,
  LedgerStep,
  LedgerStepStatus,
  Onboarding,
  OnboardingApplication,
  OnboardingApplicationInput,
  OnboardingDocument,
  OnboardingStatus,
  PartyMode,
  PartyPreparation,
  PartyPreparationInput,
  PartyStatus,
  PartySubmissionInput,
  InstrumentAdmin,
  InstrumentId,
  PoolAccount,
  PoolCreationOptions,
  PoolDetail,
  PoolProposal as PoolProposalRecord,
  PoolProposalStatus,
  PoolSummary,
  PoolTerms,
  Profile,
  ReviewDecisionInput,
  Role,
} from '@canton-dex/client';

/** Backend bounds on an application, mirrored so the form can warn early. */
export const applicationLimits = {
  legalNameMaxLength: 120,
  documentsMin: 1,
  documentsMax: 10,
  documentMaxLength: 200,
  fileNameMaxLength: 200,
  mediaTypeMaxLength: 120,
  approvedPoolsMax: 20,
} as const;

/** The party name an operator may approve with, as the backend accepts it. */
export const PARTY_HINT_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

// ------------------------------------------------- demo-only pools and swaps

export type PoolApprover = 'venueGovernance' | 'lpTokenIssuer' | 'poolHoldings';

export type ProposalStatus = 'AWAITING_APPROVALS' | 'READY' | 'CREATED';

export interface Instrument {
  id: string;
  symbol: string;
  admin: string;
}

interface PoolSettings {
  baseInstrumentId: string;
  quoteInstrumentId: string;
  feeBps: number;
  baseReserve: string;
  quoteReserve: string;
  lpTokenSupply: string;
}

export interface PoolApproval {
  approver: PoolApprover;
  party: string;
  approved: boolean;
  approvedAt: string | null;
}

export interface PoolProposal {
  proposalId: string;
  name: string;
  settings: PoolSettings;
  approvals: PoolApproval[];
  status: ProposalStatus;
  createdBy: string;
  createdAt: string;
  poolId: string | null;
}

export interface Pool {
  poolId: string;
  name: string;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  feeBps: number;
  baseReserve: string;
  quoteReserve: string;
  lpTokenSupply: string;
  createdAt: string;
}

/** Initial liquidity is derived by the venue, not supplied by the form. */
export interface CreateProposalInput {
  name: string;
  baseInstrumentId: string;
  quoteInstrumentId: string;
  feeBps: number;
  baseReserve: string;
  quoteReserve: string;
}

// --------------------------------------------------------------------- swaps

export type SwapDirection = 'BaseToQuote' | 'QuoteToBase';

export interface SwapQuote {
  quoteId: string;
  poolId: string;
  direction: SwapDirection;
  amountIn: string;
  expectedOut: string;
  feeAmount: string;
  minOut: string;
  slippageBps: number;
  quoteExpiresAt: string;
  settlementDeadline: string;
}

export interface SwapPreparation {
  preparationId: string;
  quoteId: string;
  /** Hash the wallet step displays before the caller approves. */
  commandDigest: string;
}

export interface SwapRequest {
  requestId: string;
  poolId: string;
  poolName: string;
  trader: string;
  direction: SwapDirection;
  amountIn: string;
  minOut: string;
  expectedOut: string;
  status: 'AWAITING_SETTLEMENT';
  submittedAt: string;
  settlementDeadline: string;
}

export interface QuoteInput {
  poolId: string;
  direction: SwapDirection;
  amountIn: string;
  slippageBps: number;
}

export type DexErrorCode = 'VALIDATION' | 'CONFLICT' | 'NOT_FOUND' | 'EXPIRED' | 'FORBIDDEN';

/**
 * A rule the venue enforced, named so a screen can offer the right recovery.
 *
 * Distinct from the SDK's `DexClientError`, which describes what happened to
 * an HTTP request. `lib/api/venue.ts` turns one into the other.
 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: DexErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DomainError';
  }
}

export function errorCode(error: unknown): DexErrorCode | undefined {
  return error instanceof DomainError ? error.code : undefined;
}
