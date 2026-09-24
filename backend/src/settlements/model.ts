import type { Request as LiquidityRequest } from '../liquidity/model.js';
import type { Family } from '../platform/database.js';
import { InvalidRequest } from '../platform/errors.js';
import { onlyWhitespace } from '../platform/request.js';
import type { Swap } from '../swaps/model.js';
import type { Instrument } from '../tokens/model.js';

export const FAMILIES: readonly Family[] = ['swap', 'deposit', 'withdraw'];
export const SETTLEMENT_STATUSES = [
  'PREPARING',
  'SUBMITTING',
  'UNRESOLVED',
  'CONFIRMED',
  'REJECTED',
  'CANCELLED',
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
export type Trigger = 'MANUAL' | 'AUTOMATIC';

export const POOL_CHANGED = 'POOL_CHANGED';
export const POLICY_CHANGED = 'POLICY_CHANGED';
export const QUEUE_CHANGED = 'QUEUE_CHANGED';
export const BATCH_IN_FLIGHT = 'BATCH_IN_FLIGHT';
export const IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT';
export const RETRY_NOT_ALLOWED = 'RETRY_NOT_ALLOWED';
export const REQUEST_NOT_READY = 'REQUEST_NOT_READY';
/** A pool can settle when it is funded, or when it is empty and awaits initialization. */
export const SETTLEABLE_HEALTH = new Set(['READY', 'EMPTY']);

export function requireFamily(family: string | null): Family {
  const match = FAMILIES.find((candidate) => candidate === family);
  if (match === undefined) throw new InvalidRequest('Invalid request family');
  return match;
}

/** One request family's settlement policy for a pool. */
export interface Policy {
  readonly poolId: string;
  readonly type: Family;
  readonly automaticEnabled: boolean;
  readonly batchSize: number;
  readonly maxBatchSize: number;
  readonly version: bigint;
  readonly updatedAt: string;
}

export interface UpdatePolicy {
  readonly automaticEnabled: boolean;
  readonly batchSize: number;
  readonly expectedVersion: bigint;
}

export interface RequestRef {
  readonly type: Family;
  readonly requestId: string;
}

export function sameRef(left: RequestRef, right: RequestRef): boolean {
  return left.type === right.type && left.requestId === right.requestId;
}

export function sameRefs(left: readonly RequestRef[], right: readonly RequestRef[]): boolean {
  return (
    left.length === right.length &&
    left.every((ref, index) => {
      const other = right[index];
      return other !== undefined && sameRef(ref, other);
    })
  );
}

/** The requests a manual run or retry settles, frozen against one pool state and policy version. */
export interface Selection {
  readonly type: Family;
  readonly retryOf: string | null;
  readonly stateVersion: string;
  readonly policyVersion: bigint;
  readonly requests: readonly RequestRef[];
}

/** A selection of one family's distinct requests. */
export function selection(
  type: Family,
  retryOf: string | null,
  stateVersion: string,
  policyVersion: bigint,
  requests: readonly RequestRef[],
): Selection {
  if (onlyWhitespace(stateVersion)) throw new InvalidRequest('Incomplete settlement selection');
  const keys = new Set(requests.map((ref) => `${ref.type}:${ref.requestId}`));
  if (requests.some((ref) => ref.type !== type) || keys.size !== requests.length) {
    throw new InvalidRequest('Invalid settlement membership');
  }
  return { type, retryOf, stateVersion, policyVersion, requests };
}

export function sameSelection(left: Selection | null, right: Selection | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.type === right.type &&
    left.retryOf === right.retryOf &&
    left.stateVersion === right.stateVersion &&
    left.policyVersion === right.policyVersion &&
    sameRefs(left.requests, right.requests)
  );
}

export interface RunInput {
  readonly idempotencyKey: string;
  readonly selection: Selection | null;
}

/** A queued swap, deposit or withdrawal; `deferred` is scheduling, separate from its ledger status. */
export type QueueRequest =
  | { readonly request: Swap; readonly deferred: boolean; readonly type: 'swap' }
  | { readonly request: LiquidityRequest; readonly deferred: boolean; readonly type: 'deposit' | 'withdraw' };

export function swapRequest(request: Swap, deferred = false): QueueRequest {
  return { request, deferred, type: 'swap' };
}

export function liquidityRequest(request: LiquidityRequest, deferred = false): QueueRequest {
  return { request, deferred, type: request.kind === 'DEPOSIT' ? 'deposit' : 'withdraw' };
}

export function requestId(queued: QueueRequest): string {
  return queued.type === 'swap' ? queued.request.swapId : queued.request.requestId;
}

export function reference(queued: QueueRequest): RequestRef {
  return { type: queued.type, requestId: requestId(queued) };
}

export function poolIdOf(queued: QueueRequest): string {
  return queued.type === 'swap' ? queued.request.poolId : queued.request.terms.poolId;
}

export function settlementDeadlineOf(queued: QueueRequest): string {
  return queued.type === 'swap' ? queued.request.settlementDeadline : queued.request.terms.settlementDeadline;
}

/** A pool state's reserves; decimals are trimmed text. */
export interface Reserves {
  readonly stateId: string;
  readonly baseReserve: string;
  readonly quoteReserve: string;
  readonly spotPrice: string | null;
  readonly invariant: string;
}

/** The pool as one ledger read shows it, with its health for settlement. */
export interface Snapshot {
  readonly poolId: string;
  readonly version: string;
  readonly reserves: Reserves;
  readonly feeBps: string;
  readonly health: string;
  readonly reason: string | null;
  readonly observedAt: string;
  readonly ledgerOffset: bigint;
  readonly lpTokenSupply: string;
  readonly initialRatio: string;
}

export type Fill =
  | {
      readonly requestId: string;
      readonly amountOut: string;
      readonly outputInstrument: Instrument;
      readonly type: 'swap';
    }
  | {
      readonly requestId: string;
      readonly actualBaseIn: string;
      readonly actualQuoteIn: string;
      readonly actualBaseRefund: string;
      readonly actualQuoteRefund: string;
      readonly actualLpOut: string;
      readonly type: 'deposit';
    }
  | {
      readonly requestId: string;
      readonly actualLpBurned: string;
      readonly actualBaseOut: string;
      readonly actualQuoteOut: string;
      readonly type: 'withdraw';
    };

export function fillRef(fill: Fill): RequestRef {
  return { type: fill.type, requestId: fill.requestId };
}

export interface Settlement {
  readonly settlementId: string;
  readonly poolId: string;
  readonly trigger: Trigger;
  readonly status: SettlementStatus;
  readonly requests: readonly RequestRef[];
  readonly fills: readonly Fill[];
  readonly before: Reserves | null;
  readonly after: Reserves | null;
  readonly policyVersion: bigint;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updateId: string | null;
  readonly errorCode: string | null;
  readonly error: string | null;
  readonly retryOf: string | null;
}

/** GET /v1/admin/monitoring. */
export interface Monitoring {
  readonly poolId: string;
  readonly policies: readonly Policy[];
  readonly readyCount: number;
  readonly pendingCount: number;
  readonly blockedRequest: RequestRef | null;
  readonly blockedReason: string | null;
  readonly oldestSubmittedAt: string | null;
  readonly nearestDeadline: string | null;
  readonly activeSettlement: Settlement | null;
  readonly pool: Snapshot;
}

export interface History {
  readonly items: readonly Settlement[];
  readonly nextCursor: string | null;
}

export type PreviewStatus = 'VALID' | 'BLOCKED' | 'NOT_EVALUATED';

export interface ProjectedPoolState {
  readonly baseReserve: string;
  readonly quoteReserve: string;
  readonly lpTokenSupply: string;
  readonly spotPrice: string | null;
  readonly invariant: string;
}

export interface OutputCheck {
  readonly instrument: Instrument;
  readonly amount: string;
  readonly minimum: string;
  readonly headroomBps: string | null;
}

export interface PreviewStep {
  readonly request: RequestRef;
  readonly status: PreviewStatus;
  readonly fill: Fill | null;
  readonly before: ProjectedPoolState;
  readonly after: ProjectedPoolState | null;
  readonly outputs: readonly OutputCheck[];
  readonly errorCode: string | null;
  readonly error: string | null;
}

export interface Preview {
  readonly selection: Selection;
  readonly pool: Snapshot;
  readonly steps: readonly PreviewStep[];
  readonly activeSettlementId: string | null;
  readonly executable: boolean;
}

export interface Plan {
  readonly selection: Selection;
  readonly requests: readonly QueueRequest[];
  readonly activeSettlementId: string | null;
}

/** A frozen batch and everything its submission and recovery need. */
export interface Pending {
  readonly settlement: Settlement;
  readonly requests: readonly QueueRequest[];
  readonly commandId: string;
  readonly beginOffset: bigint;
  readonly stateVersion: string;
  readonly selection: Selection | null;
}

export interface Confirmation {
  readonly fills: readonly Fill[];
  readonly before: Reserves;
  readonly after: Reserves;
  readonly updateId: string;
  readonly offset: bigint;
  readonly confirmedAt: string;
}
