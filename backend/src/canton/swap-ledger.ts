import type { Account } from '../iam/accounts.js';
import { numericText, numericUnits, plainText, trimmedText } from '../platform/decimal.js';
import { CodedFailure, Conflict, InvalidRequest, LedgerUnavailable } from '../platform/errors.js';
import {
  canonicalInstant,
  clockNanos,
  epochMicros,
  epochNanos,
  instantText,
  NANOS_PER_SECOND,
} from '../platform/time.js';
import { minimumOut, swapOutput, tokenAmount } from '../swaps/math.js';
import type {
  Confirmation,
  Pending,
  Quote,
  QuoteInput,
  SigningPayload,
  Swap,
  SwapStatus,
  Terms,
} from '../swaps/model.js';
import { SwapRejected, type SwapLedger } from '../swaps/ports.js';
import type { Signer } from '../tokens/model.js';
import { allocationView, MIN_OUT_KEY, sameMetadata, withdrawn } from './allocations.js';
import { token as decodeToken, type PoolContract, type Token } from './contracts.js';
import { record, string } from './decode.js';
import { definitelyRejected, GRPC, LedgerRejected } from './http.js';
import { verify, type InteractiveTransactions, type Prepared } from './interactive.js';
import {
  createdEvents,
  exercise,
  exercisedEvents,
  type Command,
  type CreatedEvent,
  type DisclosedContract,
  type ExercisedEvent,
  type Ledger,
  type Transaction,
} from './ledger.js';
import { AllocationInterface, isExactly, PoolAccess, SwapReceipt } from './packages.js';
import { requireReady, swapRoute, type CantonPools } from './pools.js';
import { mergeDisclosures, requireFactory, type CantonTokenRegistry } from './token-registry.js';

const QUOTE_LIFETIME = 30n * NANOS_PER_SECOND;
const QUOTE_SETTLEMENT_WINDOW = 600n * NANOS_PER_SECOND;
const MIN_SETTLEMENT_WINDOW = 30n * NANOS_PER_SECOND;
const MAX_SETTLEMENT_WINDOW = 1_800n * NANOS_PER_SECOND;
/** How long a prepared transaction stays signable. */
const SIGNING_WINDOW = 45n * NANOS_PER_SECOND;
/** The fee's basis points and the amount's ten decimals give the informational fee 14 decimals. */
const FEE_SCALE = 24;
const REQUEST_SWAP = 'PoolAccess_RequestSwap';
export const RECOVER_ALLOCATIONS = 'PoolAccess_RecoverAllocations';

/** The swap terms of a request and its allocations, with exact amounts. */
export interface SwapTermsValue {
  readonly requestId: string;
  readonly direction: string;
  readonly amountIn: bigint;
  readonly minOut: bigint;
  readonly settlementDeadline: string;
}

export interface SwapRequestValue {
  readonly poolCid: string;
  readonly trader: string;
  readonly terms: SwapTermsValue;
  readonly inputAllocation: string;
  readonly outputAllocation: string;
}

/** The tokens and executors of a pool that its allocations must name. */
export type SwapRoute = Pick<PoolContract, 'dvo' | 'venueOperator' | 'baseToken' | 'quoteToken'>;

export interface SwapReceiptValue {
  readonly trader: string;
  readonly poolCid: string;
  readonly inputAllocation: string;
  readonly outputAllocation: string;
  readonly batchId: string;
  readonly terms: SwapTermsValue;
  readonly amountOut: bigint;
}

function units(value: unknown, what: string): bigint {
  return numericUnits(string(value, what));
}

function swapTerms(value: unknown, what = 'SwapTerms'): SwapTermsValue {
  const fields = record(value, what);
  return {
    requestId: string(fields.requestId, `${what}.requestId`),
    direction: string(fields.direction, `${what}.direction`),
    amountIn: units(fields.amountIn, `${what}.amountIn`),
    minOut: units(fields.minOut, `${what}.minOut`),
    settlementDeadline: string(fields.settlementDeadline, `${what}.settlementDeadline`),
  };
}

function sameTerms(left: SwapTermsValue, right: SwapTermsValue): boolean {
  return (
    left.requestId === right.requestId &&
    left.direction === right.direction &&
    left.amountIn === right.amountIn &&
    left.minOut === right.minOut &&
    epochNanos(left.settlementDeadline) === epochNanos(right.settlementDeadline)
  );
}

function swapRequestValue(value: unknown): SwapRequestValue {
  const fields = record(value, 'SwapRequest');
  return {
    poolCid: string(fields.poolCid, 'SwapRequest.poolCid'),
    trader: string(fields.trader, 'SwapRequest.trader'),
    terms: swapTerms(fields.terms),
    inputAllocation: string(fields.inputAllocation, 'SwapRequest.inputAllocation'),
    outputAllocation: string(fields.outputAllocation, 'SwapRequest.outputAllocation'),
  };
}

export function swapReceipt(value: unknown): SwapReceiptValue {
  const fields = record(value, 'SwapReceipt');
  return {
    trader: string(fields.trader, 'SwapReceipt.trader'),
    poolCid: string(fields.poolCid, 'SwapReceipt.poolCid'),
    inputAllocation: string(fields.inputAllocation, 'SwapReceipt.inputAllocation'),
    outputAllocation: string(fields.outputAllocation, 'SwapReceipt.outputAllocation'),
    batchId: string(fields.batchId, 'SwapReceipt.batchId'),
    terms: swapTerms(fields.terms),
    amountOut: units(fields.amountOut, 'SwapReceipt.amountOut'),
  };
}

/** `Lib.Swap.settlementId`: integer token units and epoch microseconds avoid decimal formatting. */
export function settlementId(terms: SwapTermsValue): string {
  return [
    'swap',
    terms.requestId,
    terms.direction,
    String(terms.amountIn),
    String(terms.minOut),
    String(epochMicros(terms.settlementDeadline)),
  ].join(':');
}

function encodeTerms(terms: SwapTermsValue): Record<string, unknown> {
  return {
    requestId: terms.requestId,
    direction: terms.direction,
    amountIn: numericText(terms.amountIn),
    minOut: numericText(terms.minOut),
    settlementDeadline: terms.settlementDeadline,
  };
}

/** The signed request of a confirmed swap, as the settlement choice takes it. */
export function swapRequestOf(swap: Swap): SwapRequestValue {
  const [inputAllocation, outputAllocation] = swap.allocationCids;
  if (swap.allocationCids.length !== 2 || inputAllocation === undefined || outputAllocation === undefined) {
    throw new Error('A swap requires two confirmed allocations');
  }
  return {
    poolCid: swap.poolId,
    trader: swap.trader,
    terms: {
      requestId: swap.swapId,
      direction: swap.direction,
      amountIn: numericUnits(swap.amountIn),
      minOut: numericUnits(swap.minOut),
      settlementDeadline: swap.settlementDeadline,
    },
    inputAllocation,
    outputAllocation,
  };
}

export function encodeSwapRequest(request: SwapRequestValue): Record<string, unknown> {
  return { ...request, terms: encodeTerms(request.terms) };
}

/** An allocation matches the signed request: settlement, executors, funding, metadata and deadline. */
export function validateAllocation(
  event: CreatedEvent,
  request: SwapRequestValue,
  route: SwapRoute,
  input: boolean,
): void {
  const view = allocationView(event);
  const baseIn = request.terms.direction === 'BaseToQuote';
  const tokenOf: Token = input === baseIn ? route.baseToken : route.quoteToken;
  const spec = view.allocation;
  const funding = spec.nextIterationFunding;
  const fundingMatches =
    funding !== null &&
    (input ? funding.size === 1 && funding.get(tokenOf.instrument.id) === request.terms.amountIn : funding.size === 0);
  const metadata = input ? { [MIN_OUT_KEY]: trimmedText(request.terms.minOut) } : {};
  if (
    view.executors.length !== 2 ||
    view.executors[0] !== route.dvo ||
    view.executors[1] !== route.venueOperator ||
    view.settlementId !== settlementId(request.terms) ||
    view.settlementCid !== request.poolCid ||
    view.numIterations !== 0n ||
    spec.admin !== tokenOf.instrument.admin ||
    spec.authorizer.owner !== request.trader ||
    spec.authorizer.provider !== null ||
    spec.authorizer.id !== '' ||
    !spec.committed ||
    !fundingMatches ||
    spec.transferLegSides.length > 0 ||
    !sameMetadata(spec.meta, metadata) ||
    spec.settlementDeadline === null ||
    epochNanos(spec.settlementDeadline) !== epochNanos(request.terms.settlementDeadline)
  ) {
    throw new Error('Confirmed allocations differ from the signed request');
  }
}

/** A completed standard withdrawal of one of the swap's allocations by its trader. */
export function isWithdrawal(event: ExercisedEvent, swap: Swap): boolean {
  return (
    swap.allocationCids.includes(event.contractId) && event.actingParties.includes(swap.trader) && withdrawn(event)
  );
}

function result(tx: Transaction, status: SwapStatus, allocationCids: readonly string[], amountOut: string | null) {
  return {
    status,
    allocationCids,
    amountOut,
    updateId: tx.updateId,
    offset: tx.offset,
    confirmedAt: canonicalInstant(tx.effectiveAt),
  } satisfies Confirmation;
}

/** The transaction, at or before `throughOffset`, in which both allocations were withdrawn. */
export function withdrawalConfirmation(
  history: readonly Transaction[],
  swap: Swap,
  throughOffset: bigint,
): Confirmation | undefined {
  if (swap.allocationCids.length !== 2 || new Set(swap.allocationCids).size !== 2) return undefined;
  const released = new Set<string>();
  for (const tx of history) {
    if (tx.offset > throughOffset) continue;
    for (const event of exercisedEvents(tx)) if (isWithdrawal(event, swap)) released.add(event.contractId);
    if (swap.allocationCids.every((id) => released.has(id))) return result(tx, 'WITHDRAWN', swap.allocationCids, null);
  }
  return undefined;
}

function validateCreatedAllocation(tx: Transaction, request: SwapRequestValue, route: SwapRoute, input: boolean) {
  const id = input ? request.inputAllocation : request.outputAllocation;
  const events = createdEvents(tx).filter((event) => event.contractId === id);
  const [event] = events;
  if (events.length !== 1 || !event) throw new Error('Transaction did not create both requested allocations');
  validateAllocation(event, request, route, input);
}

function routeOf(value: unknown): SwapRoute & { readonly poolCid: string } {
  const fields = record(value, 'SwapRoute');
  return {
    poolCid: string(fields.poolCid, 'SwapRoute.poolCid'),
    dvo: string(fields.dvo, 'SwapRoute.dvo'),
    venueOperator: string(fields.venueOperator, 'SwapRoute.venueOperator'),
    baseToken: decodeToken(fields.baseToken, 'SwapRoute.baseToken'),
    quoteToken: decodeToken(fields.quoteToken, 'SwapRoute.quoteToken'),
  };
}

/** The trader's request transaction: the signed terms and both allocations it created. */
function requestConfirmation(tx: Transaction, swap: Swap): Confirmation | undefined {
  for (const event of exercisedEvents(tx)) {
    if (
      !isExactly(event.templateId, PoolAccess) ||
      event.choice !== REQUEST_SWAP ||
      event.actingParties.length !== 1 ||
      event.actingParties[0] !== swap.trader
    ) {
      continue;
    }
    const argument = record(event.choiceArgument, REQUEST_SWAP);
    const route = routeOf(argument.route);
    const request = swapRequestValue(event.exerciseResult);
    if (request.terms.requestId !== swap.swapId) continue;
    if (
      request.trader !== swap.trader ||
      request.poolCid !== swap.poolId ||
      !sameTerms(request.terms, swapTerms(argument.terms)) ||
      route.poolCid !== swap.poolId ||
      request.terms.direction !== swap.direction ||
      request.terms.amountIn !== numericUnits(swap.amountIn) ||
      request.terms.minOut !== numericUnits(swap.minOut) ||
      epochNanos(request.terms.settlementDeadline) !== epochNanos(swap.settlementDeadline) ||
      request.inputAllocation === request.outputAllocation
    ) {
      throw new Error('Confirmed swap differs from the signed request');
    }
    validateCreatedAllocation(tx, request, route, true);
    validateCreatedAllocation(tx, request, route, false);
    return result(tx, 'READY', [request.inputAllocation, request.outputAllocation], null);
  }
  return undefined;
}

/** A participant refusal to prepare, as the API reports it. */
function prepareFailure(error: unknown): unknown {
  if (error instanceof LedgerUnavailable) {
    return new CodedFailure(503, 'LEDGER_UNAVAILABLE', 'The participant could not prepare this transaction; try again');
  }
  if (!(error instanceof LedgerRejected)) return error;
  const refused = (grpcCode: number, status: number) =>
    error.grpcCode === grpcCode || (error.grpcCode === undefined && error.status === status);
  if (refused(GRPC.UNAUTHENTICATED, 401)) {
    return new CodedFailure(401, 'SESSION_EXPIRED', 'Sign in again before preparing the transaction');
  }
  if (refused(GRPC.PERMISSION_DENIED, 403)) {
    return new CodedFailure(403, 'LEDGER_ACCESS_DENIED', 'The current session cannot prepare this transaction');
  }
  return new Conflict(
    'The ledger state changed or rejected these terms; refresh and prepare again',
    'PREPARATION_REJECTED',
  );
}

/** A wallet preparation valid for the signing window; participant refusals get their public answer. */
export async function prepareForWallet(
  interactive: InteractiveTransactions,
  commandId: string,
  signer: Signer,
  accessToken: string,
  command: Command,
  disclosures: readonly DisclosedContract[],
  now: bigint,
): Promise<Prepared> {
  try {
    return await interactive.prepare(
      commandId,
      signer.userId,
      accessToken,
      signer.party,
      command,
      disclosures,
      instantText(now + SIGNING_WINDOW),
    );
  } catch (error) {
    throw prepareFailure(error);
  }
}

/** The wallet-signed preparation a pending submission or withdrawal carries. */
function signedPreparation(pending: Pending): { readonly signing: SigningPayload; readonly signature: string } {
  if (pending.signature === null) throw new Error('A dispatched preparation has no signature');
  return { signing: pending.signing, signature: pending.signature };
}

/** The trader's onboarded wallet party. */
export interface Signers {
  signer(account: Account): Promise<Signer>;
}

/**
 * Swap requests over the trader's pool access: each request locks the input and output
 * allocations in one signed transaction. Recovery and settlement observation read the operator's
 * complete history; absence is never proof of rejection.
 */
export class CantonSwapLedger implements SwapLedger {
  constructor(
    private readonly ledger: Ledger,
    private readonly pools: CantonPools,
    private readonly signers: Signers,
    private readonly interactive: InteractiveTransactions,
    private readonly registry: CantonTokenRegistry,
  ) {}

  offset(): Promise<bigint> {
    return this.ledger.ledgerEnd();
  }

  async requireAccess(caller: Account, poolId: string): Promise<void> {
    const signer = await this.signers.signer(caller);
    const offset = await this.ledger.ledgerEnd();
    await this.pools.access(signer.party.partyId, await this.pools.poolEvent(poolId, offset), offset);
  }

  async verify(signing: SigningPayload, signature: string, caller: Account): Promise<void> {
    verify(signing, signature, (await this.signers.signer(caller)).party);
  }

  async quote(quoteId: string, caller: Account, accessToken: string, input: QuoteInput): Promise<Quote> {
    const party = (await this.signers.signer(caller)).party.partyId;
    const snapshot = await this.pools.read(input.poolId);
    requireReady(snapshot);
    await this.pools.access(party, snapshot.poolEvent, snapshot.offset);
    const baseIn = input.direction === 'BaseToQuote';
    const inputToken = baseIn ? snapshot.pool.baseToken : snapshot.pool.quoteToken;
    const outputToken = baseIn ? snapshot.pool.quoteToken : snapshot.pool.baseToken;
    const amount = tokenAmount(input.amountIn, Number(inputToken.decimals), false);
    await this.pools.inputs(party, inputToken.instrument, amount, snapshot.offset, accessToken);
    const base = numericUnits(snapshot.state.baseReserve);
    const quote = numericUnits(snapshot.state.quoteReserve);
    const fee = numericUnits(snapshot.config.feeBps);
    const outputDecimals = Number(outputToken.decimals);
    const expected = swapOutput(baseIn ? base : quote, baseIn ? quote : base, amount, fee, outputDecimals);
    if (expected <= 0n) throw new Conflict('Input produces no output at this token precision', 'AMOUNT_TOO_SMALL');
    const now = clockNanos();
    return {
      quoteId,
      poolId: input.poolId,
      poolName: snapshot.name,
      trader: party,
      direction: input.direction,
      inputInstrument: { admin: inputToken.instrument.admin, id: inputToken.instrument.id },
      outputInstrument: { admin: outputToken.instrument.admin, id: outputToken.instrument.id },
      amountIn: trimmedText(amount),
      expectedOut: trimmedText(expected),
      feeAmount: plainText(amount * fee, FEE_SCALE),
      minOut: trimmedText(minimumOut(expected, input.slippageBps, outputDecimals)),
      slippageBps: input.slippageBps,
      stateId: snapshot.stateEvent.contractId,
      quoteExpiresAt: instantText(now + QUOTE_LIFETIME),
      settlementDeadline: instantText(((now + QUOTE_SETTLEMENT_WINDOW) / NANOS_PER_SECOND) * NANOS_PER_SECOND),
    };
  }

  async prepare(
    swapId: string,
    commandId: string,
    caller: Account,
    accessToken: string,
    terms: Terms,
  ): Promise<SigningPayload> {
    const signer = await this.signers.signer(caller);
    const party = signer.party.partyId;
    if (party !== terms.trader) throw new InvalidRequest('Trader differs from the registered wallet');
    const snapshot = await this.pools.read(terms.poolId);
    requireReady(snapshot);
    const access = await this.pools.access(party, snapshot.poolEvent, snapshot.offset);
    const now = (clockNanos() / 1_000n) * 1_000n;
    const deadline = epochNanos(terms.settlementDeadline);
    if (deadline < now + MIN_SETTLEMENT_WINDOW || deadline > now + MAX_SETTLEMENT_WINDOW) {
      throw new InvalidRequest('Settlement deadline must be between thirty seconds and thirty minutes away');
    }
    const baseIn = terms.direction === 'BaseToQuote';
    const inputToken = baseIn ? snapshot.pool.baseToken : snapshot.pool.quoteToken;
    const outputToken = baseIn ? snapshot.pool.quoteToken : snapshot.pool.baseToken;
    const amount = tokenAmount(terms.amountIn, Number(inputToken.decimals), false);
    const minimum = tokenAmount(terms.minOut, Number(outputToken.decimals), true);
    const inputs = await this.pools.inputs(party, inputToken.instrument, amount, snapshot.offset, accessToken);
    const requested = encodeTerms({
      requestId: swapId,
      direction: terms.direction,
      amountIn: amount,
      minOut: minimum,
      settlementDeadline: terms.settlementDeadline,
    });
    const inputAllocation = requireFactory(
      inputToken.allocationFactory,
      await this.registry.inlineAllocation(inputToken.instrument.admin),
    );
    const outputAllocation = requireFactory(
      outputToken.allocationFactory,
      await this.registry.inlineAllocation(outputToken.instrument.admin),
    );
    const inputSettlement = requireFactory(
      inputToken.settlementFactory,
      await this.registry.inlineSettlement(inputToken.instrument.admin),
    );
    const outputSettlement = requireFactory(
      outputToken.settlementFactory,
      await this.registry.inlineSettlement(outputToken.instrument.admin),
    );
    const command = exercise(PoolAccess, access.contractId, REQUEST_SWAP, {
      route: swapRoute(snapshot),
      terms: requested,
      requestedAt: instantText(now),
      inputHoldingCids: inputs,
      inputAllocationArgs: inputAllocation.extraArgs,
      outputAllocationArgs: outputAllocation.extraArgs,
    });
    const disclosures = mergeDisclosures([
      ...inputAllocation.disclosures,
      ...outputAllocation.disclosures,
      ...inputSettlement.disclosures,
      ...outputSettlement.disclosures,
    ]);
    return prepareForWallet(this.interactive, commandId, signer, accessToken, command, disclosures, now);
  }

  submit(pending: Pending, caller: Account, accessToken: string): Promise<Confirmation> {
    return this.execute(pending, caller, accessToken);
  }

  withdraw(pending: Pending, caller: Account, accessToken: string): Promise<Confirmation> {
    return this.execute(pending, caller, accessToken);
  }

  async prepareWithdrawal(
    commandId: string,
    swap: Swap,
    caller: Account,
    accessToken: string,
  ): Promise<SigningPayload> {
    const signer = await this.signers.signer(caller);
    const party = signer.party.partyId;
    if (party !== swap.trader) throw new InvalidRequest('Trader differs from the registered wallet');
    if (swap.allocationCids.length === 0 || clockNanos() <= epochNanos(swap.settlementDeadline)) {
      throw new Conflict('Withdrawals are available after the settlement deadline', 'WITHDRAWAL_NOT_AVAILABLE');
    }
    const offset = await this.ledger.ledgerEnd();
    const poolEvent = await this.pools.poolEvent(swap.poolId, offset);
    const access = await this.pools.access(party, poolEvent, offset);
    const remaining = (
      await this.ledger.activeInterfaceContracts(await this.ledger.primaryParty(), AllocationInterface, offset)
    ).filter((event) => swap.allocationCids.includes(event.contractId));
    if (remaining.length === 0) {
      throw new Conflict('No active allocations remain; refresh the swap status', 'WITHDRAWAL_NOT_AVAILABLE');
    }
    const withdrawals: Record<string, unknown>[] = [];
    const tokenDisclosures = [];
    for (const event of remaining) {
      const context = await this.registry.withdraw(allocationView(event).allocation.admin, event.contractId);
      withdrawals.push({ allocationCid: event.contractId, extraArgs: context.extraArgs });
      tokenDisclosures.push(...context.disclosures);
    }
    const command = exercise(PoolAccess, access.contractId, RECOVER_ALLOCATIONS, { withdrawals });
    const disclosures = await this.pools.poolDisclosure(poolEvent, tokenDisclosures);
    return prepareForWallet(this.interactive, commandId, signer, accessToken, command, disclosures, clockNanos());
  }

  private async execute(pending: Pending, caller: Account, accessToken: string): Promise<Confirmation> {
    const signer = await this.signers.signer(caller);
    const { signing, signature } = signedPreparation(pending);
    let tx: Transaction;
    try {
      tx = await this.interactive.execute(
        pending.commandId,
        signing,
        signature,
        signer.party,
        accessToken,
        signer.userId,
      );
    } catch (error) {
      if (definitelyRejected(error)) {
        throw new SwapRejected('LEDGER_REJECTED', 'Canton rejected the signed transaction');
      }
      throw error;
    }
    const confirmed =
      pending.action === 'WITHDRAW'
        ? withdrawalConfirmation(
            await this.ledger.transactions(pending.beginOffset, await this.ledger.primaryParty()),
            pending.swap,
            tx.offset,
          )
        : requestConfirmation(tx, pending.swap);
    if (!confirmed) throw new Error('Submitted transaction lacks expected swap evidence');
    return confirmed;
  }

  async recover(pending: Pending): Promise<Confirmation | undefined> {
    const history = await this.ledger.history(pending.beginOffset, await this.ledger.primaryParty());
    const confirmation =
      pending.action === 'WITHDRAW'
        ? withdrawalConfirmation(history.transactions, pending.swap, history.endOffset)
        : history.transactions.map((tx) => requestConfirmation(tx, pending.swap)).find((found) => found !== undefined);
    if (confirmation) return confirmation;
    // Record times on the single configured synchronizer are ordered. Once the complete visible
    // history passes the signed maximum record time, this transaction can no longer commit.
    if (history.recordTime !== undefined && epochNanos(history.recordTime) > epochNanos(pending.signing.expiresAt)) {
      throw new SwapRejected('PREPARATION_EXPIRED', 'The signed transaction expired without committing');
    }
    return undefined;
  }

  async observe(pending: Pending): Promise<Confirmation | undefined> {
    const swap = pending.swap;
    const [input, output] = swap.allocationCids;
    const released = new Set<string>();
    let lastWithdrawal: Transaction | undefined;
    for (const tx of await this.ledger.transactions(pending.beginOffset, await this.ledger.primaryParty())) {
      for (const event of tx.events) {
        if ('created' in event && isExactly(event.created.templateId, SwapReceipt)) {
          const receipt = swapReceipt(event.created.createArgument);
          if (
            receipt.inputAllocation === input &&
            receipt.outputAllocation === output &&
            receipt.terms.requestId === swap.swapId &&
            receipt.trader === swap.trader &&
            receipt.poolCid === swap.poolId
          ) {
            return result(tx, 'SETTLED', swap.allocationCids, trimmedText(receipt.amountOut));
          }
        }
        if ('exercised' in event && isWithdrawal(event.exercised, swap)) {
          released.add(event.exercised.contractId);
          lastWithdrawal = tx;
        }
      }
    }
    if (lastWithdrawal && swap.allocationCids.length === 2 && swap.allocationCids.every((id) => released.has(id))) {
      return result(lastWithdrawal, 'WITHDRAWN', swap.allocationCids, null);
    }
    return undefined;
  }
}
