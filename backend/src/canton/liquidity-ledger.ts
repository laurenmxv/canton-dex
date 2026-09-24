import type { Account } from '../iam/accounts.js';
import {
  depositAmounts,
  MINIMUM_LIQUIDITY,
  requireRatio,
  withdrawalAmounts,
  type DepositAmounts,
  type WithdrawalAmounts,
} from '../liquidity/math.js';
import {
  isDepositTerms,
  type Confirmation,
  type DepositQuote,
  type DepositQuoteInput,
  type DepositTerms,
  type LiquidityStatus,
  type Pending,
  type Position,
  type Positions,
  type RecoveryEffect,
  type Request,
  type Result,
  type SigningPayload,
  type Terms,
  type WithdrawalQuote,
  type WithdrawalQuoteInput,
  type WithdrawalTerms,
} from '../liquidity/model.js';
import { LiquidityRejected, type LiquidityLedger } from '../liquidity/ports.js';
import type { PoolDetail } from '../pools/model.js';
import { divideFloor, NUMERIC_SCALE, numericText, numericUnits, trimmedText } from '../platform/decimal.js';
import { Conflict, InvalidRequest } from '../platform/errors.js';
import {
  canonicalInstant,
  clockNanos,
  epochMicros,
  epochNanos,
  instantText,
  NANOS_PER_SECOND,
} from '../platform/time.js';
import { BPS, floorTo, minimumOut, tokenAmount } from '../swaps/math.js';
import type { Instrument } from '../tokens/model.js';
import {
  allocationView,
  MIN_BASE_OUT_KEY,
  MIN_LP_OUT_KEY,
  MIN_QUOTE_OUT_KEY,
  sameMetadata,
  withdrawn,
} from './allocations.js';
import { holdingView, pool as decodePool, sameAccount, type PoolContract, type Token } from './contracts.js';
import { array, record, string } from './decode.js';
import { definitelyRejected } from './http.js';
import { verify, type InteractiveTransactions } from './interactive.js';
import {
  createdEvents,
  exercise,
  exercisedEvents,
  interfaceView,
  type Command,
  type CreatedEvent,
  type DisclosedContract,
  type ExercisedEvent,
  type Ledger,
  type Transaction,
} from './ledger.js';
import {
  AllocationInterface,
  DEX_PACKAGE_ID,
  HoldingInterface,
  isExactly,
  LiquidityReceipt,
  Pool,
  PoolAccess,
} from './packages.js';
import { basicAccount, requireLiquidityReady, requireReady, type CantonPools, type PoolSnapshot } from './pools.js';
import { prepareForWallet, RECOVER_ALLOCATIONS, type Signers } from './swap-ledger.js';
import { mergeDisclosures, requireFactory, type CantonTokenRegistry, type TokenOperation } from './token-registry.js';

const QUOTE_LIFETIME = 30n * NANOS_PER_SECOND;
const QUOTE_SETTLEMENT_WINDOW = 600n * NANOS_PER_SECOND;
const MIN_SETTLEMENT_WINDOW = 30n * NANOS_PER_SECOND;
const MAX_SETTLEMENT_WINDOW = 1_800n * NANOS_PER_SECOND;
const UNIT = 10n ** BigInt(NUMERIC_SCALE);
/** The smallest positive ratio bound, 0.0000000001. */
const MIN_RATIO_BOUND = 1n;
const REQUEST_DEPOSIT = 'PoolAccess_RequestLiquidityDeposit';
const REQUEST_WITHDRAWAL = 'PoolAccess_RequestLiquidityWithdrawal';
const ADD_LIQUIDITY = 'Pool_AddLiquidity';
const WITHDRAW_LIQUIDITY = 'Pool_WithdrawLiquidity';
const LP_BURN_LEG = 'lp-burn';
const SENDER_SIDE = 'SenderSide';
/** The CIP-0112 burn account, which has no owner or provider. */
const BURN_ACCOUNT = { owner: null, provider: null, id: 'cip-112/burn' };
const DEPOSITED = 'LiquidityDeposited';
const WITHDRAWN_LIQUIDITY = 'LiquidityWithdrawn';

/** A liquidity request as the ledger records it, with exact amounts. */
interface LedgerRequest {
  readonly poolCid: string;
  readonly trader: string;
  readonly terms: Readonly<Record<string, unknown>>;
  readonly allocations: readonly [string, string, string];
}

function units(value: unknown, what: string): bigint {
  return numericUnits(string(value, what));
}

function ledgerRequest(value: unknown, what: string): LedgerRequest {
  const fields = record(value, what);
  return {
    poolCid: string(fields.poolCid, `${what}.poolCid`),
    trader: string(fields.trader, `${what}.trader`),
    terms: record(fields.terms, `${what}.terms`),
    allocations: [
      string(fields.baseAllocation, `${what}.baseAllocation`),
      string(fields.quoteAllocation, `${what}.quoteAllocation`),
      string(fields.lpAllocation, `${what}.lpAllocation`),
    ],
  };
}

function damlMode(terms: DepositTerms): string {
  return terms.mode === 'INITIAL' ? 'InitializeOnly' : 'Proportional';
}

function sameAmount(value: unknown, expected: string, what: string): boolean {
  return units(value, what) === numericUnits(expected);
}

function sameTime(value: unknown, expected: string, what: string): boolean {
  return epochNanos(string(value, what)) === epochNanos(expected);
}

/** Signed ledger terms equal the request's approved terms. */
function matchesTerms(signed: Readonly<Record<string, unknown>>, expected: Request): boolean {
  const terms = expected.terms;
  const common =
    string(signed.requestId, 'terms.requestId') === expected.requestId &&
    sameTime(signed.settlementDeadline, terms.settlementDeadline, 'terms.settlementDeadline');
  if (!common) return false;
  if (isDepositTerms(terms)) {
    return (
      signed.mode === damlMode(terms) &&
      sameAmount(signed.maxBaseAmount, terms.maxBaseAmount, 'terms.maxBaseAmount') &&
      sameAmount(signed.maxQuoteAmount, terms.maxQuoteAmount, 'terms.maxQuoteAmount') &&
      sameAmount(signed.minLpOut, terms.minLpOut, 'terms.minLpOut') &&
      sameAmount(signed.minRatio, terms.minRatio, 'terms.minRatio') &&
      sameAmount(signed.maxRatio, terms.maxRatio, 'terms.maxRatio')
    );
  }
  return (
    signed.mode === undefined &&
    sameAmount(signed.lpAmount, terms.lpAmount, 'terms.lpAmount') &&
    sameAmount(signed.minBaseOut, terms.minBaseOut, 'terms.minBaseOut') &&
    sameAmount(signed.minQuoteOut, terms.minQuoteOut, 'terms.minQuoteOut')
  );
}

/** A ledger request of this pool and trader with the request's approved terms. */
function matches(actual: LedgerRequest, expected: Request): boolean {
  return (
    actual.poolCid === expected.terms.poolId &&
    actual.trader === expected.terms.trader &&
    matchesTerms(actual.terms, expected)
  );
}

function sameAllocations(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

function requireAllocations(request: Request): readonly [string, string, string] {
  const [base, quote, lp] = request.allocationCids;
  if (
    request.allocationCids.length !== 3 ||
    new Set(request.allocationCids).size !== 3 ||
    base === undefined ||
    quote === undefined ||
    lp === undefined
  ) {
    throw new Error('Liquidity requires three confirmed allocations');
  }
  return [base, quote, lp];
}

function tokenAt(pool: PoolContract, index: number): Token {
  return index === 0 ? pool.baseToken : index === 1 ? pool.quoteToken : pool.lpToken;
}

function instrumentOf(token: Token): Instrument {
  return { admin: token.instrument.admin, id: token.instrument.id };
}

function sameInstrument(left: Instrument, right: Instrument): boolean {
  return left.admin === right.admin && left.id === right.id;
}

/** `Lib.Liquidity.depositId` or `withdrawalId`: integer units and epoch microseconds. */
export function liquiditySettlementId(request: Request): string {
  const terms = request.terms;
  const atoms = (value: string) => String(numericUnits(value));
  const deadline = String(epochMicros(terms.settlementDeadline));
  if (isDepositTerms(terms)) {
    const amounts = [terms.maxBaseAmount, terms.maxQuoteAmount, terms.minLpOut, terms.minRatio, terms.maxRatio];
    return ['deposit', request.requestId, damlMode(terms), ...amounts.map(atoms), deadline].join(':');
  }
  const amounts = [terms.lpAmount, terms.minBaseOut, terms.minQuoteOut];
  return ['withdrawal', request.requestId, ...amounts.map(atoms), deadline].join(':');
}

/**
 * One of a request's three allocations matches its signed terms: funding for deposited inputs,
 * the signed minimum as metadata for each output, and the LP burn leg of a withdrawal.
 */
export function validateAllocation(event: CreatedEvent, request: Request, pool: PoolContract, index: number): void {
  const view = allocationView(event);
  const spec = view.allocation;
  const token = tokenAt(pool, index);
  const terms = request.terms;
  const deposit = isDepositTerms(terms);
  const burn = !deposit && index === 2;
  const amountText = deposit
    ? [terms.maxBaseAmount, terms.maxQuoteAmount, terms.minLpOut][index]
    : [terms.minBaseOut, terms.minQuoteOut, terms.lpAmount][index];
  const minimumKey = deposit ? [null, null, MIN_LP_OUT_KEY][index] : [MIN_BASE_OUT_KEY, MIN_QUOTE_OUT_KEY, null][index];
  if (amountText === undefined || minimumKey === undefined)
    throw new Error('A liquidity request has three allocations');
  const amount = numericUnits(amountText);
  const metadata = minimumKey === null ? {} : { [minimumKey]: trimmedText(amount) };
  const funding = spec.nextIterationFunding;
  const fundingMatches = burn
    ? funding === null
    : funding !== null &&
      (deposit && index < 2 ? funding.size === 1 && funding.get(token.instrument.id) === amount : funding.size === 0);
  if (
    view.executors.length !== 2 ||
    view.executors[0] !== pool.dvo ||
    view.executors[1] !== pool.venueOperator ||
    view.settlementId !== liquiditySettlementId(request) ||
    view.settlementCid !== terms.poolId ||
    view.numIterations !== 0n ||
    spec.admin !== token.instrument.admin ||
    !sameAccount(spec.authorizer, basicAccount(terms.trader)) ||
    !spec.committed ||
    spec.settlementDeadline === null ||
    epochNanos(spec.settlementDeadline) !== epochNanos(terms.settlementDeadline) ||
    !fundingMatches ||
    !sameMetadata(spec.meta, metadata) ||
    spec.transferLegSides.length !== (burn ? 1 : 0)
  ) {
    throw new Error('Liquidity allocation differs from the signed request');
  }
  const [side] = spec.transferLegSides;
  if (!burn || !side) return;
  if (
    side.transferLegId !== LP_BURN_LEG ||
    side.side !== SENDER_SIDE ||
    !sameAccount(side.otherside, BURN_ACCOUNT) ||
    side.instrumentId !== token.instrument.id ||
    side.amount !== amount
  ) {
    throw new Error('Liquidity allocation leg differs from the signed request');
  }
}

function confirmed(
  tx: Transaction,
  status: LiquidityStatus,
  allocationCids: readonly string[],
  result: Result | null,
): Confirmation {
  return {
    status,
    allocationCids,
    result,
    updateId: tx.updateId,
    offset: tx.offset,
    confirmedAt: canonicalInstant(tx.effectiveAt),
  };
}

/** A completed standard withdrawal of one of the request's allocations by its trader. */
export function isRecovery(event: ExercisedEvent, request: Request): boolean {
  return (
    request.allocationCids.includes(event.contractId) &&
    event.actingParties.includes(request.terms.trader) &&
    withdrawn(event)
  );
}

/** The transaction in which the last of the three allocations was withdrawn. */
function recoveryConfirmation(history: readonly Transaction[], request: Request): Confirmation | undefined {
  if (request.allocationCids.length !== 3 || new Set(request.allocationCids).size !== 3) return undefined;
  const released = new Set<string>();
  for (const tx of history) {
    for (const event of exercisedEvents(tx)) if (isRecovery(event, request)) released.add(event.contractId);
    if (request.allocationCids.every((id) => released.has(id))) {
      return confirmed(tx, 'RECOVERED', request.allocationCids, null);
    }
  }
  return undefined;
}

/** The receipt that the pool's batch choice returned for this request, when it settled it. */
function settlementReceipt(event: ExercisedEvent, request: Request): string | undefined {
  const deposit = isDepositTerms(request.terms);
  if (event.choice !== (deposit ? ADD_LIQUIDITY : WITHDRAW_LIQUIDITY)) return undefined;
  const requests = array(record(event.choiceArgument, event.choice).requests, 'requests', (item, what) =>
    ledgerRequest(record(item, what).request, `${what}.request`),
  );
  const receipts = array(record(event.exerciseResult, 'batch result').receiptCids, 'receiptCids', string);
  if (receipts.length !== requests.length) {
    throw new Error(deposit ? 'Deposit batch receipt count differs' : 'Withdrawal batch receipt count differs');
  }
  const index = requests.findIndex(
    (settled) => matches(settled, request) && sameAllocations(settled.allocations, request.allocationCids),
  );
  return index < 0 ? undefined : receipts[index];
}

function depositOutcome(value: unknown) {
  const outcome = record(value, 'DepositOutcome');
  return {
    base: units(outcome.baseAmount, 'DepositOutcome.baseAmount'),
    quote: units(outcome.quoteAmount, 'DepositOutcome.quoteAmount'),
    baseRefund: units(outcome.baseRefund, 'DepositOutcome.baseRefund'),
    quoteRefund: units(outcome.quoteRefund, 'DepositOutcome.quoteRefund'),
    lp: units(outcome.lpAmount, 'DepositOutcome.lpAmount'),
  };
}

function withdrawalOutcome(value: unknown) {
  const outcome = record(value, 'WithdrawalOutcome');
  return {
    base: units(outcome.baseAmount, 'WithdrawalOutcome.baseAmount'),
    quote: units(outcome.quoteAmount, 'WithdrawalOutcome.quoteAmount'),
    lp: units(outcome.lpAmount, 'WithdrawalOutcome.lpAmount'),
  };
}

function receiptResult(value: unknown, request: Request): Result {
  const receipt = record(value, 'LiquidityReceipt');
  const terms = request.terms;
  if (
    string(receipt.requestId, 'LiquidityReceipt.requestId') !== request.requestId ||
    string(receipt.trader, 'LiquidityReceipt.trader') !== terms.trader ||
    string(receipt.poolCid, 'LiquidityReceipt.poolCid') !== terms.poolId
  ) {
    throw new Error('Liquidity receipt differs from the settled request');
  }
  const outcome = record(receipt.outcome, 'LiquidityReceipt.outcome');
  if (isDepositTerms(terms) && outcome.tag === DEPOSITED) {
    const { base, quote, baseRefund, quoteRefund, lp } = depositOutcome(outcome.value);
    if (
      lp < numericUnits(terms.minLpOut) ||
      base + baseRefund !== numericUnits(terms.maxBaseAmount) ||
      quote + quoteRefund !== numericUnits(terms.maxQuoteAmount)
    ) {
      throw new Error('Deposit receipt violates signed terms');
    }
    return {
      actualBaseIn: trimmedText(base),
      actualQuoteIn: trimmedText(quote),
      actualBaseRefund: trimmedText(baseRefund),
      actualQuoteRefund: trimmedText(quoteRefund),
      actualLpOut: trimmedText(lp),
    };
  }
  if (!isDepositTerms(terms) && outcome.tag === WITHDRAWN_LIQUIDITY) {
    const { base, quote, lp } = withdrawalOutcome(outcome.value);
    if (
      lp !== numericUnits(terms.lpAmount) ||
      base < numericUnits(terms.minBaseOut) ||
      quote < numericUnits(terms.minQuoteOut)
    ) {
      throw new Error('Withdrawal receipt violates signed terms');
    }
    return { actualLpBurned: trimmedText(lp), actualBaseOut: trimmedText(base), actualQuoteOut: trimmedText(quote) };
  }
  throw new Error('Liquidity receipt kind differs from request');
}

/** The request's settled amounts, when this transaction's pool batch choice settled it. */
export function settlementResult(tx: Transaction, request: Request): Result | undefined {
  requireAllocations(request);
  for (const event of exercisedEvents(tx)) {
    if (!isExactly(event.templateId, Pool) || event.contractId !== request.terms.poolId) continue;
    const receiptId = settlementReceipt(event, request);
    if (receiptId === undefined) continue;
    const receipt = createdEvents(tx).find(
      (created) => created.contractId === receiptId && isExactly(created.templateId, LiquidityReceipt),
    );
    if (!receipt) throw new Error('Liquidity settlement receipt is missing');
    return receiptResult(receipt.createArgument, request);
  }
  return undefined;
}

function encodeDepositTerms(requestId: string, terms: DepositTerms): Record<string, unknown> {
  return {
    requestId,
    mode: damlMode(terms),
    maxBaseAmount: numericText(numericUnits(terms.maxBaseAmount)),
    maxQuoteAmount: numericText(numericUnits(terms.maxQuoteAmount)),
    minLpOut: numericText(numericUnits(terms.minLpOut)),
    minRatio: numericText(numericUnits(terms.minRatio)),
    maxRatio: numericText(numericUnits(terms.maxRatio)),
    settlementDeadline: terms.settlementDeadline,
  };
}

function encodeWithdrawalTerms(requestId: string, terms: WithdrawalTerms): Record<string, unknown> {
  return {
    requestId,
    lpAmount: numericText(numericUnits(terms.lpAmount)),
    minBaseOut: numericText(numericUnits(terms.minBaseOut)),
    minQuoteOut: numericText(numericUnits(terms.minQuoteOut)),
    settlementDeadline: terms.settlementDeadline,
  };
}

/** The signed `DepositRequest` or `WithdrawalRequest` record of a confirmed request. */
export function liquidityRequestOf(request: Request): Record<string, unknown> {
  const [baseAllocation, quoteAllocation, lpAllocation] = requireAllocations(request);
  const terms = request.terms;
  return {
    poolCid: terms.poolId,
    trader: terms.trader,
    terms: isDepositTerms(terms)
      ? encodeDepositTerms(request.requestId, terms)
      : encodeWithdrawalTerms(request.requestId, terms),
    baseAllocation,
    quoteAllocation,
    lpAllocation,
  };
}

function requireInstruments(terms: Terms, pool: PoolContract): void {
  if (
    !sameInstrument(terms.baseInstrument, instrumentOf(pool.baseToken)) ||
    !sameInstrument(terms.quoteInstrument, instrumentOf(pool.quoteToken)) ||
    !sameInstrument(terms.lpInstrument, instrumentOf(pool.lpToken))
  ) {
    throw new InvalidRequest('Liquidity instruments differ from the pool');
  }
}

/** The deposit at the given reserves, checked against the signed limits. */
export function validateDeposit(
  snapshot: PoolSnapshot,
  terms: DepositTerms,
  baseReserve: bigint,
  quoteReserve: bigint,
  supply: bigint,
): DepositAmounts {
  if ((supply === 0n) !== (terms.mode === 'INITIAL')) {
    throw new Conflict('Pool initialization changed; request a new quote', 'DEPOSIT_MODE_CHANGED');
  }
  requireInstruments(terms, snapshot.pool);
  const baseDecimals = Number(snapshot.pool.baseToken.decimals);
  const quoteDecimals = Number(snapshot.pool.quoteToken.decimals);
  const base = tokenAmount(terms.maxBaseAmount, baseDecimals, false);
  const quote = tokenAmount(terms.maxQuoteAmount, quoteDecimals, false);
  const minimum = tokenAmount(terms.minLpOut, NUMERIC_SCALE, true);
  const minRatio = tokenAmount(terms.minRatio, NUMERIC_SCALE, false);
  const maxRatio = tokenAmount(terms.maxRatio, NUMERIC_SCALE, false);
  if (minRatio > maxRatio) throw new InvalidRequest('Ratio bounds are reversed');
  const initialRatio = numericUnits(snapshot.config.initialRatio);
  requireRatio(supply === 0n ? UNIT : baseReserve, supply === 0n ? initialRatio : quoteReserve, minRatio, maxRatio);
  const result = depositAmounts(
    base,
    quote,
    initialRatio,
    baseReserve,
    quoteReserve,
    supply,
    baseDecimals,
    quoteDecimals,
  );
  if (result.lp < minimum) throw new Conflict('Current reserves cannot satisfy the minimum LP output', 'MIN_LP_OUT');
  return result;
}

/** The withdrawal at the given reserves, checked against the signed minimum outputs. */
export function validateWithdrawal(
  snapshot: PoolSnapshot,
  terms: WithdrawalTerms,
  baseReserve: bigint,
  quoteReserve: bigint,
  supply: bigint,
): WithdrawalAmounts {
  requireInstruments(terms, snapshot.pool);
  const baseDecimals = Number(snapshot.pool.baseToken.decimals);
  const quoteDecimals = Number(snapshot.pool.quoteToken.decimals);
  const lp = tokenAmount(terms.lpAmount, NUMERIC_SCALE, false);
  const minBase = tokenAmount(terms.minBaseOut, baseDecimals, true);
  const minQuote = tokenAmount(terms.minQuoteOut, quoteDecimals, true);
  const result = withdrawalAmounts(lp, baseReserve, quoteReserve, supply, baseDecimals, quoteDecimals);
  if (result.base < minBase || result.quote < minQuote) {
    throw new Conflict('Current reserves cannot satisfy the signed withdrawal outputs', 'MIN_OUT');
  }
  return result;
}

function reserves(snapshot: PoolSnapshot) {
  return {
    base: numericUnits(snapshot.state.baseReserve),
    quote: numericUnits(snapshot.state.quoteReserve),
    supply: numericUnits(snapshot.state.lpTokenSupply),
  };
}

/** The allocation and settlement arguments of the three tokens, with their disclosures. */
export interface LiquidityOperations {
  readonly args: Record<string, unknown>;
  readonly disclosures: DisclosedContract[];
}

/** The pools whose LP positions a trader can hold. */
export interface PoolList {
  pools(packageId: string): Promise<PoolDetail[]>;
}

/**
 * LP deposits and withdrawals over the trader's pool access: each request locks three allocations
 * in one signed transaction. Recovery and settlement observation read the operator's complete
 * history; absence is never proof of rejection.
 */
export class CantonLiquidityLedger implements LiquidityLedger {
  constructor(
    private readonly ledger: Ledger,
    private readonly pools: CantonPools,
    private readonly catalog: PoolList,
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

  async quoteDeposit(
    quoteId: string,
    caller: Account,
    accessToken: string,
    input: DepositQuoteInput,
  ): Promise<DepositQuote> {
    const party = (await this.signers.signer(caller)).party.partyId;
    const snapshot = await this.pools.read(input.poolId);
    requireLiquidityReady(snapshot);
    await this.pools.access(party, snapshot.poolEvent, snapshot.offset);
    const { baseToken, quoteToken, lpToken } = snapshot.pool;
    const maxBase = tokenAmount(input.maxBaseAmount, Number(baseToken.decimals), false);
    const maxQuote = tokenAmount(input.maxQuoteAmount, Number(quoteToken.decimals), false);
    await this.pools.inputs(party, baseToken.instrument, maxBase, snapshot.offset, accessToken);
    await this.pools.inputs(party, quoteToken.instrument, maxQuote, snapshot.offset, accessToken);
    const current = reserves(snapshot);
    const initialRatio = numericUnits(snapshot.config.initialRatio);
    const amounts = depositAmounts(
      maxBase,
      maxQuote,
      initialRatio,
      current.base,
      current.quote,
      current.supply,
      Number(baseToken.decimals),
      Number(quoteToken.decimals),
    );
    const initial = current.supply === 0n;
    // The price bounds are quote per base, in units: `numerator × (1 ± slippage) / denominator`.
    const numerator = initial ? initialRatio : current.quote;
    const denominator = (initial ? UNIT : current.base) * BPS;
    const lowerTop = numerator * (BPS - BigInt(input.slippageBps)) * UNIT;
    const upperTop = numerator * (BPS + BigInt(input.slippageBps)) * UNIT;
    const lower = lowerTop / denominator;
    const upper = upperTop / denominator + (upperTop % denominator === 0n ? 0n : 1n);
    const now = clockNanos();
    return {
      quoteId,
      poolId: input.poolId,
      poolName: snapshot.name,
      trader: party,
      baseInstrument: instrumentOf(baseToken),
      quoteInstrument: instrumentOf(quoteToken),
      lpInstrument: instrumentOf(lpToken),
      mode: initial ? 'INITIAL' : 'PROPORTIONAL',
      maxBaseAmount: trimmedText(maxBase),
      maxQuoteAmount: trimmedText(maxQuote),
      expectedBaseAmount: trimmedText(amounts.base),
      expectedQuoteAmount: trimmedText(amounts.quote),
      expectedBaseRefund: trimmedText(amounts.baseRefund),
      expectedQuoteRefund: trimmedText(amounts.quoteRefund),
      expectedLpOut: trimmedText(amounts.lp),
      minLpOut: trimmedText(minimumOut(amounts.lp, input.slippageBps, NUMERIC_SCALE)),
      minRatio: trimmedText(lower === 0n ? MIN_RATIO_BOUND : lower),
      maxRatio: trimmedText(upper),
      initialMinimumLp: initial ? trimmedText(MINIMUM_LIQUIDITY) : null,
      slippageBps: input.slippageBps,
      stateId: snapshot.stateEvent.contractId,
      quoteExpiresAt: instantText(now + QUOTE_LIFETIME),
      settlementDeadline: instantText(((now + QUOTE_SETTLEMENT_WINDOW) / NANOS_PER_SECOND) * NANOS_PER_SECOND),
    };
  }

  async quoteWithdrawal(
    quoteId: string,
    caller: Account,
    accessToken: string,
    input: WithdrawalQuoteInput,
  ): Promise<WithdrawalQuote> {
    const party = (await this.signers.signer(caller)).party.partyId;
    const snapshot = await this.pools.read(input.poolId);
    requireReady(snapshot);
    await this.pools.access(party, snapshot.poolEvent, snapshot.offset);
    const { baseToken, quoteToken, lpToken } = snapshot.pool;
    const lp = tokenAmount(input.lpAmount, NUMERIC_SCALE, false);
    await this.pools.inputs(party, lpToken.instrument, lp, snapshot.offset, accessToken);
    const current = reserves(snapshot);
    const amounts = withdrawalAmounts(
      lp,
      current.base,
      current.quote,
      current.supply,
      Number(baseToken.decimals),
      Number(quoteToken.decimals),
    );
    const now = clockNanos();
    return {
      quoteId,
      poolId: input.poolId,
      poolName: snapshot.name,
      trader: party,
      baseInstrument: instrumentOf(baseToken),
      quoteInstrument: instrumentOf(quoteToken),
      lpInstrument: instrumentOf(lpToken),
      lpAmount: trimmedText(lp),
      expectedBaseOut: trimmedText(amounts.base),
      expectedQuoteOut: trimmedText(amounts.quote),
      minBaseOut: trimmedText(minimumOut(amounts.base, input.slippageBps, Number(baseToken.decimals))),
      minQuoteOut: trimmedText(minimumOut(amounts.quote, input.slippageBps, Number(quoteToken.decimals))),
      slippageBps: input.slippageBps,
      stateId: snapshot.stateEvent.contractId,
      quoteExpiresAt: instantText(now + QUOTE_LIFETIME),
      settlementDeadline: instantText(((now + QUOTE_SETTLEMENT_WINDOW) / NANOS_PER_SECOND) * NANOS_PER_SECOND),
    };
  }

  async prepare(
    requestId: string,
    commandId: string,
    caller: Account,
    accessToken: string,
    terms: Terms,
  ): Promise<SigningPayload> {
    const signer = await this.signers.signer(caller);
    const party = signer.party.partyId;
    if (party !== terms.trader) throw new InvalidRequest('Trader differs from the registered wallet');
    const snapshot = await this.pools.read(terms.poolId);
    requireLiquidityReady(snapshot);
    requireInstruments(terms, snapshot.pool);
    const access = await this.pools.access(party, snapshot.poolEvent, snapshot.offset);
    const now = (clockNanos() / 1_000n) * 1_000n;
    const deadline = epochNanos(terms.settlementDeadline);
    if (deadline < now + MIN_SETTLEMENT_WINDOW || deadline > now + MAX_SETTLEMENT_WINDOW) {
      throw new InvalidRequest('Settlement deadline must be thirty seconds to thirty minutes away');
    }
    const operations = await this.operations(snapshot);
    const current = reserves(snapshot);
    const { baseToken, quoteToken, lpToken } = snapshot.pool;
    let command: Command;
    if (isDepositTerms(terms)) {
      validateDeposit(snapshot, terms, current.base, current.quote, current.supply);
      const baseInputs = await this.pools.inputs(
        party,
        baseToken.instrument,
        numericUnits(terms.maxBaseAmount),
        snapshot.offset,
        accessToken,
      );
      const quoteInputs = await this.pools.inputs(
        party,
        quoteToken.instrument,
        numericUnits(terms.maxQuoteAmount),
        snapshot.offset,
        accessToken,
      );
      command = exercise(PoolAccess, access.contractId, REQUEST_DEPOSIT, {
        terms: encodeDepositTerms(requestId, terms),
        requestedAt: instantText(now),
        baseHoldingCids: baseInputs,
        quoteHoldingCids: quoteInputs,
        baseAllocationArgs: operations.args.baseAllocationArgs,
        quoteAllocationArgs: operations.args.quoteAllocationArgs,
        lpAllocationArgs: operations.args.lpAllocationArgs,
      });
    } else {
      validateWithdrawal(snapshot, terms, current.base, current.quote, current.supply);
      const inputs = await this.pools.inputs(
        party,
        lpToken.instrument,
        numericUnits(terms.lpAmount),
        snapshot.offset,
        accessToken,
      );
      command = exercise(PoolAccess, access.contractId, REQUEST_WITHDRAWAL, {
        terms: encodeWithdrawalTerms(requestId, terms),
        requestedAt: instantText(now),
        lpHoldingCids: inputs,
        baseAllocationArgs: operations.args.baseAllocationArgs,
        quoteAllocationArgs: operations.args.quoteAllocationArgs,
        lpAllocationArgs: operations.args.lpAllocationArgs,
      });
    }
    const disclosures = await this.pools.poolDisclosure(snapshot.poolEvent, operations.disclosures);
    const prepared = await prepareForWallet(
      this.interactive,
      commandId,
      signer,
      accessToken,
      command,
      disclosures,
      now,
    );
    return { ...prepared, recoveryEffects: [] };
  }

  submit(pending: Pending, caller: Account, accessToken: string): Promise<Confirmation> {
    return this.execute(pending, caller, accessToken);
  }

  executeRecovery(pending: Pending, caller: Account, accessToken: string): Promise<Confirmation> {
    return this.execute(pending, caller, accessToken);
  }

  private async execute(pending: Pending, caller: Account, accessToken: string): Promise<Confirmation> {
    const signer = await this.signers.signer(caller);
    if (pending.signature === null) throw new Error('A dispatched preparation has no signature');
    let tx: Transaction;
    try {
      tx = await this.interactive.execute(
        pending.commandId,
        pending.signing,
        pending.signature,
        signer.party,
        accessToken,
        signer.userId,
      );
    } catch (error) {
      if (definitelyRejected(error)) {
        throw new LiquidityRejected('LEDGER_REJECTED', 'Canton rejected the signed liquidity transaction');
      }
      throw error;
    }
    const found =
      pending.action === 'SUBMIT'
        ? await this.confirmation(tx, pending.request)
        : recoveryConfirmation(
            await this.ledger.transactions(pending.beginOffset, await this.ledger.primaryParty()),
            pending.request,
          );
    if (!found) throw new Error('Submitted transaction lacks expected liquidity evidence');
    return found;
  }

  async recover(pending: Pending): Promise<Confirmation | undefined> {
    const history = await this.ledger.history(pending.beginOffset, await this.ledger.primaryParty());
    let found: Confirmation | undefined;
    if (pending.action === 'RECOVER') {
      found = recoveryConfirmation(history.transactions, pending.request);
    } else {
      for (const tx of history.transactions) {
        found = await this.confirmation(tx, pending.request);
        if (found) break;
      }
    }
    if (found) return found;
    if (history.recordTime !== undefined && epochNanos(history.recordTime) > epochNanos(pending.signing.expiresAt)) {
      throw new LiquidityRejected('PREPARATION_EXPIRED', 'The signed transaction expired without committing');
    }
    return undefined;
  }

  async observe(pending: Pending): Promise<Confirmation | undefined> {
    const history = await this.ledger.transactions(pending.beginOffset, await this.ledger.primaryParty());
    for (const tx of history) {
      const result = settlementResult(tx, pending.request);
      if (result) return confirmed(tx, 'SETTLED', pending.request.allocationCids, result);
    }
    return recoveryConfirmation(history, pending.request);
  }

  async prepareRecovery(
    commandId: string,
    request: Request,
    caller: Account,
    accessToken: string,
  ): Promise<SigningPayload> {
    const signer = await this.signers.signer(caller);
    const party = signer.party.partyId;
    if (party !== request.terms.trader) throw new InvalidRequest('Trader differs from the registered wallet');
    if (request.allocationCids.length !== 3 || clockNanos() <= epochNanos(request.terms.settlementDeadline)) {
      throw new Conflict('Recovery is available after the settlement deadline', 'RECOVERY_NOT_AVAILABLE');
    }
    const offset = await this.ledger.ledgerEnd();
    const poolEvent = await this.pools.poolEvent(request.terms.poolId, offset);
    const access = await this.pools.access(party, poolEvent, offset);
    const remaining = (
      await this.ledger.activeInterfaceContracts(await this.ledger.primaryParty(), AllocationInterface, offset)
    ).filter((event) => request.allocationCids.includes(event.contractId));
    if (remaining.length === 0) {
      throw new Conflict('No active allocations remain; refresh the request', 'RECOVERY_NOT_AVAILABLE');
    }
    const pool = decodePool(poolEvent.createArgument);
    const withdrawals: Record<string, unknown>[] = [];
    const tokenDisclosures: DisclosedContract[] = [];
    const effects: RecoveryEffect[] = [];
    for (const event of remaining) {
      const index = request.allocationCids.indexOf(event.contractId);
      validateAllocation(event, request, pool, index);
      const context = await this.registry.withdraw(allocationView(event).allocation.admin, event.contractId);
      withdrawals.push({ allocationCid: event.contractId, extraArgs: context.extraArgs });
      tokenDisclosures.push(...context.disclosures);
      effects.push(this.recoveryEffect(event.contractId, request, pool, index));
    }
    const command = exercise(PoolAccess, access.contractId, RECOVER_ALLOCATIONS, { withdrawals });
    const disclosures = await this.pools.poolDisclosure(poolEvent, tokenDisclosures);
    const prepared = await prepareForWallet(
      this.interactive,
      commandId,
      signer,
      accessToken,
      command,
      disclosures,
      clockNanos(),
    );
    return { ...prepared, recoveryEffects: effects };
  }

  /** A deposit returns its two funded inputs; a withdrawal returns its LP. The rest release permissions. */
  private recoveryEffect(allocationCid: string, request: Request, pool: PoolContract, index: number): RecoveryEffect {
    const terms = request.terms;
    const funds = isDepositTerms(terms) ? index < 2 : index === 2;
    const amount = !funds
      ? '0'
      : isDepositTerms(terms)
        ? index === 0
          ? terms.maxBaseAmount
          : terms.maxQuoteAmount
        : terms.lpAmount;
    return {
      allocationCid,
      instrument: instrumentOf(tokenAt(pool, index)),
      amount,
      kind: funds ? 'RETURN_FUNDS' : 'RELEASE_PERMISSION',
    };
  }

  async positions(caller: Account, accessToken: string): Promise<Positions> {
    const trader = (await this.signers.signer(caller)).party.partyId;
    const offset = await this.ledger.ledgerEnd();
    const holdings = (
      await this.ledger.forCaller(accessToken).activeInterfaceContracts(trader, HoldingInterface, offset)
    )
      .map((event) => holdingView(interfaceView(event, HoldingInterface)))
      .filter((holding) => sameAccount(holding.account, basicAccount(trader)));
    const items: Position[] = [];
    for (const detail of await this.catalog.pools(DEX_PACKAGE_ID)) {
      const snapshot = await this.pools.read(detail.poolId, offset);
      const lpInstrument = instrumentOf(snapshot.pool.lpToken);
      let available = 0n;
      let allocated = 0n;
      for (const holding of holdings) {
        if (!sameInstrument(holding.instrumentId, lpInstrument)) continue;
        if (holding.locked) allocated += numericUnits(holding.amount);
        else available += numericUnits(holding.amount);
      }
      const total = available + allocated;
      if (total === 0n) continue;
      const { base, quote, supply } = reserves(snapshot);
      if (supply <= 0n) throw new Error('LP holdings exist without supply');
      items.push({
        poolId: detail.poolId,
        poolName: detail.name,
        baseInstrument: instrumentOf(snapshot.pool.baseToken),
        quoteInstrument: instrumentOf(snapshot.pool.quoteToken),
        lpInstrument,
        availableLp: trimmedText(available),
        allocatedLp: trimmedText(allocated),
        totalLp: trimmedText(total),
        lpTokenSupply: trimmedText(supply),
        share: trimmedText(divideFloor(total, supply)),
        baseValue: trimmedText(floorTo((total * base) / supply, Number(snapshot.pool.baseToken.decimals))),
        quoteValue: trimmedText(floorTo((total * quote) / supply, Number(snapshot.pool.quoteToken.decimals))),
      });
    }
    return { items, asOfOffset: offset };
  }

  /** The three tokens' allocation and settlement arguments, from their approved factories. */
  async operations(snapshot: PoolSnapshot): Promise<LiquidityOperations> {
    const allocations: TokenOperation[] = [];
    const settlements: TokenOperation[] = [];
    for (const token of [snapshot.pool.baseToken, snapshot.pool.quoteToken, snapshot.pool.lpToken]) {
      allocations.push(
        requireFactory(token.allocationFactory, await this.registry.inlineAllocation(token.instrument.admin)),
      );
      settlements.push(
        requireFactory(token.settlementFactory, await this.registry.inlineSettlement(token.instrument.admin)),
      );
    }
    const [baseAllocation, quoteAllocation, lpAllocation] = allocations;
    const [baseSettlement, quoteSettlement, lpSettlement] = settlements;
    if (!baseAllocation || !quoteAllocation || !lpAllocation || !baseSettlement || !quoteSettlement || !lpSettlement) {
      throw new Error('A pool has three tokens');
    }
    return {
      args: {
        baseAllocationArgs: baseAllocation.extraArgs,
        quoteAllocationArgs: quoteAllocation.extraArgs,
        lpAllocationArgs: lpAllocation.extraArgs,
        baseSettlementArgs: baseSettlement.extraArgs,
        quoteSettlementArgs: quoteSettlement.extraArgs,
        lpSettlementArgs: lpSettlement.extraArgs,
      },
      disclosures: mergeDisclosures(
        allocations.flatMap((operation, index) => [
          ...operation.disclosures,
          ...(settlements[index]?.disclosures ?? []),
        ]),
      ),
    };
  }

  /** The trader's request transaction: the signed terms and the three allocations it created. */
  private async confirmation(tx: Transaction, expected: Request): Promise<Confirmation | undefined> {
    const deposit = isDepositTerms(expected.terms);
    for (const event of exercisedEvents(tx)) {
      if (event.actingParties.length !== 1 || event.actingParties[0] !== expected.terms.trader) continue;
      const choice = deposit ? REQUEST_DEPOSIT : REQUEST_WITHDRAWAL;
      if (!isExactly(event.templateId, PoolAccess) || event.choice !== choice) continue;
      const request = ledgerRequest(event.exerciseResult, deposit ? 'DepositRequest' : 'WithdrawalRequest');
      if (string(request.terms.requestId, 'terms.requestId') !== expected.requestId) continue;
      const signed = record(record(event.choiceArgument, choice).terms, `${choice}.terms`);
      // The request equals the approved terms, so the choice's own terms must equal them too.
      if (!matches(request, expected) || !matchesTerms(signed, expected)) {
        throw new Error(`Confirmed ${deposit ? 'deposit' : 'withdrawal'} differs from the signed request`);
      }
      const cids = request.allocations;
      if (new Set(cids).size !== 3) throw new Error('Liquidity requires three distinct allocations');
      const pool = decodePool((await this.pools.poolEvent(expected.terms.poolId, tx.offset)).createArgument);
      cids.forEach((cid, index) => {
        const allocation = createdEvents(tx).find((created) => created.contractId === cid);
        if (!allocation) throw new Error('Transaction lacks a requested allocation');
        validateAllocation(allocation, expected, pool, index);
      });
      return confirmed(tx, 'READY', cids, null);
    }
    return undefined;
  }
}
