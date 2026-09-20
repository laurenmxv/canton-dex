import type { InstrumentId } from './pool.js';
import type { Swap } from './swap.js';

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

/** Starts one manual batch. Repeating the same key never starts a second. */
export interface RunSettlementInput {
  idempotencyKey: string;
}

/**
 * A pool's confirmed reserves at one ledger state.
 *
 * `invariant` is the product of the two reserves and `spotPrice` is their
 * ratio, both computed by the venue. Retained fees can raise the invariant, so
 * a batch's before and after points do not lie on one curve.
 */
export interface PoolReserves {
  stateId: string;
  baseReserve: string;
  quoteReserve: string;
  spotPrice: string;
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
export interface SettlementFill {
  swapId: string;
  amountOut: string;
  /**
   * The instrument the payout is in, which is the request's own output asset.
   *
   * Null on a fill the venue stored before it recorded this, where the asset
   * is unknown. It cannot be derived from the pool's pair: either side of a
   * pair is the output, depending on the request's direction.
   */
  outputInstrument: InstrumentId | null;
}

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
  swapIds: readonly string[];
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
}

/**
 * Why a pool can or cannot settle right now, read from the ledger rather than
 * from a score:
 *
 * - `READY`: backed, and the settlement delegation is in place.
 * - `UNFUNDED`: the pool has no token backing yet.
 * - `BACKING_MISMATCH`: its holdings do not match its reserves.
 * - `DELEGATION_MISSING`: the settlement authority is gone.
 */
export type PoolHealth =
  | 'READY'
  | 'UNFUNDED'
  | 'BACKING_MISMATCH'
  | 'DELEGATION_MISSING';

/**
 * One observation of a pool, taken at `ledgerOffset` and timed at `observedAt`.
 * Both are what tell a reader whether they are looking at current facts.
 */
export interface PoolSnapshot {
  poolId: string;
  /** The observed lineage: the state and config contracts, as `state:config`. */
  version: string;
  reserves: PoolReserves;
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
 * - `readyCount` is how many requests the venue has recorded as `READY`. It is
 *   not a promise that a batch of that size would settle: the pool reprices
 *   every request when a batch runs.
 * - `pendingCount` counts only the requests whose own ledger command is still
 *   in flight, which is `SUBMITTING`, `UNRESOLVED`, `WITHDRAWING` and
 *   `WITHDRAWAL_UNRESOLVED`. Blocked and settling requests are in neither
 *   count; read the queue itself for those.
 */
export interface SettlementMonitoring {
  poolId: string;
  policy: SettlementPolicy;
  readyCount: number;
  pendingCount: number;
  blockedSwapId: string | null;
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
 * `READY` is the route's own default and lists the requests the venue has
 * recorded as ready. `active` lists every request that has not reached a
 * terminal status, which adds the blocked, submitting, settling and
 * withdrawing ones. Neither answer says a batch would succeed: the pool
 * decides that when one runs.
 */
export type SettlementQueueFilter = 'READY' | 'active';

/** One queued request, which is the same record the trader sees. */
export type SettlementRequest = Swap;
