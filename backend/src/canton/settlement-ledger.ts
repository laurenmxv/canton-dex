import { isDepositTerms } from '../liquidity/model.js';
import { MINIMUM_LIQUIDITY } from '../liquidity/math.js';
import {
  compareDecimal,
  divideHalfUp,
  NUMERIC_SCALE,
  numericUnits,
  plainText,
  trimmedText,
} from '../platform/decimal.js';
import { CodedFailure, Conflict, InvalidRequest, LedgerUnavailable } from '../platform/errors.js';
import { canonicalInstant, clockNanos, epochNanos } from '../platform/time.js';
import {
  POOL_CHANGED,
  reference,
  sameRef,
  settlementDeadlineOf,
  swapRequest,
  type Confirmation,
  type Fill,
  type OutputCheck,
  type Pending,
  type ProjectedPoolState,
  type PreviewStep,
  type QueueRequest,
  type RequestRef,
  type Snapshot,
} from '../settlements/model.js';
import { RequestBlocked, SettlementExcluded, SettlementRejected, type SettlementLedger } from '../settlements/ports.js';
import { BPS, swapOutput, tokenAmount } from '../swaps/math.js';
import type { Swap } from '../swaps/model.js';
import type { Instrument } from '../tokens/model.js';
import { poolState } from './contracts.js';
import { definitelyRejected, LedgerRejected } from './http.js';
import {
  createdEvents,
  exercise,
  exercisedEvents,
  type CreatedEvent,
  type Ledger,
  type StoredCommands,
  type Transaction,
} from './ledger.js';
import {
  isRecovery,
  liquidityRequestOf,
  settlementResult,
  validateAllocation as validateLiquidityAllocation,
  validateDeposit,
  validateWithdrawal,
  type LiquidityOperations,
} from './liquidity-ledger.js';
import { PreparationFailed, type OperatorCommands } from './operator-commands.js';
import { AllocationInterface, isExactly, PoolState, SwapReceipt, VenueDelegation } from './packages.js';
import {
  poolReserves,
  requireLiquidityReady,
  requireReady,
  snapshotVersion,
  type CantonPools,
  type PoolSnapshot,
} from './pools.js';
import {
  encodeSwapRequest,
  isWithdrawal,
  swapReceipt,
  swapRequestOf,
  validateAllocation as validateSwapAllocation,
} from './swap-ledger.js';
import { approvedOperations, mergeDisclosures, type CantonTokenRegistry } from './token-registry.js';

/** The operator command kind of a settlement batch in the durable command journal. */
const BATCH_COMMAND = 'batch';
const HEADROOM_SCALE = 4;

/** The liquidity token arguments and disclosures of a pool. */
export interface LiquidityOperationsSource {
  operations(snapshot: PoolSnapshot): Promise<LiquidityOperations>;
}

function toSnapshot(pool: PoolSnapshot): Snapshot {
  return {
    poolId: pool.poolId,
    version: snapshotVersion(pool),
    reserves: poolReserves(pool.stateEvent.contractId, pool.state),
    feeBps: trimmedText(numericUnits(pool.config.feeBps)),
    health: pool.health,
    reason: pool.reason,
    observedAt: pool.observedAt,
    ledgerOffset: pool.offset,
    lpTokenSupply: trimmedText(numericUnits(pool.state.lpTokenSupply)),
    initialRatio: trimmedText(numericUnits(pool.config.initialRatio)),
  };
}

export function projected(snapshot: Snapshot): ProjectedPoolState {
  return {
    baseReserve: snapshot.reserves.baseReserve,
    quoteReserve: snapshot.reserves.quoteReserve,
    lpTokenSupply: snapshot.lpTokenSupply,
    spotPrice: snapshot.reserves.spotPrice,
    invariant: snapshot.reserves.invariant,
  };
}

function projectedOf(base: bigint, quote: bigint, supply: bigint): ProjectedPoolState {
  return {
    baseReserve: trimmedText(base),
    quoteReserve: trimmedText(quote),
    lpTokenSupply: trimmedText(supply),
    spotPrice: base === 0n ? null : trimmedText(divideHalfUp(quote, base)),
    invariant: plainText(base * quote, 2 * NUMERIC_SCALE),
  };
}

/** The output's margin over its signed minimum, in basis points of the output, rounded toward zero. */
function outputCheck(instrument: Instrument, amount: string, minimum: string): OutputCheck {
  const output = numericUnits(amount);
  const headroom =
    output === 0n
      ? null
      : plainText(((output - numericUnits(minimum)) * BPS * 10n ** BigInt(HEADROOM_SCALE)) / output, HEADROOM_SCALE);
  return { instrument, amount, minimum, headroomBps: headroom };
}

function outputsOf(queued: QueueRequest, fill: Fill): OutputCheck[] {
  if (fill.type === 'swap' && queued.type === 'swap') {
    return [outputCheck(fill.outputInstrument, fill.amountOut, queued.request.minOut)];
  }
  if (queued.type === 'swap') throw new Error('A swap request has a swap fill');
  const terms = queued.request.terms;
  if (fill.type === 'deposit' && isDepositTerms(terms)) {
    return [outputCheck(terms.lpInstrument, fill.actualLpOut, terms.minLpOut)];
  }
  if (fill.type === 'withdraw' && !isDepositTerms(terms)) {
    return [
      outputCheck(terms.baseInstrument, fill.actualBaseOut, terms.minBaseOut),
      outputCheck(terms.quoteInstrument, fill.actualQuoteOut, terms.minQuoteOut),
    ];
  }
  throw new Error('Fill kind differs from its request');
}

/** A request that preflight can settle, from the state that the previous step left. */
export function validStep(
  queued: QueueRequest,
  fill: Fill,
  trace: readonly PreviewStep[],
  initial: ProjectedPoolState,
  after: ProjectedPoolState,
): PreviewStep {
  return {
    request: reference(queued),
    status: 'VALID',
    fill,
    before: trace.at(-1)?.after ?? initial,
    after,
    outputs: outputsOf(queued, fill),
    errorCode: null,
    error: null,
  };
}

/** Records the blocked request and leaves every later request unevaluated at the same state. */
export function stopPreview(
  snapshot: Snapshot,
  requests: readonly QueueRequest[],
  trace: PreviewStep[],
  blocked: RequestBlocked,
): void {
  const state = trace.at(-1)?.after ?? projected(snapshot);
  const next = requests[trace.length];
  if (!next || !sameRef(reference(next), blocked.request)) {
    throw new Error('Preflight blocked an unexpected request', { cause: blocked });
  }
  trace.push({
    request: blocked.request,
    status: 'BLOCKED',
    fill: null,
    before: state,
    after: null,
    outputs: [],
    errorCode: blocked.code,
    error: blocked.message,
  });
  for (const queued of requests.slice(trace.length)) {
    trace.push({
      request: reference(queued),
      status: 'NOT_EVALUATED',
      fill: null,
      before: state,
      after: null,
      outputs: [],
      errorCode: null,
      error: null,
    });
  }
}

/**
 * A request-specific failure blocks the request: a coded failure keeps its code, and a mismatch
 * gets `mismatchCode`. Participant failures and unexpected errors stop the preflight instead.
 */
function blockedBy(ref: RequestRef, error: unknown, mismatchCode: string): unknown {
  if (error instanceof RequestBlocked || error instanceof LedgerUnavailable || error instanceof LedgerRejected) {
    return error;
  }
  if (error instanceof Conflict && error.code !== undefined) return new RequestBlocked(ref, error.code, error.message);
  if (error instanceof CodedFailure) return new RequestBlocked(ref, error.code, error.message);
  if (error instanceof InvalidRequest || (error instanceof Error && error.constructor === Error)) {
    return new RequestBlocked(ref, mismatchCode, error.message);
  }
  return error;
}

function swapFill(queued: QueueRequest & { readonly type: 'swap' }, receipts: ReturnType<typeof swapReceipt>[]): Fill {
  const swap = queued.request;
  const [input, output] = swap.allocationCids;
  const matching = receipts.filter(
    (receipt) =>
      receipt.inputAllocation === input &&
      receipt.outputAllocation === output &&
      receipt.terms.requestId === swap.swapId &&
      receipt.trader === swap.trader &&
      receipt.poolCid === swap.poolId,
  );
  const [receipt] = matching;
  if (matching.length !== 1 || !receipt) throw new Error('Batch receipt does not match request');
  if (receipt.terms.direction !== swap.direction) {
    throw new Error('Confirmed receipt direction differs from the request');
  }
  if (receipt.amountOut < numericUnits(swap.minOut)) throw new Error('Confirmed receipt violates minimum output');
  return {
    requestId: swap.swapId,
    amountOut: trimmedText(receipt.amountOut),
    outputInstrument: swap.outputInstrument,
    type: 'swap',
  };
}

/** The batch's committed fills and reserves, from its receipts and its one new pool state. */
export function confirm(tx: Transaction, pending: Pending): Confirmation {
  const created = createdEvents(tx);
  const receipts = created
    .filter((event) => isExactly(event.templateId, SwapReceipt))
    .map((event) => swapReceipt(event.createArgument))
    .filter((receipt) => receipt.batchId === pending.settlement.settlementId);
  const swaps = pending.requests[0]?.type === 'swap';
  if (swaps && receipts.length !== pending.requests.length) throw new Error('Batch receipt count differs');
  const fills = pending.requests.map((queued): Fill => {
    if (queued.type === 'swap') return swapFill(queued, receipts);
    const result = settlementResult(tx, queued.request);
    if (!result) throw new Error('Liquidity settlement receipt is missing');
    const requestId = queued.request.requestId;
    return 'actualLpOut' in result
      ? { requestId, ...result, type: 'deposit' }
      : { requestId, ...result, type: 'withdraw' };
  });
  const states = created.filter(
    (event) =>
      isExactly(event.templateId, PoolState) && poolState(event.createArgument).poolCid === pending.settlement.poolId,
  );
  const [stateEvent] = states;
  if (states.length !== 1 || !stateEvent) throw new Error('Batch must replace pool state once');
  const after = poolReserves(stateEvent.contractId, poolState(stateEvent.createArgument));
  const before = pending.settlement.before;
  if (!before || (swaps && compareDecimal(after.invariant, before.invariant) < 0)) {
    throw new Error('Confirmed batch invariant decreased');
  }
  return {
    fills,
    before,
    after,
    updateId: tx.updateId,
    confirmedAt: canonicalInstant(tx.effectiveAt),
  };
}

/** Another transaction consumed the frozen pool state or withdrew one of the batch's allocations. */
export function inputsConsumed(history: readonly Transaction[], pending: Pending): boolean {
  const stateId = pending.settlement.before?.stateId;
  return history.some((tx) =>
    exercisedEvents(tx).some(
      (event) =>
        (event.consuming && event.contractId === stateId && isExactly(event.templateId, PoolState)) ||
        pending.requests.some((queued) =>
          queued.type === 'swap' ? isWithdrawal(event, queued.request) : isRecovery(event, queued.request),
        ),
    ),
  );
}

function requireSettleable(pool: PoolSnapshot, pending: Pending): void {
  if (snapshotVersion(pool) !== pending.stateVersion || (pool.health !== 'READY' && pool.health !== 'EMPTY')) {
    throw new SettlementRejected(POOL_CHANGED, 'Pool changed before batch submission');
  }
}

/**
 * Settlement's view of the ledger: coherent pool snapshots, sequential preflight at exact
 * reserves, and batch commands that the operator command journal stores before any submission.
 */
export class CantonSettlementLedger implements SettlementLedger {
  constructor(
    private readonly ledger: Pick<
      Ledger,
      'activeInterfaceContracts' | 'primaryParty' | 'storedCommands' | 'transactions'
    >,
    private readonly pools: Pick<CantonPools, 'access' | 'read' | 'settlementDisclosures'>,
    private readonly commands: Pick<OperatorCommands, 'submit'>,
    private readonly registry: Pick<CantonTokenRegistry, 'inlineAllocation' | 'inlineSettlement'>,
    private readonly liquidity: LiquidityOperationsSource,
  ) {}

  async snapshot(poolId: string): Promise<Snapshot> {
    return toSnapshot(await this.pools.read(poolId));
  }

  async preflight(snapshot: Snapshot, requests: readonly QueueRequest[]): Promise<Fill[]> {
    const steps = await this.preview(snapshot, requests);
    const blocked = steps.find((step) => step.status === 'BLOCKED');
    if (blocked) throw new RequestBlocked(blocked.request, blocked.errorCode ?? '', blocked.error ?? '');
    return steps.map((step) => {
      if (!step.fill) throw new Error('A valid preflight step has a fill');
      return step.fill;
    });
  }

  async preview(snapshot: Snapshot, requests: readonly QueueRequest[]): Promise<PreviewStep[]> {
    const trace: PreviewStep[] = [];
    try {
      await this.evaluate(snapshot, requests, trace);
    } catch (error) {
      if (!(error instanceof RequestBlocked)) throw error;
      stopPreview(snapshot, requests, trace, error);
    }
    return trace;
  }

  private async evaluate(snapshot: Snapshot, requests: readonly QueueRequest[], trace: PreviewStep[]): Promise<void> {
    const pool = await this.pools.read(snapshot.poolId);
    requireLiquidityReady(pool);
    if (snapshotVersion(pool) !== snapshot.version) throw new Conflict('Pool changed during preflight', POOL_CHANGED);
    const allocations = await this.ledger.activeInterfaceContracts(
      pool.pool.venueOperator,
      AllocationInterface,
      pool.offset,
    );
    const [first] = requests;
    if (!first) throw new InvalidRequest('Settlement has no requests');
    if (requests.some((queued) => queued.type !== first.type)) {
      throw new InvalidRequest('Settlement spans multiple request families');
    }
    if (first.type === 'swap') {
      requireReady(pool);
      await this.evaluateSwaps(snapshot, pool, requests, allocations, trace);
    } else {
      await this.evaluateLiquidity(pool, requests, allocations, trace);
    }
  }

  private async evaluateSwaps(
    snapshot: Snapshot,
    pool: PoolSnapshot,
    requests: readonly QueueRequest[],
    allocations: readonly CreatedEvent[],
    trace: PreviewStep[],
  ): Promise<void> {
    let base = numericUnits(pool.state.baseReserve);
    let quote = numericUnits(pool.state.quoteReserve);
    const supply = numericUnits(pool.state.lpTokenSupply);
    for (const queued of requests) {
      if (queued.type !== 'swap') throw new InvalidRequest('Settlement spans multiple request families');
      const swap = queued.request;
      const ref = reference(queued);
      if (swap.poolId !== pool.poolId) throw new InvalidRequest('Batch spans multiple pools');
      if (clockNanos() >= epochNanos(swap.settlementDeadline)) {
        throw new RequestBlocked(ref, 'EXPIRED', 'Settlement deadline has elapsed');
      }
      try {
        await this.pools.access(swap.trader, pool.poolEvent, pool.offset);
        const request = swapRequestOf(swap);
        for (const input of [true, false]) {
          const id = input ? request.inputAllocation : request.outputAllocation;
          const allocation = allocations.find((event) => event.contractId === id);
          if (!allocation)
            throw new RequestBlocked(ref, 'ALLOCATION_UNAVAILABLE', 'A swap allocation is no longer active');
          validateSwapAllocation(allocation, request, pool.pool, input);
        }
      } catch (error) {
        throw blockedBy(ref, error, 'ALLOCATION_MISMATCH');
      }
      const baseIn = swap.direction === 'BaseToQuote';
      const inputToken = baseIn ? pool.pool.baseToken : pool.pool.quoteToken;
      const outputToken = baseIn ? pool.pool.quoteToken : pool.pool.baseToken;
      const outputInstrument = { admin: outputToken.instrument.admin, id: outputToken.instrument.id };
      if (outputInstrument.admin !== swap.outputInstrument.admin || outputInstrument.id !== swap.outputInstrument.id) {
        throw new RequestBlocked(ref, 'REQUEST_MISMATCH', 'Output instrument differs from the queued swap');
      }
      let amount: bigint;
      let output: bigint;
      try {
        amount = tokenAmount(swap.amountIn, Number(inputToken.decimals), false);
        output = swapOutput(
          baseIn ? base : quote,
          baseIn ? quote : base,
          amount,
          numericUnits(pool.config.feeBps),
          Number(outputToken.decimals),
        );
      } catch (error) {
        if (error instanceof InvalidRequest) throw new RequestBlocked(ref, 'INVALID_AMOUNT', error.message);
        throw error;
      }
      if (output <= 0n || output < numericUnits(swap.minOut)) {
        throw new RequestBlocked(ref, 'MIN_OUT', 'Current reserves cannot satisfy the signed minimum output');
      }
      const fill: Fill = { requestId: swap.swapId, amountOut: trimmedText(output), outputInstrument, type: 'swap' };
      if (baseIn) {
        base += amount;
        quote -= output;
      } else {
        quote += amount;
        base -= output;
      }
      trace.push(validStep(swapRequest(swap), fill, trace, projected(snapshot), projectedOf(base, quote, supply)));
    }
  }

  private async evaluateLiquidity(
    pool: PoolSnapshot,
    requests: readonly QueueRequest[],
    allocations: readonly CreatedEvent[],
    trace: PreviewStep[],
  ): Promise<void> {
    const initializes = (queued: QueueRequest) =>
      queued.type === 'deposit' && isDepositTerms(queued.request.terms) && queued.request.terms.mode === 'INITIAL';
    if (requests.length > 1 && requests.some(initializes)) {
      throw new InvalidRequest('Initialization settles individually');
    }
    const initial = projected(toSnapshot(pool));
    let base = numericUnits(pool.state.baseReserve);
    let quote = numericUnits(pool.state.quoteReserve);
    let supply = numericUnits(pool.state.lpTokenSupply);
    for (const queued of requests) {
      if (queued.type === 'swap') throw new InvalidRequest('Settlement spans multiple request families');
      const request = queued.request;
      const ref = reference(queued);
      if (request.terms.poolId !== pool.poolId) throw new InvalidRequest('Request belongs to another pool');
      if (clockNanos() >= epochNanos(settlementDeadlineOf(queued))) {
        throw new RequestBlocked(ref, 'EXPIRED', 'Settlement deadline has elapsed');
      }
      try {
        for (let index = 0; index < 3; index += 1) {
          const cid = request.allocationCids[index];
          const event = allocations.find((candidate) => candidate.contractId === cid);
          if (!event) throw new Conflict('A liquidity allocation is no longer active', 'ALLOCATION_UNAVAILABLE');
          validateLiquidityAllocation(event, request, pool.pool, index);
        }
        await this.pools.access(request.terms.trader, pool.poolEvent, pool.offset);
        const terms = request.terms;
        if (isDepositTerms(terms)) {
          const result = validateDeposit(pool, terms, base, quote, supply);
          const fill: Fill = {
            requestId: request.requestId,
            actualBaseIn: trimmedText(result.base),
            actualQuoteIn: trimmedText(result.quote),
            actualBaseRefund: trimmedText(result.baseRefund),
            actualQuoteRefund: trimmedText(result.quoteRefund),
            actualLpOut: trimmedText(result.lp),
            type: 'deposit',
          };
          base += result.base;
          quote += result.quote;
          supply += result.lp + (terms.mode === 'INITIAL' ? MINIMUM_LIQUIDITY : 0n);
          trace.push(validStep(queued, fill, trace, initial, projectedOf(base, quote, supply)));
        } else {
          const result = validateWithdrawal(pool, terms, base, quote, supply);
          const fill: Fill = {
            requestId: request.requestId,
            actualLpBurned: trimmedText(result.lp),
            actualBaseOut: trimmedText(result.base),
            actualQuoteOut: trimmedText(result.quote),
            type: 'withdraw',
          };
          base -= result.base;
          quote -= result.quote;
          supply -= result.lp;
          trace.push(validStep(queued, fill, trace, initial, projectedOf(base, quote, supply)));
        }
      } catch (error) {
        throw blockedBy(ref, error, 'REQUEST_MISMATCH');
      }
    }
  }

  async submit(pending: Pending): Promise<Confirmation> {
    let tx: Transaction;
    try {
      tx = await this.commands.submit(pending.commandId, BATCH_COMMAND, () => this.buildCommands(pending));
    } catch (error) {
      if (error instanceof PreparationFailed) throw new SettlementExcluded('COMMAND_NOT_PREPARED', error.message);
      if (definitelyRejected(error)) {
        throw new SettlementRejected(
          'LEDGER_REJECTED',
          'Canton rejected the batch; its token transfers were rolled back',
        );
      }
      throw error;
    }
    return confirm(tx, pending);
  }

  private async buildCommands(pending: Pending): Promise<StoredCommands> {
    const pool = await this.pools.read(pending.settlement.poolId);
    requireSettleable(pool, pending);
    if (!pool.delegationEvent) throw new Error('Settlement authority is unavailable');
    const delegation = pool.delegationEvent.contractId;
    const cids = { configCid: pool.configEvent.contractId, stateCid: pool.stateEvent.contractId };
    const [first] = pending.requests;
    if (first && first.type !== 'swap') {
      const operations = await this.liquidity.operations(pool);
      const requests = [];
      for (const queued of pending.requests) {
        if (queued.type === 'swap') throw new Error('Settlement spans multiple request families');
        const access = await this.pools.access(queued.request.terms.trader, pool.poolEvent, pool.offset);
        requests.push({
          accessCid: access.contractId,
          request: { request: liquidityRequestOf(queued.request), tokenArgs: operations.args },
        });
      }
      const choice = first.type === 'deposit' ? 'VenueDelegation_AddLiquidity' : 'VenueDelegation_WithdrawLiquidity';
      return this.ledger.storedCommands(
        pending.commandId,
        pool.pool.venueOperator,
        [pool.pool.dvo],
        [exercise(VenueDelegation, delegation, choice, { ...cids, requests })],
        pending.beginOffset,
        await this.pools.settlementDisclosures(pool, operations.disclosures),
      );
    }
    const { baseToken, quoteToken } = pool.pool;
    const base = await approvedOperations(this.registry, baseToken);
    const quote = await approvedOperations(this.registry, quoteToken);
    const requests = [];
    for (const queued of pending.requests) {
      if (queued.type !== 'swap') throw new Error('Settlement spans multiple request families');
      const swap: Swap = queued.request;
      const baseIn = swap.direction === 'BaseToQuote';
      const access = await this.pools.access(swap.trader, pool.poolEvent, pool.offset);
      requests.push({
        accessCid: access.contractId,
        request: {
          request: encodeSwapRequest(swapRequestOf(swap)),
          poolInputAllocationArgs: (baseIn ? base : quote).allocation.extraArgs,
          poolOutputAllocationArgs: (baseIn ? quote : base).allocation.extraArgs,
          inputSettlementArgs: (baseIn ? base : quote).settlement.extraArgs,
          outputSettlementArgs: (baseIn ? quote : base).settlement.extraArgs,
        },
      });
    }
    const disclosures = mergeDisclosures(
      [base.allocation, quote.allocation, base.settlement, quote.settlement].flatMap(
        (operation) => operation.disclosures,
      ),
    );
    return this.ledger.storedCommands(
      pending.commandId,
      pool.pool.venueOperator,
      [pool.pool.dvo],
      [
        exercise(VenueDelegation, delegation, 'VenueDelegation_SettleBatch', {
          ...cids,
          requests,
          batchId: pending.settlement.settlementId,
        }),
      ],
      pending.beginOffset,
      await this.pools.settlementDisclosures(pool, disclosures),
    );
  }

  /**
   * The committed batch, found by its command id. Without it, consumed inputs prove that the batch
   * can never commit; otherwise the immutable stored command is sent again with its original
   * deduplication offset, and a refusal of that replay leaves the outcome unknown.
   */
  async recover(pending: Pending): Promise<Confirmation | undefined> {
    const history = await this.ledger.transactions(pending.beginOffset, await this.ledger.primaryParty());
    const committed = history.find((tx) => tx.commandId === pending.commandId);
    if (committed) return confirm(committed, pending);
    if (inputsConsumed(history, pending)) {
      throw new SettlementExcluded(
        'BATCH_INPUT_CONSUMED',
        'A required pool state or allocation was consumed by another transaction',
      );
    }
    try {
      return await this.submit(pending);
    } catch (error) {
      if (
        error instanceof SettlementRejected ||
        error instanceof LedgerRejected ||
        error instanceof LedgerUnavailable
      ) {
        return undefined;
      }
      throw error;
    }
  }
}
