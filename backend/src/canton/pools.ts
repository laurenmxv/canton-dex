import type { PoolDetail, Terms } from '../pools/model.js';
import { divideHalfUp, NUMERIC_SCALE, numericUnits, plainText, trimmedText } from '../platform/decimal.js';
import { Conflict } from '../platform/errors.js';
import { clockNanos, instantText } from '../platform/time.js';
import type { Reserves } from '../settlements/model.js';
import type { Instrument } from '../tokens/model.js';
import {
  access,
  attestation,
  encodeToken,
  holdingView,
  pool,
  poolConfig,
  poolState,
  sameAccount,
  venueDelegation,
  type DamlAccount,
  type PoolConfigContract,
  type PoolContract,
  type PoolStateContract,
  type Token,
} from './contracts.js';
import { interfaceView, type CreatedEvent, type DisclosedContract, type Ledger } from './ledger.js';
import {
  DEX_PACKAGE_ID,
  HoldingInterface,
  KycAttestation,
  packageOf,
  Pool,
  PoolAccess,
  PoolConfig,
  PoolState,
  VenueDelegation,
  type DamlName,
} from './packages.js';
import { mergeDisclosures, requireFactory, type CantonTokenRegistry } from './token-registry.js';

const POOL_UNAVAILABLE = 'POOL_UNAVAILABLE';
/** The Daml limit on the holdings one allocation may spend. */
const MAX_INPUT_HOLDINGS = 16;

function validateComponents(value: PoolContract, config: PoolConfigContract, state: PoolStateContract): void {
  if (
    config.poolCid !== state.poolCid ||
    value.dvo !== config.dvo ||
    value.dvo !== state.dvo ||
    value.venueOperator !== config.venueOperator ||
    value.venueOperator !== state.venueOperator
  ) {
    throw new Error('Pool components differ');
  }
}

/** The stored pool settings of a coherent pool, config and state. */
export function poolTerms(value: PoolContract, config: PoolConfigContract, state: PoolStateContract): Terms {
  validateComponents(value, config, state);
  const reserveAccount = (reserve: DamlAccount) => {
    if (reserve.owner === null) throw new Error('Pool reserve account has no owner');
    return { owner: reserve.owner, provider: reserve.provider, id: reserve.id };
  };
  return {
    dvo: value.dvo,
    baseInstrumentId: value.baseToken.instrument,
    quoteInstrumentId: value.quoteToken.instrument,
    baseAccount: reserveAccount(value.baseAccount),
    quoteAccount: reserveAccount(value.quoteAccount),
    lpTokenInstrumentId: value.lpToken.instrument,
    feeBps: config.feeBps,
    baseReserve: state.baseReserve,
    quoteReserve: state.quoteReserve,
    lpTokenSupply: state.lpTokenSupply,
    initialRatio: config.initialRatio,
  };
}

/** A coherent ledger read of one pool, with its settlement health. */
export interface PoolSnapshot {
  readonly poolId: string;
  readonly name: string;
  readonly offset: bigint;
  readonly observedAt: string;
  readonly poolEvent: CreatedEvent;
  readonly pool: PoolContract;
  readonly configEvent: CreatedEvent;
  readonly config: PoolConfigContract;
  readonly stateEvent: CreatedEvent;
  readonly state: PoolStateContract;
  readonly delegationEvent: CreatedEvent | null;
  readonly health: string;
  readonly reason: string | null;
}

/** The pool catalog and venue authority that a ledger read is checked against. */
export interface PoolCatalog {
  pool(id: string, packageId: string): Promise<PoolDetail>;
  dvo(): Promise<string>;
}

/** The pool state's reserves, spot price (quote per base, half up at scale 10) and invariant. */
export function poolReserves(snapshot: PoolSnapshot): Reserves {
  const base = numericUnits(snapshot.state.baseReserve);
  const quote = numericUnits(snapshot.state.quoteReserve);
  return {
    stateId: snapshot.stateEvent.contractId,
    baseReserve: trimmedText(base),
    quoteReserve: trimmedText(quote),
    spotPrice: base === 0n ? null : trimmedText(divideHalfUp(quote, base)),
    invariant: plainText(base * quote, 2 * NUMERIC_SCALE),
  };
}

/** The pool version that settlement freezes: its current state and config contracts. */
export function snapshotVersion(snapshot: PoolSnapshot): string {
  return `${snapshot.stateEvent.contractId}:${snapshot.configEvent.contractId}`;
}

/** Deposits may initialize an empty pool; every other request needs a funded one. */
export function requireLiquidityReady(snapshot: PoolSnapshot): void {
  if (snapshot.health !== 'READY' && snapshot.health !== 'EMPTY') {
    throw new Conflict(snapshot.reason ?? '', snapshot.health);
  }
}

export function requireReady(snapshot: PoolSnapshot): void {
  if (snapshot.health !== 'READY') throw new Conflict(snapshot.reason ?? '', snapshot.health);
}

/** The `SwapRoute` record that swap commands name. */
export function swapRoute(snapshot: PoolSnapshot): Record<string, unknown> {
  const value = snapshot.pool;
  return {
    poolCid: snapshot.poolId,
    dvo: value.dvo,
    venueOperator: value.venueOperator,
    baseToken: encodeToken(value.baseToken),
    quoteToken: encodeToken(value.quoteToken),
    baseAccount: value.baseAccount,
    quoteAccount: value.quoteAccount,
  };
}

/** The trader's own account: no provider and no account id. */
export function basicAccount(party: string): DamlAccount {
  return { owner: party, provider: null, id: '' };
}

function sameInstrument(left: Instrument, right: Instrument): boolean {
  return left.admin === right.admin && left.id === right.id;
}

/**
 * The fewest holdings that cover `amount`: unlocked ones first, then the largest, with the
 * contract id breaking ties. Lock policy is the token factory's to enforce.
 */
export function selectInputs(
  candidates: readonly CreatedEvent[],
  trader: string,
  instrument: Instrument,
  amount: bigint,
): string[] {
  const owner = basicAccount(trader);
  const available = candidates
    .map((event) => ({ id: event.contractId, holding: holdingView(interfaceView(event, HoldingInterface)) }))
    .filter(({ holding }) => sameInstrument(holding.instrumentId, instrument) && sameAccount(holding.account, owner))
    .map(({ id, holding }) => ({ id, amount: numericUnits(holding.amount), locked: holding.locked }))
    .sort(
      (left, right) =>
        Number(left.locked) - Number(right.locked) ||
        (right.amount > left.amount ? 1 : right.amount < left.amount ? -1 : 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  let total = 0n;
  const selected: string[] = [];
  for (const input of available) {
    total += input.amount;
    selected.push(input.id);
    if (selected.length > MAX_INPUT_HOLDINGS) {
      throw new Conflict(
        'This input needs more than sixteen holdings; consolidate the wallet holdings first',
        'TOO_MANY_HOLDINGS',
      );
    }
    if (total >= amount) return selected;
  }
  throw new Conflict('Available token balance is too small', 'INSUFFICIENT_BALANCE');
}

function disclosure(event: CreatedEvent, synchronizerId: string): DisclosedContract {
  return {
    templateId: event.templateId,
    contractId: event.contractId,
    createdEventBlob: event.createdEventBlob,
    synchronizerId,
  };
}

function single(events: readonly CreatedEvent[], name: string): CreatedEvent {
  const [only] = events;
  if (events.length !== 1 || !only) throw new Conflict(`${name} is missing or ambiguous`, POOL_UNAVAILABLE);
  return only;
}

/** The pool's holdings match its reserve: the exact contracts, account, instrument and total. */
function backed(
  holdings: readonly CreatedEvent[],
  ids: readonly string[],
  owner: DamlAccount,
  instrument: Instrument,
  reserve: string,
): boolean {
  const expected = new Set(ids);
  if (expected.size !== ids.length) return false;
  let total = 0n;
  let count = 0;
  for (const event of holdings) {
    if (!expected.has(event.contractId)) continue;
    const holding = holdingView(interfaceView(event, HoldingInterface));
    if (
      !sameAccount(holding.account, owner) ||
      holding.instrumentId.admin !== instrument.admin ||
      holding.instrumentId.id !== instrument.id
    ) {
      return false;
    }
    total += numericUnits(holding.amount);
    count += 1;
  }
  return count === ids.length && total === numericUnits(reserve);
}

/** Coherent pool reads, using the operator's read-only view of the reserve accounts. */
export class CantonPools {
  constructor(
    private readonly ledger: Ledger,
    private readonly catalog: PoolCatalog,
    private readonly registry: CantonTokenRegistry,
  ) {}

  /** The pool, its one current config and state, its delegation and its health, all at one offset. */
  async read(poolId: string, offset?: bigint): Promise<PoolSnapshot> {
    const at = offset ?? (await this.ledger.ledgerEnd());
    const entry = await this.catalog.pool(poolId, DEX_PACKAGE_ID);
    const operator = await this.ledger.primaryParty();
    const poolEvent = single(
      (await this.contracts(operator, Pool, at)).filter((event) => event.contractId === poolId),
      'Pool',
    );
    const value = pool(poolEvent.createArgument);
    if (value.venueOperator !== operator || value.dvo !== (await this.catalog.dvo())) {
      throw new Error('Pool authority differs from the configured venue');
    }
    const configEvent = single(
      (await this.contracts(operator, PoolConfig, at)).filter(
        (event) => poolConfig(event.createArgument).poolCid === poolId,
      ),
      'Pool configuration',
    );
    const stateEvent = single(
      (await this.contracts(operator, PoolState, at)).filter(
        (event) => poolState(event.createArgument).poolCid === poolId,
      ),
      'Pool state',
    );
    const config = poolConfig(configEvent.createArgument);
    const state = poolState(stateEvent.createArgument);
    validateComponents(value, config, state);
    const delegations = (await this.contracts(operator, VenueDelegation, at)).filter((event) => {
      const delegation = venueDelegation(event.createArgument);
      return delegation.poolCid === poolId && delegation.dvo === value.dvo && delegation.venueOperator === operator;
    });
    if (delegations.length > 1) throw new Error('Multiple settlement delegations for pool');
    const { health, reason } = await this.health(value, state, delegations.length > 0, at);
    return {
      poolId,
      name: entry.name,
      offset: at,
      observedAt: instantText(clockNanos()),
      poolEvent,
      pool: value,
      configEvent,
      config,
      stateEvent,
      state,
      delegationEvent: delegations[0] ?? null,
      health,
      reason,
    };
  }

  /**
   * EMPTY or READY by LP supply, unless the reserve holdings, the delegation or a token factory is
   * missing or changed.
   */
  private async health(
    value: PoolContract,
    state: PoolStateContract,
    delegated: boolean,
    offset: bigint,
  ): Promise<{ readonly health: string; readonly reason: string | null }> {
    const holdings = await this.ledger.activeInterfaceContracts(value.dvo, HoldingInterface, offset);
    const isBacked =
      backed(holdings, state.baseHoldingCids, value.baseAccount, value.baseToken.instrument, state.baseReserve) &&
      backed(holdings, state.quoteHoldingCids, value.quoteAccount, value.quoteToken.instrument, state.quoteReserve);
    if (!isBacked) return { health: 'BACKING_MISMATCH', reason: 'Pool holdings do not match reserves' };
    if (!delegated) return { health: 'DELEGATION_MISSING', reason: 'Settlement authority is unavailable' };
    try {
      for (const token of [value.baseToken, value.quoteToken, value.lpToken]) await this.requireFactories(token);
    } catch (error) {
      if (!(error instanceof Conflict) || error.code === undefined) throw error;
      return { health: error.code, reason: error.message };
    }
    return { health: numericUnits(state.lpTokenSupply) === 0n ? 'EMPTY' : 'READY', reason: null };
  }

  /** The token's approved factories are still its issuer's configured ones. */
  private async requireFactories(token: Token): Promise<void> {
    requireFactory(token.allocationFactory, await this.registry.inlineAllocation(token.instrument.admin));
    requireFactory(token.settlementFactory, await this.registry.inlineSettlement(token.instrument.admin));
  }

  /** The pool contract at an offset. */
  async poolEvent(poolId: string, offset: bigint): Promise<CreatedEvent> {
    const operator = await this.ledger.primaryParty();
    return single(
      (await this.contracts(operator, Pool, offset)).filter((event) => event.contractId === poolId),
      'Pool',
    );
  }

  /** The trader's active pool access, backed by a current KYC attestation that covers the pool. */
  async access(trader: string, poolEvent: CreatedEvent, offset: bigint): Promise<CreatedEvent> {
    const operator = pool(poolEvent.createArgument).venueOperator;
    const candidates = (await this.contracts(operator, PoolAccess, offset)).filter((event) => {
      const grant = access(event.createArgument);
      return grant.trader === trader && grant.poolCid === poolEvent.contractId && grant.venueOperator === operator;
    });
    const attestations = await this.contracts(operator, KycAttestation, offset);
    const valid = candidates.find((event) => {
      const grant = access(event.createArgument);
      return attestations.some((candidate) => {
        if (candidate.contractId !== grant.attestationCid) return false;
        const kyc = attestation(candidate.createArgument);
        return kyc.trader === trader && kyc.venueOperator === operator && kyc.pools.includes(poolEvent.contractId);
      });
    });
    if (!valid) throw new Conflict('Current KYC and access to this pool are required', 'POOL_ACCESS_REQUIRED');
    return valid;
  }

  /** The trader's input holdings, read with the trader's own token. */
  async inputs(
    trader: string,
    instrument: Instrument,
    amount: bigint,
    offset: bigint,
    accessToken: string,
  ): Promise<string[]> {
    const candidates = await this.ledger
      .forCaller(accessToken)
      .activeInterfaceContracts(trader, HoldingInterface, offset);
    return selectInputs(candidates, trader, instrument, amount);
  }

  /** The token disclosures plus the pool contract itself. */
  async poolDisclosure(
    poolEvent: CreatedEvent,
    tokenDisclosures: readonly DisclosedContract[],
  ): Promise<DisclosedContract[]> {
    const synchronizer = await this.ledger.singleSynchronizer();
    return mergeDisclosures([...tokenDisclosures, disclosure(poolEvent, synchronizer)]);
  }

  /** The token disclosures plus the pool's reserve holdings, which settlement spends. */
  async settlementDisclosures(
    snapshot: PoolSnapshot,
    tokenDisclosures: readonly DisclosedContract[],
  ): Promise<DisclosedContract[]> {
    const synchronizer = await this.ledger.singleSynchronizer();
    const reserves = new Set([...snapshot.state.baseHoldingCids, ...snapshot.state.quoteHoldingCids]);
    const holdings = await this.ledger.activeInterfaceContracts(snapshot.pool.dvo, HoldingInterface, snapshot.offset);
    return mergeDisclosures([
      ...tokenDisclosures,
      ...holdings.filter((event) => reserves.has(event.contractId)).map((event) => disclosure(event, synchronizer)),
    ]);
  }

  /** Active contracts of the current DEX package. */
  private async contracts(party: string, template: DamlName, offset: bigint): Promise<CreatedEvent[]> {
    return (await this.ledger.activeContracts(party, template, offset)).filter(
      (event) => packageOf(event.templateId) === DEX_PACKAGE_ID,
    );
  }
}
