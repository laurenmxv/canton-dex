import { sql, type Kysely, type Selectable } from 'kysely';
import { Value } from 'typebox/value';
import type { Account } from '../iam/accounts.js';
import { lockForAdmission, lockPoolQueue, nextArrival, unblockFamily } from '../operations/queues.js';
import type { Database, SwapPreparationsTable, SwapRequestsTable } from '../platform/database.js';
import { Conflict, InvalidRequest, NotFound } from '../platform/errors.js';
import { jsonText } from '../platform/json.js';
import { enumeration, list, pathUuid, present, requirePageSize, text } from '../platform/request.js';
import { stored } from '../platform/stored.js';
import { clockNanos, epochNanos, instantText, isoInstant } from '../platform/time.js';
import {
  Quote,
  SigningPayload,
  SWAP_STATUSES,
  Terms,
  type Activity,
  type Before,
  type Confirmation,
  type Pending,
  type Swap,
  type SwapAction,
} from './model.js';
import type { SwapHistory, SwapProgress, SwapRejected } from './ports.js';

type Executor = Kysely<Database>;
type SwapRow = Selectable<SwapRequestsTable>;
type PreparationColumns = Pick<
  Selectable<SwapPreparationsTable>,
  'command_id' | 'action' | 'signing' | 'signature' | 'begin_offset'
> & { readonly preparation_id: string };

const CONFIRMATIONS = new Set(['READY', 'SETTLED', 'WITHDRAWN', 'EXPIRED']);
const TERMINAL = new Set(['SETTLED', 'WITHDRAWN']);
/** Statuses in which the allocations are released or already being reclaimed. */
const NOT_WITHDRAWABLE = new Set(['SETTLED', 'WITHDRAWN', 'WITHDRAWING', 'WITHDRAWAL_UNRESOLVED']);
const IN_FLIGHT = ['SUBMITTING', 'UNRESOLVED'] as const;
const TRACKED = ['READY', 'BLOCKED', 'EXPIRED', 'SETTLING', 'WITHDRAWING', 'WITHDRAWAL_UNRESOLVED'] as const;

function readAllocations(json: string): string[] {
  return stored('allocation ids', json, (value) => list(value, (item) => present(text(item), 'allocation id')));
}

/** A stored swap request; allocations become withdrawable once the settlement deadline passes. */
export function readSwap(row: SwapRow): Swap {
  const terms = stored('swap terms', row.terms, (value) => Value.Decode(Terms, value));
  const status = present(enumeration(row.status, SWAP_STATUSES), 'swap status');
  const allocationCids = readAllocations(row.allocation_cids);
  const canWithdraw =
    allocationCids.length > 0 && epochNanos(terms.settlementDeadline) <= clockNanos() && !NOT_WITHDRAWABLE.has(status);
  return {
    swapId: row.id,
    quoteId: row.quote_id,
    ...terms,
    status,
    arrivalSequence: row.arrival_sequence,
    createdAt: isoInstant(row.created_at),
    submittedAt: row.submitted_at === null ? null : isoInstant(row.submitted_at),
    updatedAt: isoInstant(row.updated_at),
    settlementId: row.settlement_id,
    amountOut: row.amount_out,
    allocationCids,
    updateId: row.update_id,
    errorCode: row.error_code,
    error: row.error,
    canWithdraw,
  };
}

function toPending(row: SwapRow & PreparationColumns): Pending {
  return {
    swap: readSwap(row),
    accountId: row.account_id,
    preparationId: row.preparation_id,
    commandId: row.command_id,
    action: row.action,
    signing: stored('swap signing', row.signing, (value) => Value.Decode(SigningPayload, value)),
    signature: row.signature,
    beginOffset: row.begin_offset ?? 0n,
  };
}

/** Preparations with their requests, in one read. */
function pendingQuery(db: Executor) {
  return db
    .selectFrom('swap_preparations as p')
    .innerJoin('swap_requests as s', 's.id', 'p.swap_id')
    .selectAll('s')
    .select(['p.id as preparation_id', 'p.command_id', 'p.action', 'p.signing', 'p.signature', 'p.begin_offset']);
}

/**
 * Persists business records and request progress through the shared database client.
 *
 * @remarks
 * Onboarding, Pools, Swaps, Liquidity and Tokens each own their business records. Only SwapStore
 * and LiquidityStore own settlement request rows and use admission helpers; SettlementStore
 * reads and updates those same rows for settlement.
 * A transaction that locks the pool queue row locks it before any request row.
 */
export class SwapStore implements SwapProgress, SwapHistory {
  constructor(
    private readonly db: Executor,
    private readonly maxBatchSize: number,
  ) {
    if (maxBatchSize < 1) throw new RangeError('Maximum batch size must be positive');
  }

  async saveQuote(quote: Quote, caller: Account): Promise<void> {
    await this.db
      .insertInto('swap_quotes')
      .values({ id: quote.quoteId, account_id: caller.id, payload: jsonText(quote) })
      .execute();
  }

  async quote(id: string, caller: Account): Promise<Quote> {
    const row = await this.db
      .selectFrom('swap_quotes')
      .select('payload')
      .where('id', '=', id)
      .where('account_id', '=', caller.id)
      .executeTakeFirst();
    if (!row) throw new NotFound();
    return stored('swap quote', row.payload, (value) => Value.Decode(Quote, value));
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
    swapId: string,
    preparationId: string,
    commandId: string,
    quoteId: string,
    caller: Account,
    terms: Terms,
    signing: SigningPayload,
  ): Promise<Pending> {
    return this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('swap_requests')
        .values({ id: swapId, account_id: caller.id, quote_id: quoteId, terms: jsonText(terms), status: 'PREPARED' })
        .onConflict((conflict) => conflict.column('quote_id').doNothing())
        .execute();
      const actual = await trx
        .selectFrom('swap_requests')
        .select('id')
        .where('quote_id', '=', quoteId)
        .where('account_id', '=', caller.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (actual.id === swapId) await this.insertPreparation(trx, preparationId, swapId, commandId, 'SUBMIT', signing);
      const prepared = await this.preparedQuote(quoteId, caller, trx);
      if (!prepared) throw new Error('Stored swap preparation is missing');
      return prepared;
    });
  }

  async latestWithdrawal(swapId: string, caller: Account, db: Executor = this.db): Promise<Pending | undefined> {
    await this.owned(swapId, caller, db);
    const row = await pendingQuery(db)
      .where('p.swap_id', '=', swapId)
      .where('p.action', '=', 'WITHDRAW')
      .where('p.status', '<>', 'FAILED')
      .orderBy('p.created_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? toPending(row) : undefined;
  }

  async saveWithdrawal(
    swapId: string,
    preparationId: string,
    commandId: string,
    caller: Account,
    signing: SigningPayload,
    now: bigint,
  ): Promise<Pending> {
    return this.db.transaction().execute(async (trx) => {
      await this.ownedLocked(trx, swapId, caller);
      const previous = await this.latestWithdrawal(swapId, caller, trx);
      if (previous && (previous.signature !== null || epochNanos(previous.signing.expiresAt) > now)) return previous;
      await this.insertPreparation(trx, preparationId, swapId, commandId, 'WITHDRAW', signing);
      return this.pending(preparationId, trx);
    });
  }

  private async insertPreparation(
    trx: Executor,
    id: string,
    swapId: string,
    commandId: string,
    action: SwapAction,
    signing: SigningPayload,
  ): Promise<void> {
    await trx
      .insertInto('swap_preparations')
      .values({ id, swap_id: swapId, command_id: commandId, action, signing: jsonText(signing), status: 'PREPARED' })
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
      const poolId = pending.swap.poolId;
      await lockForAdmission(trx, poolId, 'swap', this.maxBatchSize);
      await this.ownedLocked(trx, pending.swap.swapId, caller);
      const previous = await trx
        .selectFrom('swap_preparations')
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
        if (current.swap.status !== 'PREPARED') {
          throw new Conflict('The swap is no longer awaiting submission', 'INVALID_SWAP_STATE');
        }
        if (epochNanos(current.swap.settlementDeadline) <= now) {
          throw new Conflict('The settlement deadline has elapsed', 'DEADLINE_ELAPSED');
        }
        const sequence = await nextArrival(trx, poolId, 'swap');
        await trx
          .updateTable('swap_requests')
          .set({
            status: 'SUBMITTING',
            arrival_sequence: sequence,
            submitted_at: at,
            updated_at: at,
            error_code: null,
            error: null,
          })
          .where('id', '=', current.swap.swapId)
          .execute();
      } else {
        if (!current.swap.canWithdraw)
          throw new Conflict('This swap cannot be withdrawn now', 'WITHDRAWAL_UNAVAILABLE');
        await trx
          .updateTable('swap_requests')
          .set({ status: 'WITHDRAWING', updated_at: at, error_code: null, error: null })
          .where('id', '=', current.swap.swapId)
          .execute();
      }
      // A withdrawal reads history from the request's own submission, so an earlier direct
      // wallet withdrawal of its allocations counts too.
      const historyOffset =
        pending.action === 'WITHDRAW' ? await this.submissionOffset(trx, current.swap.swapId) : offset;
      await trx
        .updateTable('swap_preparations')
        .set({ status: 'SUBMITTING', signature, begin_offset: historyOffset, updated_at: at })
        .where('id', '=', preparationId)
        .execute();
      return true;
    });
  }

  private async submissionOffset(trx: Executor, swapId: string): Promise<bigint> {
    const rows = await trx
      .selectFrom('swap_preparations')
      .select('begin_offset')
      .where('swap_id', '=', swapId)
      .where('action', '=', 'SUBMIT')
      .where('status', '=', 'CONFIRMED')
      .execute();
    const [row] = rows;
    if (rows.length !== 1 || !row) throw new Error('A withdrawal requires one confirmed submission');
    return present(row.begin_offset, 'submission begin offset');
  }

  async confirm(preparationId: string, confirmation: Confirmation): Promise<void> {
    if (!CONFIRMATIONS.has(confirmation.status)) throw new Error('Unexpected ledger confirmation status');
    await this.db.transaction().execute(async (trx) => {
      const pending = await this.pending(preparationId, trx);
      await lockPoolQueue(trx, pending.swap.poolId);
      const { status: current } = await trx
        .selectFrom('swap_requests')
        .select('status')
        .where('id', '=', pending.swap.swapId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (TERMINAL.has(current) && current !== confirmation.status) {
        // A late submission observation must not undo a later settlement or withdrawal.
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
      await sql`UPDATE swap_requests SET status=${confirmation.status},
          allocation_cids=${jsonText(confirmation.allocationCids)}::jsonb,
          amount_out=COALESCE(${confirmation.amountOut}::text,amount_out),update_id=${confirmation.updateId},
          updated_at=${confirmation.confirmedAt}::timestamptz,error_code=NULL,error=NULL
        WHERE id=${pending.swap.swapId}`.execute(trx);
      await this.finishPreparation(trx, preparationId);
      if (TERMINAL.has(confirmation.status)) await unblockFamily(trx, pending.swap.poolId, 'swap');
    });
  }

  private async finishPreparation(trx: Executor, id: string): Promise<void> {
    await trx
      .updateTable('swap_preparations')
      .set({ status: 'CONFIRMED', updated_at: sql<string>`now()` })
      .where('id', '=', id)
      .execute();
  }

  async uncertain(preparationId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const pending = await this.pending(preparationId, trx);
      await lockPoolQueue(trx, pending.swap.poolId);
      await trx
        .updateTable('swap_preparations')
        .set({ status: 'UNRESOLVED', updated_at: sql<string>`now()` })
        .where('id', '=', preparationId)
        .where('status', '=', 'SUBMITTING')
        .execute();
      const submit = pending.action === 'SUBMIT';
      await trx
        .updateTable('swap_requests')
        .set({
          status: submit ? 'UNRESOLVED' : 'WITHDRAWAL_UNRESOLVED',
          error_code: 'CONFIRMATION_PENDING',
          error: 'Waiting for ledger confirmation',
          updated_at: sql<string>`now()`,
        })
        .where('id', '=', pending.swap.swapId)
        .where('status', '=', submit ? 'SUBMITTING' : 'WITHDRAWING')
        .execute();
    });
  }

  async rejected(preparationId: string, failure: SwapRejected): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const pending = await this.pending(preparationId, trx);
      await lockPoolQueue(trx, pending.swap.poolId);
      const changed = await trx
        .updateTable('swap_preparations')
        .set({ status: 'FAILED', updated_at: sql<string>`now()` })
        .where('id', '=', preparationId)
        .where('status', 'in', IN_FLIGHT)
        .executeTakeFirst();
      if (changed.numUpdatedRows === 0n) return;
      await trx
        .updateTable('swap_requests')
        .set({
          status: pending.action === 'SUBMIT' ? 'FAILED' : 'EXPIRED',
          error_code: failure.code,
          error: failure.message,
          updated_at: sql<string>`now()`,
        })
        .where('id', '=', pending.swap.swapId)
        .where('status', 'in', ['SUBMITTING', 'UNRESOLVED', 'WITHDRAWING', 'WITHDRAWAL_UNRESOLVED'])
        .execute();
      await unblockFamily(trx, pending.swap.poolId, 'swap');
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

  async owned(id: string, caller: Account, db: Executor = this.db): Promise<Swap> {
    const row = await db
      .selectFrom('swap_requests')
      .selectAll()
      .where('id', '=', id)
      .where('account_id', '=', caller.id)
      .executeTakeFirst();
    if (!row) throw new NotFound();
    return readSwap(row);
  }

  private async ownedLocked(trx: Executor, id: string, caller: Account): Promise<void> {
    const row = await trx
      .selectFrom('swap_requests')
      .select('id')
      .where('id', '=', id)
      .where('account_id', '=', caller.id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new NotFound();
  }

  async get(id: string): Promise<Swap> {
    const row = await this.db.selectFrom('swap_requests').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFound();
    return readSwap(row);
  }

  async activity(caller: Account, limit: number, cursor: string | null, status: string | null): Promise<Activity> {
    requirePageSize(limit);
    const before = cursor === null ? null : pathUuid(cursor);
    if (status !== null && !SWAP_STATUSES.some((name) => name === status)) throw new InvalidRequest('Unknown status');
    // Cursor ownership is checked before it supplies the paging boundary.
    const boundary = before === null ? null : { createdAt: (await this.owned(before, caller)).createdAt, id: before };
    return this.activityBefore(caller, limit, boundary, status);
  }

  async activityBefore(
    caller: Account,
    limit: number,
    before: Before | null,
    status: string | null,
  ): Promise<Activity> {
    requirePageSize(limit);
    let query = this.db.selectFrom('swap_requests').selectAll().where('account_id', '=', caller.id);
    if (status !== null) query = query.where('status', '=', status);
    if (before !== null) {
      query = query.where(sql<boolean>`(created_at,id)<(${before.createdAt}::timestamptz,${before.id}::uuid)`);
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(readSwap);
    return { items, nextCursor: rows.length > limit ? (items.at(-1)?.swapId ?? null) : null };
  }
}
