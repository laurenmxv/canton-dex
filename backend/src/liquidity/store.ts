import { sql, type Kysely, type Selectable } from 'kysely';
import { Value } from 'typebox/value';
import type { Account } from '../iam/accounts.js';
import { lockForAdmission, lockPoolQueue, nextArrival, unblockFamily } from '../operations/queues.js';
import type { Database, LiquidityPreparationsTable, LiquidityRequestsTable } from '../platform/database.js';
import { Conflict, InvalidRequest, NotFound } from '../platform/errors.js';
import { jsonText } from '../platform/json.js';
import { enumeration, list, pathUuid, present, requirePageSize, text } from '../platform/request.js';
import { stored } from '../platform/stored.js';
import { clockNanos, epochNanos, instantText, isoInstant } from '../platform/time.js';
import type { Before } from '../swaps/model.js';
import {
  DepositResult,
  WithdrawalResult,
  familyOf,
  kindOf,
  LIQUIDITY_STATUSES,
  type Activity,
  type Confirmation,
  DepositQuote,
  DepositTerms,
  type Kind,
  type LiquidityAction,
  type Pending,
  type Request,
  SigningPayload,
  type Terms,
  WithdrawalQuote,
  WithdrawalTerms,
} from './model.js';
import type { LiquidityHistory, LiquidityProgress, LiquidityRejected } from './ports.js';

type Executor = Kysely<Database>;
type RequestRow = Selectable<LiquidityRequestsTable>;
type PreparationColumns = Pick<
  Selectable<LiquidityPreparationsTable>,
  'command_id' | 'action' | 'signing' | 'signature' | 'begin_offset'
> & { readonly preparation_id: string };

const CONFIRMATIONS = new Set(['READY', 'SETTLED', 'RECOVERED', 'EXPIRED']);
const TERMINAL = new Set(['SETTLED', 'RECOVERED']);
/** Statuses in which confirmed allocations may still be locked. */
const RECOVERABLE = new Set(['READY', 'BLOCKED', 'SETTLING', 'EXPIRED']);
const IN_FLIGHT = ['SUBMITTING', 'UNRESOLVED'] as const;
const TRACKED = ['READY', 'BLOCKED', 'EXPIRED', 'SETTLING', 'RECOVERING', 'RECOVERY_UNRESOLVED'] as const;

/** A stored liquidity request; locked allocations become recoverable after the deadline. */
export function readRequest(row: RequestRow): Request {
  const kind = row.kind;
  const terms = stored('liquidity terms', row.terms, (value) =>
    Value.Decode(kind === 'DEPOSIT' ? DepositTerms : WithdrawalTerms, value),
  );
  const status = present(enumeration(row.status, LIQUIDITY_STATUSES), 'liquidity status');
  const allocationCids = stored('allocation ids', row.allocation_cids, (value) =>
    list(value, (item) => present(text(item), 'allocation id')),
  );
  const canRecover =
    allocationCids.length > 0 && epochNanos(terms.settlementDeadline) <= clockNanos() && RECOVERABLE.has(status);
  return {
    requestId: row.id,
    quoteId: row.quote_id,
    kind,
    terms,
    status,
    arrivalSequence: row.arrival_sequence,
    createdAt: isoInstant(row.created_at),
    submittedAt: row.submitted_at === null ? null : isoInstant(row.submitted_at),
    updatedAt: isoInstant(row.updated_at),
    settlementId: row.settlement_id,
    result:
      row.result === null
        ? null
        : stored('liquidity result', row.result, (value) =>
            Value.Decode(kind === 'DEPOSIT' ? DepositResult : WithdrawalResult, value),
          ),
    allocationCids,
    updateId: row.update_id,
    errorCode: row.error_code,
    error: row.error,
    canRecover,
  };
}

function toPending(row: RequestRow & PreparationColumns): Pending {
  return {
    request: readRequest(row),
    accountId: row.account_id,
    preparationId: row.preparation_id,
    commandId: row.command_id,
    action: row.action,
    signing: stored('liquidity signing', row.signing, (value) => Value.Decode(SigningPayload, value)),
    signature: row.signature,
    beginOffset: row.begin_offset ?? 0n,
  };
}

/** Preparations with their requests, in one read. */
function pendingQuery(db: Executor) {
  return db
    .selectFrom('liquidity_preparations as p')
    .innerJoin('liquidity_requests as s', 's.id', 'p.request_id')
    .selectAll('s')
    .select(['p.id as preparation_id', 'p.command_id', 'p.action', 'p.signing', 'p.signature', 'p.begin_offset']);
}

/** Durable liquidity requests. A transaction that locks the pool queue row locks it before any request row. */
export class LiquidityStore implements LiquidityProgress, LiquidityHistory {
  constructor(
    private readonly db: Executor,
    private readonly maxBatchSize: number,
  ) {
    if (maxBatchSize < 1) throw new RangeError('Maximum batch size must be positive');
  }

  async saveDepositQuote(quote: DepositQuote, caller: Account): Promise<void> {
    await this.saveQuote(quote.quoteId, 'DEPOSIT', jsonText(quote), caller);
  }

  async saveWithdrawalQuote(quote: WithdrawalQuote, caller: Account): Promise<void> {
    await this.saveQuote(quote.quoteId, 'WITHDRAW', jsonText(quote), caller);
  }

  private async saveQuote(id: string, kind: Kind, payload: string, caller: Account): Promise<void> {
    await this.db.insertInto('liquidity_quotes').values({ id, account_id: caller.id, kind, payload }).execute();
  }

  async depositQuote(id: string, caller: Account): Promise<DepositQuote> {
    return stored('deposit quote', await this.quote(id, caller, 'DEPOSIT'), (value) =>
      Value.Decode(DepositQuote, value),
    );
  }

  async withdrawalQuote(id: string, caller: Account): Promise<WithdrawalQuote> {
    return stored('withdrawal quote', await this.quote(id, caller, 'WITHDRAW'), (value) =>
      Value.Decode(WithdrawalQuote, value),
    );
  }

  private async quote(id: string, caller: Account, kind: Kind): Promise<string> {
    const row = await this.db
      .selectFrom('liquidity_quotes')
      .select('payload')
      .where('id', '=', id)
      .where('account_id', '=', caller.id)
      .where('kind', '=', kind)
      .executeTakeFirst();
    if (!row) throw new NotFound();
    return row.payload;
  }

  async preparedQuote(quoteId: string, caller: Account, db: Executor = this.db): Promise<Pending | undefined> {
    const row = await pendingQuery(db)
      .where('s.quote_id', '=', quoteId)
      .where('s.account_id', '=', caller.id)
      .where('p.action', '=', 'SUBMIT')
      .executeTakeFirst();
    return row ? toPending(row) : undefined;
  }

  async savePreparation(
    requestId: string,
    preparationId: string,
    commandId: string,
    quoteId: string,
    caller: Account,
    terms: Terms,
    signing: SigningPayload,
  ): Promise<Pending> {
    return this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('liquidity_requests')
        .values({
          id: requestId,
          account_id: caller.id,
          quote_id: quoteId,
          kind: kindOf(terms),
          terms: jsonText(terms),
          status: 'PREPARED',
        })
        .onConflict((conflict) => conflict.column('quote_id').doNothing())
        .execute();
      const actual = await trx
        .selectFrom('liquidity_requests')
        .select('id')
        .where('quote_id', '=', quoteId)
        .where('account_id', '=', caller.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (actual.id === requestId) {
        await this.insertPreparation(trx, preparationId, requestId, commandId, 'SUBMIT', signing);
      }
      const prepared = await this.preparedQuote(quoteId, caller, trx);
      if (!prepared) throw new Error('Stored liquidity preparation is missing');
      return prepared;
    });
  }

  async latestRecovery(requestId: string, caller: Account, db: Executor = this.db): Promise<Pending | undefined> {
    await this.owned(requestId, caller, db);
    const row = await pendingQuery(db)
      .where('p.request_id', '=', requestId)
      .where('p.action', '=', 'RECOVER')
      .where('p.status', '<>', 'FAILED')
      .orderBy('p.created_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? toPending(row) : undefined;
  }

  async saveRecovery(
    requestId: string,
    preparationId: string,
    commandId: string,
    caller: Account,
    signing: SigningPayload,
    now: bigint,
  ): Promise<Pending> {
    return this.db.transaction().execute(async (trx) => {
      await this.ownedLocked(trx, requestId, caller);
      const previous = await this.latestRecovery(requestId, caller, trx);
      if (previous && (previous.signature !== null || epochNanos(previous.signing.expiresAt) > now)) return previous;
      await this.insertPreparation(trx, preparationId, requestId, commandId, 'RECOVER', signing);
      return this.pending(preparationId, trx);
    });
  }

  private async insertPreparation(
    trx: Executor,
    id: string,
    requestId: string,
    commandId: string,
    action: LiquidityAction,
    signing: SigningPayload,
  ): Promise<void> {
    await trx
      .insertInto('liquidity_preparations')
      .values({
        id,
        request_id: requestId,
        command_id: commandId,
        action,
        signing: jsonText(signing),
        status: 'PREPARED',
      })
      .execute();
  }

  async begin(
    preparationId: string,
    caller: Account,
    signature: string,
    offset: bigint,
    now: bigint,
  ): Promise<boolean> {
    const pending = await this.pendingOwned(preparationId, caller);
    const at = instantText(now);
    return this.db.transaction().execute(async (trx) => {
      const poolId = pending.request.terms.poolId;
      const family = familyOf(pending.request.kind);
      await lockForAdmission(trx, poolId, family, this.maxBatchSize);
      await this.ownedLocked(trx, pending.request.requestId, caller);
      const previous = await trx
        .selectFrom('liquidity_preparations')
        .select('status')
        .where('id', '=', preparationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const current = await this.pending(preparationId, trx);
      if (current.signature !== null && current.signature !== signature) {
        throw new Conflict('This preparation already has a different signature', 'IDEMPOTENCY_CONFLICT');
      }
      if (previous.status !== 'PREPARED') return false;
      if (epochNanos(current.signing.expiresAt) <= now) {
        throw new Conflict('Request a new quote and sign a new transaction', 'PREPARATION_EXPIRED');
      }
      if (pending.action === 'SUBMIT') {
        if (current.request.status !== 'PREPARED') {
          throw new Conflict('The request is no longer awaiting submission', 'INVALID_REQUEST_STATE');
        }
        if (epochNanos(current.request.terms.settlementDeadline) <= now) {
          throw new Conflict('The settlement deadline has elapsed', 'DEADLINE_ELAPSED');
        }
        const sequence = await nextArrival(trx, poolId, family);
        await trx
          .updateTable('liquidity_requests')
          .set({
            status: 'SUBMITTING',
            arrival_sequence: sequence,
            submitted_at: at,
            updated_at: at,
            error_code: null,
            error: null,
          })
          .where('id', '=', current.request.requestId)
          .execute();
      } else {
        if (!current.request.canRecover)
          throw new Conflict('This request cannot be withdrawn now', 'RECOVERY_UNAVAILABLE');
        await trx
          .updateTable('liquidity_requests')
          .set({ status: 'RECOVERING', updated_at: at, error_code: null, error: null })
          .where('id', '=', current.request.requestId)
          .execute();
      }
      // A recovery reads history from the request's own submission, so an earlier direct
      // wallet withdrawal of its allocations counts too.
      const historyOffset =
        pending.action === 'RECOVER' ? await this.submissionOffset(trx, current.request.requestId) : offset;
      await trx
        .updateTable('liquidity_preparations')
        .set({ status: 'SUBMITTING', signature, begin_offset: historyOffset, updated_at: at })
        .where('id', '=', preparationId)
        .execute();
      return true;
    });
  }

  private async submissionOffset(trx: Executor, requestId: string): Promise<bigint> {
    const rows = await trx
      .selectFrom('liquidity_preparations')
      .select('begin_offset')
      .where('request_id', '=', requestId)
      .where('action', '=', 'SUBMIT')
      .where('status', '=', 'CONFIRMED')
      .execute();
    const [row] = rows;
    if (rows.length !== 1 || !row) throw new Error('A recovery requires one confirmed submission');
    return present(row.begin_offset, 'submission begin offset');
  }

  async confirm(preparationId: string, confirmation: Confirmation): Promise<void> {
    if (!CONFIRMATIONS.has(confirmation.status)) throw new Error('Unexpected ledger confirmation status');
    await this.db.transaction().execute(async (trx) => {
      const pending = await this.pending(preparationId, trx);
      const request = pending.request;
      await lockPoolQueue(trx, request.terms.poolId);
      const { status: current } = await trx
        .selectFrom('liquidity_requests')
        .select('status')
        .where('id', '=', request.requestId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (TERMINAL.has(current) && current !== confirmation.status) {
        // A late submission observation must not undo a later settlement or recovery.
        if (confirmation.status === 'READY' || confirmation.status === 'EXPIRED') {
          await this.finishPreparation(trx, preparationId);
          return;
        }
        throw new Error('Conflicting terminal ledger evidence');
      }
      if (confirmation.status === 'READY' && !['SUBMITTING', 'UNRESOLVED', 'READY'].includes(current)) {
        await this.finishPreparation(trx, preparationId);
        return;
      }
      const result = confirmation.result === null ? null : jsonText(confirmation.result);
      await sql`UPDATE liquidity_requests SET status=${confirmation.status},
          allocation_cids=${jsonText(confirmation.allocationCids)}::jsonb,result=COALESCE(${result}::jsonb,result),
          update_id=${confirmation.updateId},updated_at=${confirmation.confirmedAt}::timestamptz,
          error_code=NULL,error=NULL
        WHERE id=${request.requestId}`.execute(trx);
      await this.finishPreparation(trx, preparationId);
      if (TERMINAL.has(confirmation.status)) {
        await unblockFamily(trx, request.terms.poolId, familyOf(request.kind));
      }
    });
  }

  private async finishPreparation(trx: Executor, id: string): Promise<void> {
    await trx
      .updateTable('liquidity_preparations')
      .set({ status: 'CONFIRMED', updated_at: sql<string>`now()` })
      .where('id', '=', id)
      .execute();
  }

  async uncertain(preparationId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const pending = await this.pending(preparationId, trx);
      await lockPoolQueue(trx, pending.request.terms.poolId);
      await trx
        .updateTable('liquidity_preparations')
        .set({ status: 'UNRESOLVED', updated_at: sql<string>`now()` })
        .where('id', '=', preparationId)
        .where('status', '=', 'SUBMITTING')
        .execute();
      const submit = pending.action === 'SUBMIT';
      await trx
        .updateTable('liquidity_requests')
        .set({
          status: submit ? 'UNRESOLVED' : 'RECOVERY_UNRESOLVED',
          error_code: 'CONFIRMATION_PENDING',
          error: 'Waiting for ledger confirmation',
          updated_at: sql<string>`now()`,
        })
        .where('id', '=', pending.request.requestId)
        .where('status', '=', submit ? 'SUBMITTING' : 'RECOVERING')
        .execute();
    });
  }

  async rejected(preparationId: string, rejection: LiquidityRejected): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const pending = await this.pending(preparationId, trx);
      const request = pending.request;
      await lockPoolQueue(trx, request.terms.poolId);
      const changed = await trx
        .updateTable('liquidity_preparations')
        .set({ status: 'FAILED', updated_at: sql<string>`now()` })
        .where('id', '=', preparationId)
        .where('status', 'in', IN_FLIGHT)
        .executeTakeFirst();
      if (changed.numUpdatedRows === 0n) return;
      await trx
        .updateTable('liquidity_requests')
        .set({
          status: pending.action === 'SUBMIT' ? 'FAILED' : 'EXPIRED',
          error_code: rejection.code,
          error: rejection.message,
          updated_at: sql<string>`now()`,
        })
        .where('id', '=', request.requestId)
        .where('status', 'in', ['SUBMITTING', 'UNRESOLVED', 'RECOVERING', 'RECOVERY_UNRESOLVED'])
        .execute();
      await unblockFamily(trx, request.terms.poolId, familyOf(request.kind));
    });
  }

  async unresolved(): Promise<Pending[]> {
    const rows = await pendingQuery(this.db)
      .where('p.status', 'in', IN_FLIGHT)
      .orderBy('p.created_at')
      .orderBy('p.id')
      .execute();
    return rows.map(toPending);
  }

  async tracked(): Promise<Pending[]> {
    const rows = await pendingQuery(this.db)
      .where('p.action', '=', 'SUBMIT')
      .where('p.status', '=', 'CONFIRMED')
      .where('s.status', 'in', TRACKED)
      .orderBy('s.submitted_at')
      .orderBy('s.id')
      .execute();
    return rows.map(toPending);
  }

  async pendingOwned(id: string, caller: Account): Promise<Pending> {
    const pending = await this.pending(id);
    if (pending.accountId !== caller.id) throw new NotFound();
    return pending;
  }

  async pending(id: string, db: Executor = this.db): Promise<Pending> {
    const row = await pendingQuery(db).where('p.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFound();
    return toPending(row);
  }

  async owned(id: string, caller: Account, db: Executor = this.db): Promise<Request> {
    const row = await db
      .selectFrom('liquidity_requests')
      .selectAll()
      .where('id', '=', id)
      .where('account_id', '=', caller.id)
      .executeTakeFirst();
    if (!row) throw new NotFound();
    return readRequest(row);
  }

  private async ownedLocked(trx: Executor, id: string, caller: Account): Promise<void> {
    const row = await trx
      .selectFrom('liquidity_requests')
      .select('id')
      .where('id', '=', id)
      .where('account_id', '=', caller.id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new NotFound();
  }

  async get(id: string): Promise<Request> {
    const row = await this.db.selectFrom('liquidity_requests').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFound();
    return readRequest(row);
  }

  async activity(
    caller: Account,
    kind: Kind,
    limit: number,
    cursor: string | null,
    status: string | null,
  ): Promise<Activity> {
    requirePageSize(limit);
    const before = cursor === null ? null : pathUuid(cursor);
    if (status !== null && !LIQUIDITY_STATUSES.some((name) => name === status)) {
      throw new InvalidRequest('Unknown status');
    }
    // Cursor ownership is checked before it supplies the paging boundary.
    const boundary = before === null ? null : { createdAt: (await this.owned(before, caller)).createdAt, id: before };
    return this.activityBefore(caller, kind, limit, boundary, status);
  }

  async activityBefore(
    caller: Account,
    kind: Kind | null,
    limit: number,
    before: Before | null,
    status: string | null,
  ): Promise<Activity> {
    requirePageSize(limit);
    let query = this.db.selectFrom('liquidity_requests').selectAll().where('account_id', '=', caller.id);
    if (kind !== null) query = query.where('kind', '=', kind);
    if (status !== null) query = query.where('status', '=', status);
    if (before !== null) {
      query = query.where(sql<boolean>`(created_at,id)<(${before.createdAt}::timestamptz,${before.id}::uuid)`);
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(readRequest);
    return { items, nextCursor: rows.length > limit ? (items.at(-1)?.requestId ?? null) : null };
  }
}
