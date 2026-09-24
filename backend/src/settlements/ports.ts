import type { Family } from '../platform/database.js';
import type {
  Confirmation,
  Fill,
  History,
  Monitoring,
  Pending,
  Plan,
  Policy,
  PreviewStep,
  QueueRequest,
  RequestRef,
  Selection,
  Settlement,
  SettlementStatus,
  Snapshot,
  Trigger,
  UpdatePolicy,
} from './model.js';

/** Canton definitely rejected a batch; none of its token transfers committed. */
export class SettlementRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Ledger evidence, or a durable preparation failure, proves that this command can never commit. */
export class SettlementExcluded extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Preflight found a request that the batch cannot settle at the current reserves. */
export class RequestBlocked extends Error {
  constructor(
    readonly request: RequestRef,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Settlement's view of the ledger. */
export interface SettlementLedger {
  snapshot(poolId: string): Promise<Snapshot>;
  /** Sequential preflight: the fills in request order, or RequestBlocked for a known bad request. */
  preflight(snapshot: Snapshot, requests: readonly QueueRequest[]): Promise<Fill[]>;
  /** The same preflight, keeping each valid state and stopping at the first blocked request. */
  preview(snapshot: Snapshot, requests: readonly QueueRequest[]): Promise<PreviewStep[]>;
  submit(pending: Pending): Promise<Confirmation>;
  /** The committed batch, or undefined while its outcome stays unknown. */
  recover(pending: Pending): Promise<Confirmation | undefined>;
}

/** The durable settlement queues and batches; `now` values are nanoseconds. */
export interface SettlementProgress {
  policy(poolId: string, family: Family): Promise<Policy>;
  updatePolicy(poolId: string, family: Family, input: UpdatePolicy, now: bigint): Promise<Policy>;
  find(id: string): Promise<Settlement | undefined>;
  get(id: string): Promise<Settlement>;
  findIntent(poolId: string, id: string, selection: Selection | null): Promise<Settlement | undefined>;
  plan(
    poolId: string,
    family: Family,
    retryOf: string | null,
    requestId: string | null,
    snapshot: Snapshot,
    now: bigint,
  ): Promise<Plan>;
  setDeferred(poolId: string, reference: RequestRef, deferred: boolean, now: bigint): Promise<void>;
  history(
    poolId: string,
    type: Family | null,
    status: SettlementStatus | null,
    before: string | null,
    limit: number,
  ): Promise<History>;
  list(poolId: string | null): Promise<Settlement[]>;
  automaticPools(): Promise<string[]>;
  pending(): Promise<Pending[]>;
  claim(
    poolId: string,
    id: string,
    trigger: Trigger,
    snapshot: Snapshot,
    now: bigint,
    selection?: Selection | null,
  ): Promise<Pending | undefined>;
  keepPrefix(
    id: string,
    prefix: readonly RequestRef[],
    blocked: RequestRef,
    code: string,
    reason: string,
    stateVersion: string,
    now: bigint,
  ): Promise<boolean>;
  rejectPreparation(
    id: string,
    blocked: RequestRef,
    code: string,
    reason: string,
    stateVersion: string,
    now: bigint,
  ): Promise<void>;
  cancelPreparation(id: string, code: string, reason: string | null, now: bigint): Promise<void>;
  authorizeDispatch(id: string, fills: readonly Fill[], snapshot: Snapshot, now: bigint): Promise<Pending | undefined>;
  unresolved(id: string, now: bigint): Promise<void>;
  beginRecovery(id: string, now: bigint): Promise<boolean>;
  rejectSubmission(id: string, code: string, reason: string, now: bigint): Promise<void>;
  excludeSubmission(id: string, code: string, reason: string, now: bigint): Promise<void>;
  confirm(id: string, confirmation: Confirmation): Promise<void>;
  monitoring(poolId: string, snapshot: Snapshot, now: bigint): Promise<Monitoring>;
  queue(poolId: string): Promise<QueueRequest[]>;
}
