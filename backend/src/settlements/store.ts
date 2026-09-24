import { sql, type Kysely, type Selectable } from 'kysely';
import { readRequest } from '../liquidity/store.js';
import { initialBatchSize, nextArrival } from '../operations/queues.js';
import {
  isUniqueViolation,
  type Database,
  type Family,
  type LiquidityRequestsTable,
  type PoolRequestQueuesTable,
  type SettlementBatchesTable,
  type SwapRequestsTable,
} from '../platform/database.js';
import { CodedFailure, Conflict, InvalidRequest, NotFound } from '../platform/errors.js';
import { jsonText } from '../platform/json.js';
import {
  enumeration,
  list,
  long,
  object,
  parseInstant,
  pathUuid,
  present,
  requirePageSize,
  stored,
  strictBase64Url,
  text,
} from '../platform/request.js';
import { epochNanos, instantText, isoInstant } from '../platform/time.js';
import { readSwap } from '../swaps/store.js';
import { storedInstrument } from '../tokens/model.js';
import {
  BATCH_IN_FLIGHT,
  FAMILIES,
  fillRef,
  IDEMPOTENCY_CONFLICT,
  liquidityRequest,
  POLICY_CHANGED,
  POOL_CHANGED,
  poolIdOf,
  QUEUE_CHANGED,
  reference,
  REQUEST_NOT_READY,
  requireFamily,
  RETRY_NOT_ALLOWED,
  sameRef,
  sameRefs,
  sameSelection,
  selection,
  settlementDeadlineOf,
  swapRequest,
  type Confirmation,
  type Fill,
  type History,
  type Monitoring,
  type Pending,
  type Plan,
  type Policy,
  type QueueRequest,
  type RequestRef,
  type Reserves,
  type Selection,
  type Settlement,
  type SettlementStatus,
  type Snapshot,
  type Trigger,
  type UpdatePolicy,
} from './model.js';
import type { SettlementProgress } from './ports.js';
import { prefix, queueOrder, select, SELECTABLE_STATUSES } from './selection.js';

type Executor = Kysely<Database>;
type BatchRow = Selectable<SettlementBatchesTable>;

/** The Daml batch limit that a configured maximum must fit. */
const DAML_MAX_BATCH_SIZE = 20;
const INVALID_HISTORY_CURSOR = 'Invalid history cursor';
const LIST_LIMIT = 100;
/** Requests whose command outcome or allocation recovery is still in flight. */
const PENDING_STATUSES = new Set([
  'SUBMITTING',
  'UNRESOLVED',
  'WITHDRAWING',
  'WITHDRAWAL_UNRESOLVED',
  'RECOVERING',
  'RECOVERY_UNRESOLVED',
]);
const ACTIVE_BATCH_STATUSES = ['PREPARING', 'SUBMITTING', 'UNRESOLVED'] as const;
const EXPIRY_REASON = 'Settlement deadline passed. Recover the locked allocations.';
const RELEASE_EXPIRY_REASON = 'Settlement deadline passed. Withdraw the locked allocation.';
const CURSOR_DECODER = new TextDecoder('utf-8');

interface QueueState {
  readonly policies: readonly Policy[];
  readonly activeId: string | null;
  readonly lastProcessedFamily: Family | null;
}

function familyPolicy(state: QueueState, family: Family): Policy {
  const policy = state.policies.find((candidate) => candidate.type === family);
  if (!policy) throw new Error(`The ${family} queue has no policy`);
  return policy;
}

function requestTable(family: Family): 'swap_requests' | 'liquidity_requests' {
  return family === 'swap' ? 'swap_requests' : 'liquidity_requests';
}

function readRef(value: unknown): RequestRef {
  const fields = present(object(value), 'request');
  return {
    type: present(enumeration(fields.type, FAMILIES), 'request type'),
    requestId: present(text(fields.requestId), 'request id'),
  };
}

/** A fill from its stored JSON form. */
export function readFill(value: unknown): Fill {
  const fields = present(object(value), 'fill');
  const field = (name: string) => present(text(fields[name]), name);
  switch (present(enumeration(fields.type, FAMILIES), 'fill type')) {
    case 'swap':
      return {
        requestId: field('requestId'),
        amountOut: field('amountOut'),
        outputInstrument: storedInstrument(fields.outputInstrument),
        type: 'swap',
      };
    case 'deposit':
      return {
        requestId: field('requestId'),
        actualBaseIn: field('actualBaseIn'),
        actualQuoteIn: field('actualQuoteIn'),
        actualBaseRefund: field('actualBaseRefund'),
        actualQuoteRefund: field('actualQuoteRefund'),
        actualLpOut: field('actualLpOut'),
        type: 'deposit',
      };
    case 'withdraw':
      return {
        requestId: field('requestId'),
        actualLpBurned: field('actualLpBurned'),
        actualBaseOut: field('actualBaseOut'),
        actualQuoteOut: field('actualQuoteOut'),
        type: 'withdraw',
      };
  }
}

function readReserves(value: unknown): Reserves {
  const fields = present(object(value), 'reserves');
  return {
    stateId: present(text(fields.stateId), 'stateId'),
    baseReserve: present(text(fields.baseReserve), 'baseReserve'),
    quoteReserve: present(text(fields.quoteReserve), 'quoteReserve'),
    spotPrice: text(fields.spotPrice),
    invariant: present(text(fields.invariant), 'invariant'),
  };
}

function readSelection(value: unknown): Selection {
  const fields = present(object(value), 'selection');
  return selection(
    present(enumeration(fields.type, FAMILIES), 'selection type'),
    text(fields.retryOf),
    present(text(fields.stateVersion), 'stateVersion'),
    present(long(fields.policyVersion), 'policyVersion'),
    present(list(fields.requests, readRef), 'selection requests'),
  );
}

function toSettlement(row: BatchRow): Settlement {
  return {
    settlementId: row.id,
    poolId: row.pool_id,
    trigger: row.trigger,
    status: row.status,
    requests: stored('settlement requests', row.requests, (value) => list(value, readRef)),
    fills: stored('settlement fills', row.fills, (value) => list(value, readFill)),
    before: row.reserves_before === null ? null : stored('reserves before', row.reserves_before, readReserves),
    after: row.reserves_after === null ? null : stored('reserves after', row.reserves_after, readReserves),
    policyVersion: row.policy_version,
    createdAt: isoInstant(row.created_at),
    updatedAt: isoInstant(row.updated_at),
    updateId: row.update_id,
    errorCode: row.error_code,
    error: row.error,
    retryOf: row.retry_of,
  };
}

function earliest(instants: readonly string[]): string | null {
  return instants.reduce<string | null>(
    (first, instant) => (first === null || epochNanos(instant) < epochNanos(first) ? instant : first),
    null,
  );
}

function cursorBoundary(before: string): { readonly createdAt: string; readonly id: string } {
  const bytes = strictBase64Url(before);
  if (!bytes) throw new InvalidRequest(INVALID_HISTORY_CURSOR);
  const parts = CURSOR_DECODER.decode(bytes).split('|');
  const [time, id] = parts;
  if (parts.length !== 2 || time === undefined || id === undefined) throw new InvalidRequest(INVALID_HISTORY_CURSOR);
  return { createdAt: instantText(parseInstant(time)), id: pathUuid(id) };
}

function historyCursor(last: Settlement): string {
  return Buffer.from(`${last.createdAt}|${last.settlementId}`, 'utf8').toString('base64url');
}

/**
 * Per-pool settlement queues: family policies, queued requests and settlement batches. The pool
 * queue row serializes admission, policy changes, deferral, claims and dispatch.
 */
export class SettlementStore implements SettlementProgress {
  constructor(
    private readonly db: Executor,
    private readonly maxBatchSize: number,
  ) {
    if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > DAML_MAX_BATCH_SIZE) {
      throw new RangeError(`Maximum batch size must be between 1 and ${String(DAML_MAX_BATCH_SIZE)}`);
    }
  }

  async policy(poolId: string, family: Family): Promise<Policy> {
    requireFamily(family);
    return this.db.transaction().execute(async (trx) => familyPolicy(await this.lockQueue(trx, poolId), family));
  }

  async updatePolicy(poolId: string, family: Family, input: UpdatePolicy, now: bigint): Promise<Policy> {
    requireFamily(family);
    if (input.batchSize < 1 || input.batchSize > this.maxBatchSize) {
      throw new CodedFailure(400, 'INVALID_BATCH_SIZE', 'Batch size exceeds the configured limit');
    }
    return this.db.transaction().execute(async (trx) => {
      await this.lockQueue(trx, poolId);
      const changed = await trx
        .updateTable('pool_request_queues')
        .set((eb) => ({
          automatic_enabled: input.automaticEnabled,
          batch_size: input.batchSize,
          policy_version: eb('policy_version', '+', 1n),
          blocked_version: null,
          updated_at: instantText(now),
        }))
        .where('pool_id', '=', poolId)
        .where('family', '=', family)
        .where('policy_version', '=', input.expectedVersion)
        .executeTakeFirst();
      if (changed.numUpdatedRows !== 1n) {
        throw new Conflict('The settlement policy changed. Refresh it before saving.', POLICY_CHANGED);
      }
      return familyPolicy(await this.lockQueue(trx, poolId), family);
    });
  }

  async find(id: string, db: Executor = this.db): Promise<Settlement | undefined> {
    const row = await db.selectFrom('settlement_batches').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toSettlement(row) : undefined;
  }

  async get(id: string, db: Executor = this.db): Promise<Settlement> {
    const settlement = await this.find(id, db);
    if (!settlement) throw new NotFound();
    return settlement;
  }

  /** The settlement of an idempotency key, which must repeat the same pool and intent. */
  async findIntent(
    poolId: string,
    id: string,
    intent: Selection | null,
    db: Executor = this.db,
  ): Promise<Settlement | undefined> {
    const row = await db.selectFrom('settlement_batches').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    const storedIntent = row.selection === null ? null : stored('settlement selection', row.selection, readSelection);
    if (row.pool_id !== poolId || !sameSelection(storedIntent, intent)) {
      throw new Conflict('This key belongs to a different settlement intent', IDEMPOTENCY_CONFLICT);
    }
    return toSettlement(row);
  }

  async plan(
    poolId: string,
    family: Family,
    retryOf: string | null,
    requestId: string | null,
    snapshot: Snapshot,
    now: bigint,
  ): Promise<Plan> {
    requireFamily(family);
    if (retryOf !== null && requestId !== null) {
      throw new InvalidRequest('Choose either a batch retry or an individual request');
    }
    return this.db.transaction().execute(async (trx) => {
      const state = await this.lockQueue(trx, poolId);
      await this.expireReady(trx, poolId, now);
      const policy = familyPolicy(state, family);
      const requests =
        requestId === null
          ? await this.candidates(trx, poolId, family, retryOf, policy.batchSize)
          : await this.individual(trx, poolId, { type: family, requestId });
      return {
        selection: selection(family, retryOf, snapshot.version, policy.version, requests.map(reference)),
        requests,
        activeSettlementId: state.activeId,
      };
    });
  }

  private async individual(trx: Executor, poolId: string, ref: RequestRef): Promise<QueueRequest[]> {
    const match = (await this.queue(poolId, trx)).find(
      (queued) => sameRef(reference(queued), ref) && !queued.deferred && SELECTABLE_STATUSES.has(queued.request.status),
    );
    if (!match) throw new Conflict('Request is no longer eligible. Refresh the preview.', QUEUE_CHANGED);
    return [match];
  }

  private async candidates(
    trx: Executor,
    poolId: string,
    family: Family,
    retryOf: string | null,
    limit: number,
  ): Promise<QueueRequest[]> {
    const requests = (await this.queue(poolId, trx)).filter((queued) => queued.type === family);
    if (retryOf === null) return prefix(requests, limit);
    const previous = await this.get(retryOf, trx);
    if (
      previous.poolId !== poolId ||
      (previous.status !== 'REJECTED' && previous.status !== 'CANCELLED') ||
      previous.requests.some((ref) => ref.type !== family)
    ) {
      throw new Conflict(
        'Only a rejected or cancelled batch from this pool and queue can be retried',
        RETRY_NOT_ALLOWED,
      );
    }
    const retried = previous.requests.flatMap((ref) => {
      const queued = requests.find((candidate) => sameRef(reference(candidate), ref));
      return queued && SELECTABLE_STATUSES.has(queued.request.status) ? [queued] : [];
    });
    return prefix(retried, limit);
  }

  /** The queue must still yield exactly the previewed requests at the previewed versions. */
  private async selected(
    trx: Executor,
    poolId: string,
    policy: Policy,
    snapshot: Snapshot,
    intent: Selection,
  ): Promise<QueueRequest[]> {
    if (snapshot.version !== intent.stateVersion)
      throw new Conflict('Pool changed. Refresh the preview.', POOL_CHANGED);
    if (policy.version !== intent.policyVersion)
      throw new Conflict('Policy changed. Refresh the preview.', POLICY_CHANGED);
    // A manual singleton may select any eligible request without changing the queue policy.
    const [single] = intent.requests;
    const requests =
      intent.retryOf === null && intent.requests.length === 1 && single
        ? await this.individual(trx, poolId, single)
        : await this.candidates(trx, poolId, intent.type, intent.retryOf, policy.batchSize);
    if (!sameRefs(requests.map(reference), intent.requests)) {
      throw new Conflict('Queue changed. Refresh the preview.', QUEUE_CHANGED);
    }
    return requests;
  }

  async setDeferred(poolId: string, ref: RequestRef, deferred: boolean, now: bigint): Promise<void> {
    const at = instantText(now);
    await this.db.transaction().execute(async (trx) => {
      const state = await this.lockQueue(trx, poolId);
      if (state.activeId !== null) {
        throw new Conflict("Wait for this pool's active settlement to finish", BATCH_IN_FLIGHT);
      }
      const request = await this.findRequest(trx, ref);
      if (!request || poolIdOf(request) !== poolId) throw new NotFound();
      if (!SELECTABLE_STATUSES.has(request.request.status) || epochNanos(settlementDeadlineOf(request)) <= now) {
        throw new Conflict('Only unexpired ready or blocked requests can be deferred or returned', REQUEST_NOT_READY);
      }
      if (deferred) {
        const inserted = await trx
          .insertInto('settlement_deferred_requests')
          .values({ pool_id: poolId, family: ref.type, request_id: ref.requestId, deferred_at: at })
          .onConflict((conflicting) => conflicting.doNothing())
          .executeTakeFirst();
        if (inserted.numInsertedOrUpdatedRows === 0n) return;
      } else {
        const removed = await trx
          .deleteFrom('settlement_deferred_requests')
          .where('pool_id', '=', poolId)
          .where('family', '=', ref.type)
          .where('request_id', '=', ref.requestId)
          .executeTakeFirst();
        if (removed.numDeletedRows === 0n) return;
        // A returned request joins its own family's queue at the tail.
        const sequence = await nextArrival(trx, poolId, ref.type);
        await trx
          .updateTable(requestTable(ref.type))
          .set({ arrival_sequence: sequence, status: 'READY', error_code: null, error: null, updated_at: at })
          .where('id', '=', ref.requestId)
          .execute();
      }
      await trx
        .updateTable('pool_request_queues')
        .set({ blocked_version: null, updated_at: at })
        .where('pool_id', '=', poolId)
        .where('family', '=', ref.type)
        .execute();
    });
  }

  async history(
    poolId: string,
    type: Family | null,
    status: SettlementStatus | null,
    before: string | null,
    limit: number,
  ): Promise<History> {
    if (type !== null) requireFamily(type);
    requirePageSize(limit);
    const boundary = before === null ? null : cursorBoundary(before);
    let query = this.db.selectFrom('settlement_batches').selectAll().where('pool_id', '=', poolId);
    if (type !== null) query = query.where(sql<boolean>`requests->0->>'type'=${type}`);
    if (status !== null) query = query.where('status', '=', status);
    if (boundary !== null) {
      query = query.where(sql<boolean>`(created_at,id)<(${boundary.createdAt}::timestamptz,${boundary.id}::uuid)`);
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(toSettlement);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? historyCursor(last) : null };
  }

  async list(poolId: string | null): Promise<Settlement[]> {
    let query = this.db.selectFrom('settlement_batches').selectAll();
    if (poolId !== null) query = query.where('pool_id', '=', poolId);
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(LIST_LIMIT).execute();
    return rows.map(toSettlement);
  }

  async automaticPools(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('pool_request_queues')
      .select('pool_id')
      .distinct()
      .where('automatic_enabled', '=', true)
      .orderBy('pool_id')
      .execute();
    return rows.map((row) => row.pool_id);
  }

  async pending(): Promise<Pending[]> {
    const rows = await this.db
      .selectFrom('settlement_batches')
      .selectAll()
      .where('status', 'in', ACTIVE_BATCH_STATUSES)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const pending: Pending[] = [];
    for (const row of rows) pending.push(await this.readPending(this.db, row));
    return pending;
  }

  async claim(
    poolId: string,
    id: string,
    trigger: Trigger,
    snapshot: Snapshot,
    now: bigint,
    intent: Selection | null = null,
  ): Promise<Pending | undefined> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const state = await this.lockQueue(trx, poolId);
        if (await this.findIntent(poolId, id, intent, trx)) return undefined;
        if (state.activeId !== null) {
          if (trigger === 'MANUAL') throw new Conflict('This pool already has a settlement in flight', BATCH_IN_FLIGHT);
          return undefined;
        }
        await this.expireReady(trx, poolId, now);
        const blocked =
          trigger === 'AUTOMATIC'
            ? await trx
                .selectFrom('pool_request_queues')
                .select('family')
                .where('pool_id', '=', poolId)
                .where('blocked_version', '=', snapshot.version)
                .execute()
            : [];
        const selected =
          intent === null
            ? select(
                await this.queue(poolId, trx),
                state.policies,
                state.lastProcessedFamily,
                new Set(blocked.map((row) => row.family)),
                trigger === 'AUTOMATIC',
              )
            : await this.selected(trx, poolId, familyPolicy(state, intent.type), snapshot, intent);
        const [first] = selected;
        if (!first) return undefined;
        const policy = familyPolicy(state, first.type);
        const limit = this.policyLimit(policy);
        if (limit !== null) throw new Conflict(limit, 'POLICY_LIMIT_EXCEEDED');
        const refs = selected.map(reference);
        const at = instantText(now);
        await trx
          .insertInto('settlement_batches')
          .values({
            id,
            pool_id: poolId,
            trigger,
            status: 'PREPARING',
            requests: jsonText(refs),
            policy_version: policy.version,
            command_id: id,
            begin_offset: snapshot.ledgerOffset,
            state_version: snapshot.version,
            reserves_before: jsonText(snapshot.reserves),
            created_at: at,
            updated_at: at,
            retry_of: intent?.retryOf ?? null,
            selection: intent === null ? null : jsonText(intent),
          })
          .execute();
        for (const ref of refs) {
          await trx
            .updateTable(requestTable(ref.type))
            .set({ status: 'SETTLING', settlement_id: id, error_code: null, error: null, updated_at: at })
            .where('id', '=', ref.requestId)
            .where('status', 'in', [...SELECTABLE_STATUSES])
            .execute();
        }
        await trx
          .updateTable('pool_queues')
          .set({ active_settlement_id: id, last_processed_family: first.type, updated_at: at })
          .where('pool_id', '=', poolId)
          .execute();
        return this.pendingOf(trx, id);
      });
    } catch (error) {
      // The same operator key can race on two independent pool rows.
      if (!isUniqueViolation(error) || !(await this.findIntent(poolId, id, intent))) throw error;
      return undefined;
    }
  }

  async queue(poolId: string, db: Executor = this.db): Promise<QueueRequest[]> {
    const swaps = await sql<Selectable<SwapRequestsTable>>`
      SELECT * FROM swap_requests WHERE terms->>'poolId'=${poolId} AND arrival_sequence IS NOT NULL
        AND status IN ('SUBMITTING','UNRESOLVED','READY','BLOCKED','SETTLING','WITHDRAWING','WITHDRAWAL_UNRESOLVED')
        OR terms->>'poolId'=${poolId} AND status='EXPIRED' AND id IN
          (SELECT request_id FROM settlement_deferred_requests WHERE pool_id=${poolId} AND family='swap')`.execute(db);
    const liquidity = await sql<Selectable<LiquidityRequestsTable>>`
      SELECT * FROM liquidity_requests WHERE terms->>'poolId'=${poolId} AND arrival_sequence IS NOT NULL
        AND status IN ('SUBMITTING','UNRESOLVED','READY','BLOCKED','SETTLING','RECOVERING','RECOVERY_UNRESOLVED')
        OR terms->>'poolId'=${poolId} AND status='EXPIRED' AND id IN
          (SELECT request_id FROM settlement_deferred_requests
           WHERE pool_id=${poolId} AND family IN ('deposit','withdraw'))`.execute(db);
    const deferredRows = await db
      .selectFrom('settlement_deferred_requests')
      .select(['family', 'request_id'])
      .where('pool_id', '=', poolId)
      .execute();
    const deferred = new Set(deferredRows.map((row) => `${row.family}:${row.request_id}`));
    const isDeferred = (queued: QueueRequest) => deferred.has(`${queued.type}:${reference(queued).requestId}`);
    return [
      ...swaps.rows.map((row) => swapRequest(readSwap(row))),
      ...liquidity.rows.map((row) => liquidityRequest(readRequest(row))),
    ]
      .map((queued) => ({ ...queued, deferred: isDeferred(queued) }))
      .sort(queueOrder);
  }

  async pendingOf(db: Executor, id: string): Promise<Pending> {
    const row = await db.selectFrom('settlement_batches').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return this.readPending(db, row);
  }

  /** Drops only a suffix; later requests never jump a blocked request. */
  async keepPrefix(
    id: string,
    kept: readonly RequestRef[],
    blocked: RequestRef,
    code: string,
    reason: string,
    stateVersion: string,
    now: bigint,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const batch = await this.lockBatch(trx, id);
      if (batch.status !== 'PREPARING') return false;
      const blockedIndex = batch.requests.findIndex((ref) => sameRef(ref, blocked));
      if (blockedIndex < 0 || !sameRefs(batch.requests.slice(0, blockedIndex), kept)) return false;
      await this.release(trx, batch, batch.requests.slice(blockedIndex), blocked, code, reason, now);
      await this.blockFamily(trx, batch, stateVersion, now);
      if (kept.length === 0) {
        await this.finishAttempt(trx, batch, 'REJECTED', code, reason, now);
      } else {
        await trx
          .updateTable('settlement_batches')
          .set({ requests: jsonText(kept), updated_at: instantText(now) })
          .where('id', '=', id)
          .execute();
      }
      return true;
    });
  }

  async rejectPreparation(
    id: string,
    blocked: RequestRef,
    code: string,
    reason: string,
    stateVersion: string,
    now: bigint,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const batch = await this.lockBatch(trx, id);
      if (batch.status !== 'PREPARING') return;
      await this.release(trx, batch, batch.requests, blocked, code, reason, now);
      await this.blockFamily(trx, batch, stateVersion, now);
      await this.finishAttempt(trx, batch, 'REJECTED', code, reason, now);
    });
  }

  async cancelPreparation(id: string, code: string, reason: string | null, now: bigint): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const batch = await this.lockBatch(trx, id);
      if (batch.status !== 'PREPARING') return;
      await this.release(trx, batch, batch.requests, null, null, null, now);
      await this.finishAttempt(trx, batch, 'CANCELLED', code, reason, now);
    });
  }

  /** Commits the right to submit before any network call. Disabling serializes on this row. */
  async authorizeDispatch(
    id: string,
    fills: readonly Fill[],
    snapshot: Snapshot,
    now: bigint,
  ): Promise<Pending | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const batch = await this.lockBatch(trx, id);
      const [first] = batch.requests;
      if (batch.status !== 'PREPARING' || !first) return undefined;
      const state = await this.lockQueue(trx, batch.poolId);
      const policy = familyPolicy(state, first.type);
      const cancel = async (code: string, reason: string) => {
        await this.release(trx, batch, batch.requests, null, null, null, now);
        await this.finishAttempt(trx, batch, 'CANCELLED', code, reason, now);
        return undefined;
      };
      const limit = this.policyLimit(policy);
      if (limit !== null) return cancel('POLICY_LIMIT_EXCEEDED', limit);
      if (batch.trigger === 'AUTOMATIC' && (!policy.automaticEnabled || policy.version !== batch.policyVersion)) {
        return cancel(POLICY_CHANGED, 'Automatic policy changed before dispatch');
      }
      if (!sameRefs(batch.requests, fills.map(fillRef))) return undefined;
      const pending = await this.pendingOf(trx, id);
      const intent = pending.selection;
      if (intent !== null && (intent.stateVersion !== snapshot.version || intent.policyVersion !== policy.version)) {
        return cancel(
          intent.stateVersion !== snapshot.version ? POOL_CHANGED : POLICY_CHANGED,
          'The preview changed before dispatch. Refresh it before trying again.',
        );
      }
      if (pending.requests.some((queued) => epochNanos(settlementDeadlineOf(queued)) <= now)) {
        return cancel('DEADLINE_PASSED', 'A request expired before dispatch');
      }
      await trx
        .updateTable('settlement_batches')
        .set({
          status: 'SUBMITTING',
          fills: jsonText(fills),
          reserves_before: jsonText(snapshot.reserves),
          state_version: snapshot.version,
          begin_offset: snapshot.ledgerOffset,
          updated_at: instantText(now),
        })
        .where('id', '=', id)
        .where('status', '=', 'PREPARING')
        .execute();
      return this.pendingOf(trx, id);
    });
  }

  async unresolved(id: string, now: bigint): Promise<void> {
    await markUnresolved(this.db, id, now, ['SUBMITTING']);
  }

  async beginRecovery(id: string, now: bigint): Promise<boolean> {
    return (await markUnresolved(this.db, id, now, ['SUBMITTING', 'UNRESOLVED'])) === 1n;
  }

  async rejectSubmission(id: string, code: string, reason: string, now: bigint): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const batch = await this.lockBatch(trx, id);
      // Recovery may already have replayed the immutable command. A late first-attempt rejection
      // cannot prove that the replay did not commit.
      const [first] = batch.requests;
      if (batch.status !== 'SUBMITTING' || !first) return;
      await this.release(trx, batch, batch.requests, first, code, reason, now);
      const { state_version: version } = await trx
        .selectFrom('settlement_batches')
        .select('state_version')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      await this.blockFamily(trx, batch, version, now);
      await this.finishAttempt(trx, batch, 'REJECTED', code, reason, now);
    });
  }

  /** Applies proof that this batch cannot commit, without inferring any withdrawal. */
  async excludeSubmission(id: string, code: string, reason: string, now: bigint): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const batch = await this.lockBatch(trx, id);
      if (batch.status !== 'SUBMITTING' && batch.status !== 'UNRESOLVED') return;
      await this.release(trx, batch, batch.requests, null, null, null, now);
      await this.finishAttempt(trx, batch, 'REJECTED', code, reason, now);
      await this.clearFamily(trx, batch, now);
    });
  }

  async confirm(id: string, confirmation: Confirmation): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const batch = await this.lockBatch(trx, id);
      if (batch.status === 'CONFIRMED') return;
      if (batch.status !== 'SUBMITTING' && batch.status !== 'UNRESOLVED') {
        throw new Error('Settlement confirmation has no authorized submission');
      }
      if (!sameRefs(batch.requests, confirmation.fills.map(fillRef))) {
        throw new Error('Settlement confirmation does not match the frozen batch');
      }
      const at = confirmation.confirmedAt;
      await trx
        .updateTable('settlement_batches')
        .set({
          status: 'CONFIRMED',
          fills: jsonText(confirmation.fills),
          reserves_before: jsonText(confirmation.before),
          reserves_after: jsonText(confirmation.after),
          update_id: confirmation.updateId,
          error_code: null,
          error: null,
          updated_at: at,
        })
        .where('id', '=', id)
        .execute();
      for (const fill of confirmation.fills) await this.confirmRequest(trx, fill, id, confirmation.updateId, at);
      await this.clearFamily(trx, batch, epochNanos(at));
      await trx
        .updateTable('pool_queues')
        .set({ active_settlement_id: null, updated_at: at })
        .where('pool_id', '=', batch.poolId)
        .where('active_settlement_id', '=', id)
        .execute();
    });
  }

  /** The queue state under the queue lock; ready requests past their deadline expire first. */
  async monitoring(poolId: string, snapshot: Snapshot, now: bigint): Promise<Monitoring> {
    return this.db.transaction().execute(async (trx) => {
      const state = await this.lockQueue(trx, poolId);
      await this.expireReady(trx, poolId, now);
      const requests = await this.queue(poolId, trx);
      const blocked = requests.find((queued) => !queued.deferred && queued.request.status === 'BLOCKED');
      return {
        poolId,
        policies: state.policies,
        readyCount: requests.filter((queued) => !queued.deferred && queued.request.status === 'READY').length,
        pendingCount: requests.filter((queued) => PENDING_STATUSES.has(queued.request.status)).length,
        blockedRequest: blocked ? reference(blocked) : null,
        blockedReason: blocked?.request.error ?? null,
        oldestSubmittedAt: earliest(requests.flatMap((queued) => queued.request.submittedAt ?? [])),
        nearestDeadline: earliest(requests.map(settlementDeadlineOf)),
        activeSettlement: state.activeId === null ? null : await this.get(state.activeId, trx),
        pool: snapshot,
      };
    });
  }

  private policyLimit(policy: Policy): string | null {
    return policy.batchSize > this.maxBatchSize
      ? `Saved batch size ${String(policy.batchSize)} exceeds the current maximum ${String(this.maxBatchSize)}. ` +
          "Update this queue's settlement policy before dispatching."
      : null;
  }

  /** Locks the pool's queue, creating it and its family policies on first use. */
  private async lockQueue(trx: Executor, poolId: string): Promise<QueueState> {
    await sql`INSERT INTO pool_queues(pool_id) SELECT pool_id FROM pools WHERE pool_id=${poolId}
      ON CONFLICT DO NOTHING`.execute(trx);
    // Request admission takes this same pool lock before it creates a family queue.
    const queue = await trx
      .selectFrom('pool_queues')
      .select(['active_settlement_id', 'last_processed_family'])
      .where('pool_id', '=', poolId)
      .forUpdate()
      .executeTakeFirst();
    if (!queue) throw new NotFound();
    for (const family of FAMILIES) {
      await trx
        .insertInto('pool_request_queues')
        .values({ pool_id: poolId, family, batch_size: initialBatchSize(this.maxBatchSize) })
        .onConflict((conflicting) => conflicting.doNothing())
        .execute();
    }
    const policies = await trx
      .selectFrom('pool_request_queues')
      .selectAll()
      .where('pool_id', '=', poolId)
      .orderBy('family')
      .execute();
    return {
      policies: policies.map((row) => this.toPolicy(row)),
      activeId: queue.active_settlement_id,
      lastProcessedFamily: queue.last_processed_family,
    };
  }

  private toPolicy(row: Selectable<PoolRequestQueuesTable>): Policy {
    return {
      poolId: row.pool_id,
      type: row.family,
      automaticEnabled: row.automatic_enabled,
      batchSize: row.batch_size,
      maxBatchSize: this.maxBatchSize,
      version: row.policy_version,
      updatedAt: isoInstant(row.updated_at),
    };
  }

  private async lockBatch(trx: Executor, id: string): Promise<Settlement> {
    const batch = await this.get(id, trx);
    await this.lockQueue(trx, batch.poolId);
    const row = await trx
      .selectFrom('settlement_batches')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    return toSettlement(row);
  }

  /** Ready and blocked requests past their settlement deadline expire and unblock their family. */
  private async expireReady(trx: Executor, poolId: string, now: bigint): Promise<void> {
    const at = instantText(now);
    for (const family of FAMILIES) {
      const kind = family === 'swap' ? sql`` : sql`AND kind=${family.toUpperCase()}`;
      const result = await sql`
        UPDATE ${sql.table(requestTable(family))} SET status='EXPIRED',error_code='DEADLINE_PASSED',
          error=${EXPIRY_REASON},updated_at=${at}::timestamptz
        WHERE terms->>'poolId'=${poolId} AND status IN ('READY','BLOCKED')
          AND (terms->>'settlementDeadline')::timestamptz<=${at}::timestamptz ${kind}`.execute(trx);
      if ((result.numAffectedRows ?? 0n) > 0n) {
        await trx
          .updateTable('pool_request_queues')
          .set({ blocked_version: null, updated_at: at })
          .where('pool_id', '=', poolId)
          .where('family', '=', family)
          .execute();
      }
    }
  }

  /** Blocks the family at this pool version only when the batch began at the family's head. */
  private async blockFamily(trx: Executor, batch: Settlement, version: string, now: bigint): Promise<void> {
    const [first] = batch.requests;
    if (!first) return;
    // A failed request selected further down the queue says nothing about its head.
    const head = (await this.queue(batch.poolId, trx)).find((queued) => queued.type === first.type && !queued.deferred);
    if (!head || !sameRef(reference(head), first)) return;
    await trx
      .updateTable('pool_request_queues')
      .set({ blocked_version: version, updated_at: instantText(now) })
      .where('pool_id', '=', batch.poolId)
      .where('family', '=', first.type)
      .execute();
  }

  private async clearFamily(trx: Executor, batch: Settlement, now: bigint): Promise<void> {
    const [first] = batch.requests;
    if (!first) return;
    await trx
      .updateTable('pool_request_queues')
      .set({ blocked_version: null, updated_at: instantText(now) })
      .where('pool_id', '=', batch.poolId)
      .where('family', '=', first.type)
      .execute();
  }

  /** Returns the batch's requests to their queue: expired, blocked or ready again. */
  private async release(
    trx: Executor,
    batch: Settlement,
    refs: readonly RequestRef[],
    blocked: RequestRef | null,
    code: string | null,
    reason: string | null,
    now: bigint,
  ): Promise<void> {
    const at = instantText(now);
    const blockedId = blocked?.requestId ?? null;
    for (const ref of refs) {
      await sql`
        UPDATE ${sql.table(requestTable(ref.type))} SET
          status=CASE WHEN (terms->>'settlementDeadline')::timestamptz<=${at}::timestamptz THEN 'EXPIRED'
            WHEN id=${blockedId}::uuid THEN 'BLOCKED' ELSE 'READY' END,
          error_code=CASE WHEN (terms->>'settlementDeadline')::timestamptz<=${at}::timestamptz THEN 'DEADLINE_PASSED'
            WHEN id=${blockedId}::uuid THEN ${code}::text ELSE NULL END,
          error=CASE WHEN (terms->>'settlementDeadline')::timestamptz<=${at}::timestamptz
            THEN ${RELEASE_EXPIRY_REASON} WHEN id=${blockedId}::uuid THEN ${reason}::text ELSE NULL END,
          settlement_id=NULL,updated_at=${at}::timestamptz
        WHERE id=${ref.requestId} AND settlement_id=${batch.settlementId} AND status='SETTLING'`.execute(trx);
    }
  }

  private async finishAttempt(
    trx: Executor,
    batch: Settlement,
    status: SettlementStatus,
    code: string | null,
    reason: string | null,
    now: bigint,
  ): Promise<void> {
    const at = instantText(now);
    await trx
      .updateTable('settlement_batches')
      .set({ status, error_code: code, error: reason, updated_at: at })
      .where('id', '=', batch.settlementId)
      .execute();
    await trx
      .updateTable('pool_queues')
      .set({ active_settlement_id: null, updated_at: at })
      .where('pool_id', '=', batch.poolId)
      .where('active_settlement_id', '=', batch.settlementId)
      .execute();
  }

  private async readPending(db: Executor, row: BatchRow): Promise<Pending> {
    const settlement = toSettlement(row);
    const requests: QueueRequest[] = [];
    for (const ref of settlement.requests) {
      const queued = await this.findRequest(db, ref);
      if (!queued) throw new Error('Stored settlement request is missing or mismatched');
      requests.push(queued);
    }
    return {
      settlement,
      requests,
      commandId: row.command_id,
      beginOffset: row.begin_offset,
      stateVersion: row.state_version,
      selection: row.selection === null ? null : stored('settlement selection', row.selection, readSelection),
    };
  }

  /** The request that a public reference names, when its family matches. */
  private async findRequest(db: Executor, ref: RequestRef): Promise<QueueRequest | undefined> {
    if (ref.type === 'swap') {
      const row = await db.selectFrom('swap_requests').selectAll().where('id', '=', ref.requestId).executeTakeFirst();
      return row ? swapRequest(readSwap(row)) : undefined;
    }
    const row = await db
      .selectFrom('liquidity_requests')
      .selectAll()
      .where('id', '=', ref.requestId)
      .executeTakeFirst();
    const queued = row ? liquidityRequest(readRequest(row)) : undefined;
    return queued && sameRef(reference(queued), ref) ? queued : undefined;
  }

  private async confirmRequest(
    trx: Executor,
    fill: Fill,
    settlementId: string,
    updateId: string,
    at: string,
  ): Promise<void> {
    const result =
      fill.type === 'swap'
        ? await trx
            .updateTable('swap_requests')
            .set({ status: 'SETTLED', amount_out: fill.amountOut, update_id: updateId, error_code: null, error: null })
            .set({ updated_at: at })
            .where('id', '=', fill.requestId)
            .where('settlement_id', '=', settlementId)
            .where('status', 'in', ['SETTLING', 'WITHDRAWING', 'WITHDRAWAL_UNRESOLVED', 'EXPIRED', 'SETTLED'])
            .executeTakeFirst()
        : await trx
            .updateTable('liquidity_requests')
            .set({ status: 'SETTLED', result: jsonText(liquidityResult(fill)), update_id: updateId })
            .set({ error_code: null, error: null, updated_at: at })
            .where('id', '=', fill.requestId)
            .where('settlement_id', '=', settlementId)
            .where('status', 'in', ['SETTLING', 'RECOVERING', 'RECOVERY_UNRESOLVED', 'EXPIRED', 'SETTLED'])
            .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error('Conflicting terminal request evidence');
  }
}

/** The liquidity request result of a deposit or withdrawal fill. */
function liquidityResult(fill: Exclude<Fill, { type: 'swap' }>) {
  return fill.type === 'deposit'
    ? {
        actualBaseIn: fill.actualBaseIn,
        actualQuoteIn: fill.actualQuoteIn,
        actualBaseRefund: fill.actualBaseRefund,
        actualQuoteRefund: fill.actualQuoteRefund,
        actualLpOut: fill.actualLpOut,
      }
    : { actualLpBurned: fill.actualLpBurned, actualBaseOut: fill.actualBaseOut, actualQuoteOut: fill.actualQuoteOut };
}

/** Marks a sent batch as awaiting confirmation; the answer is the number of rows changed. */
async function markUnresolved(
  db: Executor,
  id: string,
  now: bigint,
  from: readonly SettlementStatus[],
): Promise<bigint> {
  const result = await db
    .updateTable('settlement_batches')
    .set({
      status: 'UNRESOLVED',
      error_code: 'CONFIRMATION_PENDING',
      error: 'Settlement confirmation is pending',
      updated_at: instantText(now),
    })
    .where('id', '=', id)
    .where('status', 'in', from)
    .executeTakeFirst();
  return result.numUpdatedRows;
}
