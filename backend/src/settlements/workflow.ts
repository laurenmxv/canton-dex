import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { requireRole, type Account } from '../iam/accounts.js';
import { isDepositTerms } from '../liquidity/model.js';
import type { Family } from '../platform/families.js';
import { numericUnits } from '../platform/decimal.js';
import { Conflict } from '../platform/errors.js';
import { clockNanos } from '../platform/time.js';
import {
  IDEMPOTENCY_CONFLICT,
  reference,
  requireFamily,
  sameRef,
  sameRefs,
  SETTLEABLE_HEALTH,
  fillRef,
  type Fill,
  type History,
  type Monitoring,
  type Pending,
  type Policy,
  type Preview,
  type QueueRequest,
  type RequestRef,
  type RunInput,
  type Settlement,
  type SettlementStatus,
  type Snapshot,
  type UpdatePolicy,
} from './model.js';
import {
  RequestBlocked,
  SettlementExcluded,
  SettlementRejected,
  type SettlementLedger,
  type SettlementProgress,
} from './ports.js';

function samePool(batch: Settlement, poolId: string): Settlement {
  if (batch.poolId !== poolId) {
    throw new Conflict('This settlement key belongs to another pool', IDEMPOTENCY_CONFLICT);
  }
  return batch;
}

function requireReady(snapshot: Snapshot): void {
  if (!SETTLEABLE_HEALTH.has(snapshot.health)) {
    throw new Conflict(`Pool is not ready for settlement: ${snapshot.health}`, 'POOL_NOT_READY');
  }
}

function requireOutput(actual: string, minimum: string, request: RequestRef): void {
  const amount = numericUnits(actual);
  if (amount <= 0n || amount < numericUnits(minimum)) {
    throw new RequestBlocked(request, 'MIN_OUT', 'Minimum output cannot be met');
  }
}

/** The preflight fills match the batch in order, and each one still meets its signed minimum. */
function validateFills(requests: readonly QueueRequest[], fills: readonly Fill[]): void {
  if (!sameRefs(requests.map(reference), fills.map(fillRef))) {
    throw new Error('Preflight outputs do not match the selected requests');
  }
  requests.forEach((queued, index) => {
    const fill = fills[index];
    const ref = reference(queued);
    if (fill?.type === 'swap' && queued.type === 'swap') {
      requireOutput(fill.amountOut, queued.request.minOut, ref);
    } else if (fill?.type === 'deposit' && queued.type === 'deposit' && isDepositTerms(queued.request.terms)) {
      requireOutput(fill.actualLpOut, queued.request.terms.minLpOut, ref);
    } else if (fill?.type === 'withdraw' && queued.type === 'withdraw' && !isDepositTerms(queued.request.terms)) {
      const terms = queued.request.terms;
      requireOutput(fill.actualBaseOut, terms.minBaseOut, ref);
      requireOutput(fill.actualQuoteOut, terms.minQuoteOut, ref);
      if (numericUnits(fill.actualLpBurned) !== numericUnits(terms.lpAmount)) {
        throw new Error('Preflight burn differs from the signed LP amount');
      }
    } else {
      throw new Error('Preflight fill kind differs from its request');
    }
  });
}

/**
 * Per-pool settlement: family policies, previews, manual and automatic batches, deferral and
 * history. A batch's right to submit is committed before any network call; unknown outcomes are
 * recovered with the immutable stored command.
 */
export class SettlementWorkflow {
  constructor(
    private readonly store: SettlementProgress,
    private readonly ledger: SettlementLedger,
    private readonly log: Pick<FastifyBaseLogger, 'warn'>,
    private readonly clock: () => bigint = clockNanos,
  ) {}

  async policy(poolId: string, family: Family, caller: Account): Promise<Policy> {
    requireRole(caller, 'OPERATOR');
    return this.store.policy(poolId, family);
  }

  async updatePolicy(poolId: string, family: Family, input: UpdatePolicy, caller: Account): Promise<Policy> {
    requireRole(caller, 'OPERATOR');
    return this.store.updatePolicy(poolId, family, input, this.clock());
  }

  async run(poolId: string, input: RunInput, caller: Account): Promise<Settlement> {
    requireRole(caller, 'OPERATOR');
    const existing = await this.store.findIntent(poolId, input.idempotencyKey, input.selection);
    if (existing) return samePool(existing, poolId);
    const snapshot = await this.ledger.snapshot(poolId);
    requireReady(snapshot);
    const claimed = await this.store.claim(
      poolId,
      input.idempotencyKey,
      'MANUAL',
      snapshot,
      this.clock(),
      input.selection,
    );
    if (claimed) await this.prepare(claimed, snapshot);
    const batch = await this.store.find(input.idempotencyKey);
    if (!batch) throw new Conflict('There is no eligible FIFO prefix to settle', 'QUEUE_NOT_READY');
    return samePool(batch, poolId);
  }

  async get(id: string, caller: Account): Promise<Settlement> {
    requireRole(caller, 'OPERATOR');
    return this.store.get(id);
  }

  async list(poolId: string | null, caller: Account): Promise<Settlement[]> {
    requireRole(caller, 'OPERATOR');
    return this.store.list(poolId);
  }

  /** The pool's ledger snapshot, then its queue state at the current time. */
  async monitoring(poolId: string, caller: Account): Promise<Monitoring> {
    requireRole(caller, 'OPERATOR');
    const snapshot = await this.ledger.snapshot(poolId);
    return this.store.monitoring(poolId, snapshot, this.clock());
  }

  async queue(poolId: string, caller: Account): Promise<QueueRequest[]> {
    requireRole(caller, 'OPERATOR');
    return this.store.queue(poolId);
  }

  async preview(
    poolId: string,
    family: string,
    retryOf: string | null,
    requestId: string | null,
    caller: Account,
  ): Promise<Preview> {
    requireRole(caller, 'OPERATOR');
    const type = requireFamily(family);
    const snapshot = await this.ledger.snapshot(poolId);
    requireReady(snapshot);
    const plan = await this.store.plan(poolId, type, retryOf, requestId, snapshot, this.clock());
    const steps = plan.requests.length === 0 ? [] : await this.ledger.preview(snapshot, plan.requests);
    if (
      !sameRefs(
        steps.map((step) => step.request),
        plan.selection.requests,
      )
    ) {
      throw new Error('Preview differs from selected requests');
    }
    const executable =
      plan.activeSettlementId === null && steps.length > 0 && steps.every((step) => step.status === 'VALID');
    return {
      selection: plan.selection,
      pool: snapshot,
      steps,
      activeSettlementId: plan.activeSettlementId,
      executable,
    };
  }

  async setDeferred(poolId: string, request: RequestRef, deferred: boolean, caller: Account): Promise<void> {
    requireRole(caller, 'OPERATOR');
    await this.store.setDeferred(poolId, request, deferred, this.clock());
  }

  async history(
    poolId: string,
    type: Family | null,
    status: SettlementStatus | null,
    before: string | null,
    limit: number,
    caller: Account,
  ): Promise<History> {
    requireRole(caller, 'OPERATOR');
    return this.store.history(poolId, type, status, before, limit);
  }

  /** Recovery runs whether or not automatic dispatch is enabled. */
  async reconcile(): Promise<void> {
    for (const pending of await this.store.pending()) {
      const id = pending.settlement.settlementId;
      try {
        if (pending.settlement.status === 'PREPARING') {
          await this.prepare(pending, await this.ledger.snapshot(pending.settlement.poolId));
        } else if (await this.store.beginRecovery(id, this.clock())) {
          const confirmation = await this.ledger.recover(pending);
          if (confirmation) await this.store.confirm(id, confirmation);
        }
      } catch (error) {
        if (error instanceof SettlementExcluded) {
          await this.store.excludeSubmission(id, error.code, error.message, this.clock());
        } else {
          this.log.warn({ err: error, settlement: id }, 'Settlement reconciliation failed');
        }
      }
    }
  }

  async automatic(): Promise<void> {
    for (const poolId of await this.store.automaticPools()) {
      try {
        const snapshot = await this.ledger.snapshot(poolId);
        if (!SETTLEABLE_HEALTH.has(snapshot.health)) continue;
        const pending = await this.store.claim(poolId, randomUUID(), 'AUTOMATIC', snapshot, this.clock());
        if (pending) await this.prepare(pending, snapshot);
      } catch (error) {
        this.log.warn({ err: error, pool: poolId }, 'Automatic settlement failed');
      }
    }
  }

  /**
   * Preflights the frozen batch and authorizes its dispatch. A blocked request keeps only the valid
   * prefix, except for previewed selections and automatic swap batches, which settle whole or not
   * at all.
   */
  private async prepare(pending: Pending, snapshot: Snapshot): Promise<void> {
    const id = pending.settlement.settlementId;
    if (!SETTLEABLE_HEALTH.has(snapshot.health)) {
      await this.store.cancelPreparation(id, 'POOL_NOT_READY', snapshot.reason, this.clock());
      return;
    }
    try {
      let requests = pending.requests;
      while (requests.length > 0) {
        try {
          const fills = await this.ledger.preflight(snapshot, requests);
          validateFills(requests, fills);
          const authorized = await this.store.authorizeDispatch(id, fills, snapshot, this.clock());
          if (authorized) await this.submit(authorized);
          return;
        } catch (error) {
          if (!(error instanceof RequestBlocked)) throw error;
          const index = requests.findIndex((queued) => sameRef(reference(queued), error.request));
          if (index < 0) throw new Error('Preflight blocked a request outside this batch', { cause: error });
          const whole =
            pending.selection !== null || (pending.settlement.trigger === 'AUTOMATIC' && requests[0]?.type === 'swap');
          if (whole) {
            await this.store.rejectPreparation(
              id,
              error.request,
              error.code,
              error.message,
              snapshot.version,
              this.clock(),
            );
            return;
          }
          requests = requests.slice(0, index);
          const kept = await this.store.keepPrefix(
            id,
            requests.map(reference),
            error.request,
            error.code,
            error.message,
            snapshot.version,
            this.clock(),
          );
          if (!kept) return;
        }
      }
    } catch (error) {
      // Nothing was sent unless authorization changed the status; the cancellation is a CAS.
      await this.store.cancelPreparation(
        id,
        'PREFLIGHT_UNAVAILABLE',
        'Settlement preflight could not complete',
        this.clock(),
      );
      this.log.warn({ err: error, settlement: id }, 'Settlement preflight failed');
    }
  }

  private async submit(pending: Pending): Promise<void> {
    const id = pending.settlement.settlementId;
    try {
      await this.store.confirm(id, await this.ledger.submit(pending));
    } catch (error) {
      if (error instanceof SettlementExcluded) {
        await this.store.excludeSubmission(id, error.code, error.message, this.clock());
      } else if (error instanceof SettlementRejected) {
        await this.store.rejectSubmission(id, error.code, error.message, this.clock());
      } else {
        await this.store.unresolved(id, this.clock());
        this.log.warn({ err: error, settlement: id }, 'Settlement awaits confirmation');
      }
    }
  }
}
