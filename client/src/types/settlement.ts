import type { RequestType, TaggedRequest } from './activity.js';
import type { InstrumentId } from './pool.js';

/** Names one request in a batch or at the head of its queue. */
export interface SettlementRequestRef {
  type: RequestType;
  requestId: string;
}

/**
 * Where one batch stands. `UNRESOLVED` is not a failure: the venue has not seen
 * the outcome yet and is reconciling it. `REJECTED` is final and means no
 * request in the batch was filled.
 */
export type SettlementStatus =
  | 'PREPARING'
  | 'SUBMITTING'
  | 'UNRESOLVED'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'CANCELLED';

/** Who started the batch: an operator, or the venue's own worker. */
export type SettlementTrigger = 'MANUAL' | 'AUTOMATIC';

/**
 * One pool's own batching settings, as the venue's database holds them.
 *
 * Every field belongs to this pool alone: there is no venue-wide target and no
 * venue-wide switch. `version` rises on every accepted update and is what an
 * update must quote so a stale form cannot restore an old setting.
 */
export interface SettlementPolicy {
  poolId: string;
  automaticEnabled: boolean;
  batchSize: number;
  /** The largest target the venue has tested for this pool. */
  maxBatchSize: number;
  version: number;
  updatedAt: string;
}

/** A settings change. It is refused when `expectedVersion` is not the current one. */
export interface UpdateSettlementPolicy {
  automaticEnabled: boolean;
  batchSize: number;
  expectedVersion: number;
}

/**
 * The batch one preview proposed, which is what the venue checks again before
 * it runs it.
 *
 * `stateVersion` and `policyVersion` are the pool and the policy the preview
 * observed, and `requests` is the membership in queue order. `retryOf` names
 * the rejected or cancelled batch whose remaining members this proposes again.
 */
export interface SettlementSelection {
  type: RequestType;
  retryOf: string | null;
  stateVersion: string;
  policyVersion: number;
  requests: readonly SettlementRequestRef[];
}

/**
 * Starts one manual batch. Repeating the same key never starts a second.
 *
 * With a `selection`, the venue runs exactly that membership, and refuses it
 * with a conflict once the pool, the policy or the queue has moved on from what
 * the preview observed. Without one, the venue selects the batch itself.
 */
export interface RunSettlementInput {
  idempotencyKey: string;
  selection?: SettlementSelection;
}

/**
 * A pool's confirmed reserves at one ledger state.
 *
 * `invariant` is the product of the two reserves and `spotPrice` is their
 * ratio, both computed by the venue; an empty pool has no `spotPrice`.
 */
export interface PoolReserves {
  stateId: string;
  baseReserve: string;
  quoteReserve: string;
  spotPrice: string | null;
  invariant: string;
}

/**
 * What one request in a batch is due, or was paid.
 *
 * The venue writes a projection of these at `SUBMITTING`, from its own
 * preflight against the reserves it observed. Only a `CONFIRMED` batch's fills
 * are amounts the ledger actually paid; every other status carries an estimate
 * that may never happen.
 */
export type SettlementFill =
  | {
      type: 'swap';
      requestId: string;
      amountOut: string;
      outputInstrument: InstrumentId;
    }
  | {
      type: 'deposit';
      requestId: string;
      actualBaseIn: string;
      actualQuoteIn: string;
      actualBaseRefund: string;
      actualQuoteRefund: string;
      actualLpOut: string;
    }
  | {
      type: 'withdraw';
      requestId: string;
      actualLpBurned: string;
      actualBaseOut: string;
      actualQuoteOut: string;
    };

/**
 * One batch.
 *
 * `before` is the state the venue selected against, recorded from the moment
 * the batch is created, so it exists long before anything settles. `after` is
 * written only when the ledger confirms the transaction. `status` is therefore
 * what says whether this batch did anything: only `CONFIRMED` proves it did.
 */
export interface Settlement {
  settlementId: string;
  poolId: string;
  trigger: SettlementTrigger;
  status: SettlementStatus;
  requests: readonly SettlementRequestRef[];
  fills: readonly SettlementFill[];
  before: PoolReserves | null;
  after: PoolReserves | null;
  /** The policy version the batch was selected under. */
  policyVersion: number;
  createdAt: string;
  updatedAt: string;
  updateId: string | null;
  errorCode: string | null;
  error: string | null;
  /** The rejected or cancelled batch this one retries. That batch stays as it was. */
  retryOf: string | null;
}

/** One page of a pool's batches, newest first. */
export interface SettlementHistory {
  items: readonly Settlement[];
  /** Null on the oldest page. Pass it back as `before` for the next one. */
  nextCursor: string | null;
}

/** Which of a pool's batches to page through. The venue applies every filter. */
export interface SettlementHistoryQuery {
  type?: RequestType;
  status?: SettlementStatus;
  before?: string;
  /** Between 1 and 100. The venue answers 25 when none is given. */
  limit?: number;
}

/** A pool's reserves as a preview projects them. Nothing here has settled. */
export interface ProjectedPoolState {
  baseReserve: string;
  quoteReserve: string;
  lpTokenSupply: string;
  spotPrice: string | null;
  invariant: string;
}

/**
 * One projected output against the minimum its request signed.
 *
 * `headroomBps` is how far the amount sits above the minimum, in basis points
 * of the amount, as the venue computed it. It is null where the amount is zero.
 */
export interface SettlementOutputCheck {
  instrument: InstrumentId;
  amount: string;
  minimum: string;
  headroomBps: string | null;
}

/**
 * One request of a preview, checked in queue order against the state the
 * requests before it would leave.
 *
 * - `VALID`: the request would settle at `after`. This is a projection: the
 *   ledger decides when the batch runs.
 * - `BLOCKED`: the first request that would fail. It moves nothing, so `after`
 *   is null, and `error` says why.
 * - `NOT_EVALUATED`: a request after a blocked one. Nothing checked it.
 *
 * `fill` is the estimate for a valid request. It has the shape of a settled
 * fill, so its `actual*` names do not mean that anything was paid.
 */
export interface SettlementPreviewStep {
  request: SettlementRequestRef;
  status: 'VALID' | 'BLOCKED' | 'NOT_EVALUATED';
  fill: SettlementFill | null;
  before: ProjectedPoolState;
  after: ProjectedPoolState | null;
  outputs: readonly SettlementOutputCheck[];
  errorCode: string | null;
  error: string | null;
}

/**
 * The next batch of one queue, projected from one observation of the pool.
 *
 * `selection` is what `run` takes to execute exactly this batch. `executable`
 * is the venue's own answer to whether it would start now. A preview of one
 * queue says nothing about the order the other queues settle in.
 */
export interface SettlementPreview {
  selection: SettlementSelection;
  pool: PoolSnapshot;
  steps: readonly SettlementPreviewStep[];
  activeSettlementId: string | null;
  executable: boolean;
}

/**
 * Why a pool can or cannot settle right now, read from the ledger rather than
 * from a score:
 *
 * - `READY`: backed, and the settlement delegation is in place.
 * - `EMPTY`: configured with no reserves, and ready for its initial deposit.
 * - `BACKING_MISMATCH`: its holdings do not match its reserves.
 * - `DELEGATION_MISSING`: the settlement authority is gone.
 */
export type PoolHealth = 'READY' | 'EMPTY' | 'BACKING_MISMATCH' | 'DELEGATION_MISSING';

/**
 * One observation of a pool, taken at `ledgerOffset` and timed at `observedAt`.
 * Both are what tell a reader whether they are looking at current facts.
 */
export interface PoolSnapshot {
  poolId: string;
  /** The observed lineage: the state and config contracts, as `state:config`. */
  version: string;
  reserves: PoolReserves;
  lpTokenSupply: string;
  /** The quote per base the dvo configured, which prices the first deposit. */
  initialRatio: string;
  feeBps: string;
  health: PoolHealth;
  /** What the venue says about a health other than `READY`, and null at `READY`. */
  reason: string | null;
  observedAt: string;
  ledgerOffset: number;
}

/**
 * One pool's queue and state together, which is what an operator decides from.
 *
 * The two counts do not add up to the queue, and neither is the queue's
 * length:
 *
 * - `readyCount` is how many requests the venue has recorded as `READY`, less
 *   the deferred ones. It is not a promise that a batch of that size would
 *   settle: the pool reprices every request when a batch runs.
 * - `pendingCount` counts only the requests whose own ledger command is still
 *   in flight: submitting, unresolved, or being withdrawn or recovered.
 *   Blocked and settling requests are in neither count; read the queue itself
 *   for those.
 */
export interface SettlementMonitoring {
  poolId: string;
  policy: SettlementPolicy;
  readyCount: number;
  pendingCount: number;
  /** A request that cannot settle at the head of its own family's queue. */
  blockedRequest: SettlementRequestRef | null;
  blockedReason: string | null;
  oldestSubmittedAt: string | null;
  nearestDeadline: string | null;
  activeSettlement: Settlement | null;
  /** The observation the venue took to answer this call. A read it cannot
   * take fails the whole call rather than answering without one. */
  pool: PoolSnapshot;
}

/**
 * Which part of a pool's queue to read.
 *
 * `READY` is the route's own default. It lists the requests the venue has
 * recorded as ready, less the deferred ones. `active` is the operational
 * queue: every queued request that is ready, blocked or has a command in
 * flight, deferred or not, and every deferred request that has expired. It
 * omits a prepared request that nobody submitted and an expired request that
 * nobody deferred. Neither answer says a batch would succeed: the pool decides
 * that when one runs.
 */
export type SettlementQueueFilter = 'READY' | 'active';

/**
 * One queued request. Swaps, deposits and withdrawals each queue in their own FIFO.
 *
 * `deferred` is an operator's hold, and independent of the request's status:
 * batches pass over the request until it returns to the tail of its queue. It
 * keeps its allocations locked and its original deadline, so it can expire.
 */
export type SettlementRequest = TaggedRequest & { deferred: boolean };
