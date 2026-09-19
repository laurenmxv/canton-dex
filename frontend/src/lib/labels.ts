import { accessStepPoolId, ATTESTATION_STEP } from './api/ledger-steps';
import type {
  DocumentCategory,
  Instrument,
  LedgerStepStatus,
  OnboardingStatus,
  PartyMode,
  PartyStatus,
  Pool,
  PoolApprover,
  PoolProposalStatus,
  PoolSummary,
  ProposalStatus,
  Role,
  SwapDirection,
  SwapRequest,
} from './api/types';

export type Tone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

export const roleLabels: Record<Role, string> = {
  TRADER: 'Trader',
  OPERATOR: 'Operator',
};

export const onboardingStatusLabels: Record<OnboardingStatus, string> = {
  AWAITING_REVIEW_AND_PARTY: 'Awaiting review and party',
  AWAITING_REVIEW: 'Awaiting review',
  AWAITING_PARTY: 'Awaiting party registration',
  REJECTED: 'Rejected',
  PARTY_SUBMITTING: 'Registering party',
  PARTY_UNRESOLVED: 'Confirming registration',
  LEDGER_PENDING: 'Ledger pending',
  LEDGER_SUBMITTING: 'Ledger submitting',
  LEDGER_UNRESOLVED: 'Confirming on the ledger',
  COMPLETED: 'Completed',
};

export const onboardingStatusTones: Record<OnboardingStatus, Tone> = {
  AWAITING_REVIEW_AND_PARTY: 'neutral',
  AWAITING_REVIEW: 'neutral',
  AWAITING_PARTY: 'neutral',
  REJECTED: 'danger',
  PARTY_SUBMITTING: 'progress',
  PARTY_UNRESOLVED: 'warning',
  LEDGER_PENDING: 'progress',
  LEDGER_SUBMITTING: 'progress',
  LEDGER_UNRESOLVED: 'warning',
  COMPLETED: 'success',
};

export const ledgerStepTones: Record<LedgerStepStatus, Tone> = {
  PENDING: 'neutral',
  SUBMITTING: 'progress',
  CONFIRMED: 'success',
  UNRESOLVED: 'warning',
};

export const approverLabels: Record<PoolApprover, string> = {
  venueGovernance: 'Venue governance',
  lpTokenIssuer: 'LP token issuer',
  poolHoldings: 'Pool holdings',
};

export const proposalStatusLabels: Record<ProposalStatus, string> = {
  AWAITING_APPROVALS: 'Awaiting approvals',
  READY: 'Ready to create',
  CREATED: 'Pool created',
};

export const proposalStatusTones: Record<ProposalStatus, Tone> = {
  AWAITING_APPROVALS: 'neutral',
  READY: 'progress',
  CREATED: 'success',
};

/** Where a venue pool proposal stands, in the operator's words. */
export const poolProposalStatusLabels: Record<PoolProposalStatus, string> = {
  SUBMITTING: 'Submitting',
  PENDING: 'Awaiting dvv',
  CREATED: 'Created',
  REJECTED: 'Rejected by dvv',
  WITHDRAWN: 'Withdrawn',
  UNRESOLVED: 'Confirming',
  FAILED: 'Failed',
};

export const poolProposalStatusTones: Record<PoolProposalStatus, Tone> = {
  SUBMITTING: 'progress',
  PENDING: 'neutral',
  CREATED: 'success',
  REJECTED: 'danger',
  WITHDRAWN: 'neutral',
  UNRESOLVED: 'warning',
  FAILED: 'danger',
};

/** A fee as the ledger carries it: basis points, without the trailing zeros. */
export function formatFeeBps(feeBps: string): string {
  return `${trimDecimal(feeBps)} bps`;
}

/** A decimal string with the zeros a Daml `Decimal` pads it with removed. */
export function trimDecimal(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

export function ledgerStepLabel(key: string, poolName: (poolId: string) => string): string {
  const poolId = accessStepPoolId(key);
  if (poolId !== null) return `Pool access, ${poolName(poolId)}`;
  return key === ATTESTATION_STEP ? 'KYC attestation' : key;
}

/** How the account's party is held, in words a reader can act on. */
export const partyModeLabels: Record<PartyMode, string> = {
  external: 'External party',
  'participant-test': 'Participant-held key',
};

export const partyModeDescriptions: Record<PartyMode, string> = {
  external:
    'The party belongs to the trader. It is registered from a key they hold, and only they can produce the signature that registers it.',
  'participant-test':
    'A historical request whose party was pre-provisioned on the venue participant. New requests register an external party instead.',
};

/** What a supporting document stands for. */
export const documentCategoryLabels: Record<DocumentCategory, string> = {
  IDENTITY: 'Identity',
  ADDRESS: 'Address',
  OTHER: 'Other',
};

/** How far the trader's own party has travelled. */
export const partyStatusLabels: Record<PartyStatus, string> = {
  PREPARED: 'Awaiting your signature',
  SUBMITTING: 'Registering',
  CONFIRMED: 'Registered',
  UNRESOLVED: 'Confirming',
};

export const partyStatusTones: Record<PartyStatus, Tone> = {
  PREPARED: 'neutral',
  SUBMITTING: 'progress',
  CONFIRMED: 'success',
  UNRESOLVED: 'warning',
};

// -------------------------------------------------------------- domain lookups

/** Falls back to the raw id, so an unresolved reference is still identifiable. */
export function symbolOf(instruments: Instrument[], instrumentId: string): string {
  return instruments.find((instrument) => instrument.id === instrumentId)?.symbol ?? instrumentId;
}

/** Works for the venue's catalogue and for the demo's richer pools alike. */
export function poolNameOf(pools: readonly PoolSummary[], poolId: string): string {
  return pools.find((pool) => pool.poolId === poolId)?.name ?? poolId;
}

/** The instrument a request pays in, or blank when its pool is unknown here. */
export function inputSymbolOf(
  request: SwapRequest,
  pools: Pool[],
  instruments: Instrument[],
): string {
  const pool = pools.find((candidate) => candidate.poolId === request.poolId);
  if (!pool) return '';
  const instrumentId =
    request.direction === 'BaseToQuote' ? pool.baseInstrumentId : pool.quoteInstrumentId;
  return symbolOf(instruments, instrumentId);
}

export function directionLabel(
  direction: SwapDirection,
  base: string,
  quote: string,
): string {
  return direction === 'BaseToQuote' ? `${base} to ${quote}` : `${quote} to ${base}`;
}

// ------------------------------------------------------------------ formatting

function truncate(value: string, head: number, tail: number): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Party identifiers keep their hint, which is the part a reader recognises. */
export function shortParty(partyId: string): string {
  return truncate(partyId, 18, 8);
}

export function shortContract(contractId: string): string {
  return truncate(contractId, 10, 6);
}

export function shortDigest(digest: string): string {
  return truncate(digest, 22, 8);
}

export function formatAmount(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

export function formatDateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}

export function formatCountdown(target: string, from: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(target) - from) / 1000));
  if (seconds === 0) return 'expired';
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
