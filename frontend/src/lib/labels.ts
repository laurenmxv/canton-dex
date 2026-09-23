import { accessStepPoolId, ATTESTATION_STEP } from './api/ledger-steps';
import { formatDecimal } from './decimal';
import type {
  DocumentCategory,
  Instrument,
  LedgerStepStatus,
  LiquidityStatus,
  OnboardingStatus,
  PartyMode,
  PartyStatus,
  Pool,
  PoolApprover,
  PoolHealth,
  PoolProposalStatus,
  PoolSummary,
  ProposalStatus,
  Role,
  Settlement,
  SettlementRequestRef,
  SettlementStatus,
  SwapDirection,
  SwapRequest,
  SwapStatus,
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
  PARTY_CONFLICT: 'Party already exists',
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
  PARTY_CONFLICT: 'danger',
  LEDGER_PENDING: 'progress',
  LEDGER_SUBMITTING: 'progress',
  LEDGER_UNRESOLVED: 'warning',
  COMPLETED: 'success',
};

export const ledgerStepLabels: Record<LedgerStepStatus, string> = {
  PENDING: 'Pending',
  SUBMITTING: 'Submitting',
  CONFIRMED: 'Confirmed',
  UNRESOLVED: 'Confirming',
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
  PENDING: 'Awaiting dvo',
  CREATED: 'Created',
  REJECTED: 'Rejected by dvo',
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

/**
 * Where a request stands, said so that no stage claims more than it did.
 * Accepting a signature is not queueing, and queueing is not settling.
 */
export const swapStatusLabels: Record<SwapStatus, string> = {
  PREPARED: 'Awaiting your signature',
  SUBMITTING: 'Submitting',
  UNRESOLVED: 'Confirming',
  READY: 'Queued for settlement',
  BLOCKED: 'Blocked in the queue',
  SETTLING: 'Settling',
  SETTLED: 'Settled',
  EXPIRED: 'Deadline elapsed',
  WITHDRAWING: 'Reclaiming',
  WITHDRAWAL_UNRESOLVED: 'Confirming reclaim',
  WITHDRAWN: 'Reclaimed',
  FAILED: 'Failed',
};

export const swapStatusTones: Record<SwapStatus, Tone> = {
  PREPARED: 'neutral',
  SUBMITTING: 'progress',
  UNRESOLVED: 'warning',
  READY: 'progress',
  BLOCKED: 'warning',
  SETTLING: 'progress',
  SETTLED: 'success',
  EXPIRED: 'warning',
  WITHDRAWING: 'progress',
  WITHDRAWAL_UNRESOLVED: 'warning',
  WITHDRAWN: 'neutral',
  FAILED: 'danger',
};

/** An elapsed deadline is not a recovery: funds stay allocated until one is confirmed. */
export const liquidityStatusLabels: Record<LiquidityStatus, string> = {
  PREPARED: 'Awaiting your signature',
  SUBMITTING: 'Submitting',
  UNRESOLVED: 'Confirming',
  READY: 'Queued for settlement',
  BLOCKED: 'Blocked in the queue',
  SETTLING: 'Settling',
  SETTLED: 'Settled',
  EXPIRED: 'Deadline elapsed',
  RECOVERING: 'Recovering funds',
  RECOVERY_UNRESOLVED: 'Confirming recovery',
  RECOVERED: 'Funds recovered',
  FAILED: 'Failed',
};

export const liquidityStatusTones: Record<LiquidityStatus, Tone> = {
  PREPARED: 'neutral',
  SUBMITTING: 'progress',
  UNRESOLVED: 'warning',
  READY: 'progress',
  BLOCKED: 'warning',
  SETTLING: 'progress',
  SETTLED: 'success',
  EXPIRED: 'warning',
  RECOVERING: 'progress',
  RECOVERY_UNRESOLVED: 'warning',
  RECOVERED: 'neutral',
  FAILED: 'danger',
};

export const requestTypeLabels: Record<SettlementRequestRef['type'], string> = {
  swap: 'Swap',
  deposit: 'Deposit',
  withdraw: 'Withdrawal',
};

/** A batch holds requests from one queue, so one kind names its size. */
export function batchSizeLabel({ requests }: Settlement): string {
  const kind = requests[0] ? requestTypeLabels[requests[0].type].toLowerCase() : 'request';
  return `${requests.length} ${kind}${requests.length === 1 ? '' : 's'}`;
}

export const settlementStatusLabels: Record<SettlementStatus, string> = {
  PREPARING: 'Preparing',
  SUBMITTING: 'Submitting',
  UNRESOLVED: 'Confirming',
  CONFIRMED: 'Confirmed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

/** How a batch names the rejected or cancelled attempt it follows. */
export const RETRY_OF = 'Retry of';

export const settlementStatusTones: Record<SettlementStatus, Tone> = {
  PREPARING: 'neutral',
  SUBMITTING: 'progress',
  UNRESOLVED: 'warning',
  CONFIRMED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

/** What the venue observed about a pool, not a score this app invented. */
export const poolHealthLabels: Record<PoolHealth, string> = {
  READY: 'Ready to settle',
  EMPTY: 'Awaiting initial liquidity',
  BACKING_MISMATCH: 'Holdings do not match reserves',
  DELEGATION_MISSING: 'Settlement authority missing',
};

export const poolHealthTones: Record<PoolHealth, Tone> = {
  READY: 'success',
  EMPTY: 'neutral',
  BACKING_MISMATCH: 'danger',
  DELEGATION_MISSING: 'danger',
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
  CONFLICT: 'Party already exists',
};

export const partyStatusTones: Record<PartyStatus, Tone> = {
  PREPARED: 'neutral',
  SUBMITTING: 'progress',
  CONFIRMED: 'success',
  UNRESOLVED: 'warning',
  CONFLICT: 'danger',
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

/**
 * The two sides of a pool's name, as the venue wrote it.
 *
 * A name the venue did not write as a pair comes back whole, so nothing is
 * split that was never two things. These are labels, not instruments: what a
 * pool actually holds is in its own terms.
 */
export function pairSymbols(poolName: string): string[] {
  const sides = poolName
    .split('/')
    .map((side) => side.trim())
    .filter((side) => side !== '');
  return sides.length === 2 ? sides : [poolName];
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

/**
 * An amount as a reader sees it. The arithmetic is exact: a `Decimal` holds
 * more digits than a double, so rounding one here would show the wrong money.
 */
export function formatAmount(value: string): string {
  return formatDecimal(value, { minFractionDigits: 2, maxFractionDigits: 6 });
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

/** How long ago something happened, in the same words as a countdown. */
export function formatAge(since: string, from: number): string {
  const started = Date.parse(since);
  if (!Number.isFinite(started)) return since;
  const seconds = Math.max(0, Math.round((from - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function formatCountdown(target: string, from: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(target) - from) / 1000));
  if (seconds === 0) return 'expired';
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
