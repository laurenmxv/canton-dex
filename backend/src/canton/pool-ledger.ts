import {
  proposalOf,
  sameProposalTerms,
  type LedgerPool,
  type PendingProposal,
  type Proposal,
  type ProposalTerms,
} from '../pools/model.js';
import { PoolRejected, type PoolConfirmation, type PoolLedger } from '../pools/ports.js';
import { Unavailable } from '../platform/errors.js';
import type { Instrument, RegisteredInstrument } from '../tokens/model.js';
import type { TokenSource } from '../tokens/registry-store.js';
import {
  encodePoolSettings,
  pool,
  poolConfig,
  poolFactory,
  poolProposal,
  poolState,
  venueDelegation,
  type PoolSettings,
  type Token,
} from './contracts.js';
import { record, string } from './decode.js';
import { definitelyRejected } from './http.js';
import {
  create,
  createdEvents,
  exercise,
  exercisedEvents,
  type CreatedEvent,
  type DisclosedContract,
  type ExercisedEvent,
  type Ledger,
  type Transaction,
} from './ledger.js';
import {
  DEX_PACKAGE_ID,
  isExactly,
  packageOf,
  Pool,
  PoolConfig,
  PoolFactory,
  PoolProposal,
  PoolState,
  VenueDelegation,
  type DamlName,
} from './packages.js';
import { poolTerms } from './pools.js';
import { mergeDisclosures, type CantonTokenRegistry } from './token-registry.js';

const ACCEPT = 'PoolProposal_Accept';
const REJECT = 'PoolProposal_Reject';
const WITHDRAW = 'PoolProposal_Withdraw';
const DECISIONS = new Set([ACCEPT, REJECT, WITHDRAW]);
const CREATE_POOL = 'PoolFactory_CreatePool';
const ARCHIVE = 'Archive';
const LP_DECIMALS = 10;

/** The registry facts that pool commands encode, and the runtime LP instrument registration. */
export interface PoolRegistry {
  source(admin: string): Promise<TokenSource | undefined>;
  instruments(): Promise<readonly RegisteredInstrument[]>;
  registerInstrument(admin: string, id: string, symbol: string, decimals: number): Promise<void>;
}

/** Submits a pool command with a fresh command id; only a definite answer becomes PoolRejected. */
export async function submitPoolCommand(submission: () => Promise<Transaction>): Promise<Transaction> {
  try {
    return await submission();
  } catch (error) {
    if (definitelyRejected(error)) throw new PoolRejected(error);
    throw error;
  }
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const expected = new Set(right);
  return new Set(left).size === expected.size && left.every((value) => expected.has(value));
}

/** The one created contract of the exact DEX template. */
function exact(events: readonly CreatedEvent[], template: DamlName): CreatedEvent {
  const found = events.filter((event) => isExactly(event.templateId, template));
  const [only] = found;
  if (found.length !== 1 || !only) throw new Error('Unexpected pool transaction templates');
  return only;
}

function proposalTermsOf(settings: PoolSettings): ProposalTerms {
  return {
    dvo: settings.dvo,
    baseInstrumentId: settings.baseToken.instrument,
    quoteInstrumentId: settings.quoteToken.instrument,
    feeBps: settings.feeBps,
  };
}

/** A pool from its three current contracts, as the catalog stores it. */
function ledgerPool(
  poolEvent: CreatedEvent,
  configEvent: CreatedEvent,
  stateEvent: CreatedEvent,
  name: string,
): LedgerPool {
  const config = poolConfig(configEvent.createArgument);
  const state = poolState(stateEvent.createArgument);
  if (config.poolCid !== poolEvent.contractId || state.poolCid !== poolEvent.contractId) {
    throw new Error('Pool component references differ');
  }
  return {
    poolId: poolEvent.contractId,
    name,
    settings: poolTerms(pool(poolEvent.createArgument), config, state),
    configId: configEvent.contractId,
    stateId: stateEvent.contractId,
    packageId: packageOf(poolEvent.templateId),
    createdAt: poolEvent.createdAt,
  };
}

function createPoolArgument(argument: unknown): string {
  return string(record(argument, CREATE_POOL).proposalCid, `${CREATE_POOL}.proposalCid`);
}

/**
 * The pool an acceptance created. The transaction must create the accepted approval for these
 * settings, the pool with its config and state under DVO authority, the factory call that used
 * the approval, and the approval's consumption.
 */
export function acceptedPool(
  tx: Transaction,
  proposalId: string,
  settings: ProposalTerms,
  factoryId: string,
  name: string,
  operator: string,
): LedgerPool {
  const events = createdEvents(tx);
  const approvalEvent = exact(events, PoolProposal);
  const approval = poolProposal(approvalEvent.createArgument);
  if (
    !approval.accepted ||
    approval.settings.poolId !== proposalId ||
    approval.factoryCid !== factoryId ||
    approval.venueOperator !== operator ||
    !sameProposalTerms(proposalTermsOf(approval.settings), settings) ||
    !sameSet(approvalEvent.signatories, [operator, settings.dvo])
  ) {
    throw new Error('Approved pool proposal differs from submitted settings');
  }
  const poolEvent = exact(events, Pool);
  const configEvent = exact(events, PoolConfig);
  const stateEvent = exact(events, PoolState);
  for (const event of [poolEvent, configEvent, stateEvent]) {
    if (!sameList(event.signatories, [settings.dvo]) || !event.observers.includes(operator)) {
      throw new Error('Pool authority differs');
    }
  }
  const result = ledgerPool(poolEvent, configEvent, stateEvent, name);
  if (!sameProposalTerms(proposalOf(result.settings), settings)) throw new Error('Created pool settings differ');
  const exercised = exercisedEvents(tx);
  const factoryCall = exercised.some(
    (event) =>
      event.contractId === factoryId &&
      isExactly(event.templateId, PoolFactory) &&
      event.choice === CREATE_POOL &&
      !event.consuming &&
      sameSet(event.actingParties, [settings.dvo, operator]) &&
      createPoolArgument(event.choiceArgument) === approvalEvent.contractId,
  );
  if (!factoryCall) throw new Error('Matching factory call is missing');
  const approvalConsumed = exercised.some(
    (event) =>
      event.contractId === approvalEvent.contractId &&
      isExactly(event.templateId, PoolProposal) &&
      event.choice === ARCHIVE &&
      event.consuming &&
      sameSet(event.actingParties, [settings.dvo, operator]),
  );
  if (!approvalConsumed) throw new Error('Pool approval was not consumed');
  return result;
}

/** The disclosures of every issuer factory that a proposal's acceptance validates. */
async function proposalDisclosures(terms: ProposalTerms, registry: CantonTokenRegistry): Promise<DisclosedContract[]> {
  const disclosures: DisclosedContract[] = [];
  for (const issuer of new Set([terms.baseInstrumentId.admin, terms.quoteInstrumentId.admin, terms.dvo])) {
    disclosures.push(...(await registry.inlineAllocation(issuer)).disclosures);
    disclosures.push(...(await registry.inlineSettlement(issuer)).disclosures);
  }
  return mergeDisclosures(disclosures);
}

/** The DVO's pool delegation to the operator, created once when an acceptance left none. */
async function ensureDelegation(
  ledger: Ledger,
  poolId: string,
  dvo: string,
  operator: string,
  proposalId: string,
): Promise<void> {
  const poolEvent = (await ledger.activeContracts(dvo, Pool)).find(
    (event) => event.contractId === poolId && isExactly(event.templateId, Pool),
  );
  if (!poolEvent) throw new Error('Approved pool is not active');
  const value = pool(poolEvent.createArgument);
  if (value.dvo !== dvo || value.venueOperator !== operator) {
    throw new Error('Pool authority differs from its approval');
  }
  const delegations = (await ledger.activeContracts(dvo, VenueDelegation))
    .filter((event) => isExactly(event.templateId, VenueDelegation))
    .map((event) => venueDelegation(event.createArgument))
    .filter((delegation) => delegation.poolCid === poolId);
  if (
    delegations.length > 1 ||
    delegations.some((delegation) => delegation.dvo !== dvo || delegation.venueOperator !== operator)
  ) {
    throw new Error('Approved pool has conflicting settlement delegations');
  }
  if (delegations.length === 0) {
    await ledger.submit(
      `pool-delegation-${proposalId}`,
      dvo,
      [],
      [create(VenueDelegation, { dvo, venueOperator: operator, poolCid: poolId })],
    );
  }
}

/** The DVO's answer to a pending proposal. */
export type Decision = { readonly accept: true; readonly initialRatio: string } | { readonly accept: false };

/**
 * The DVO's decision on a stored proposal, with the DVO's own ledger identity. An acceptance
 * that already happened is found in history and only repairs a missing delegation; it never
 * creates a second pool. Returns the decision's update id.
 */
export async function decideProposal(
  ledger: Ledger,
  registry: CantonTokenRegistry,
  stored: Proposal,
  decision: Decision,
): Promise<string> {
  const { proposalCid, factoryId, settings: expected, proposalId } = stored;
  const party = await ledger.primaryParty();
  if (expected.dvo !== party) throw new Error('Pool authority differs from the approver');
  const active = (await ledger.activeContracts(party, PoolProposal)).find((event) => event.contractId === proposalCid);
  let tx: Transaction;
  if (active) {
    if (!isExactly(active.templateId, PoolProposal)) throw new Error('Proposal package mismatch');
    const proposal = poolProposal(active.createArgument);
    if (
      proposal.accepted ||
      proposal.settings.poolId !== proposalId ||
      proposal.settings.dvo !== party ||
      proposal.factoryCid !== factoryId ||
      !sameProposalTerms(proposalTermsOf(proposal.settings), expected)
    ) {
      throw new Error('Stored and ledger proposal differ');
    }
    tx = decision.accept
      ? await ledger.submit(
          `pool-accept-${proposalId}`,
          party,
          [],
          [exercise(PoolProposal, active.contractId, ACCEPT, { initialRatio: decision.initialRatio })],
          await proposalDisclosures(expected, registry),
        )
      : await ledger.submit(
          `pool-reject-${proposalId}`,
          party,
          [],
          [exercise(PoolProposal, active.contractId, REJECT, {})],
        );
  } else {
    if (!decision.accept) throw new Error('Proposal is no longer active; wait for reconciliation');
    const accepted = (await ledger.transactions(0n, party)).find((candidate) =>
      exercisedEvents(candidate).some(
        (event) =>
          event.contractId === proposalCid &&
          isExactly(event.templateId, PoolProposal) &&
          event.choice === ACCEPT &&
          event.consuming &&
          sameList(event.actingParties, [party]),
      ),
    );
    if (!accepted) throw new Error('Proposal acceptance is not confirmed');
    tx = accepted;
  }
  if (decision.accept) {
    const factoryEvent = (await ledger.activeContracts(party, PoolFactory)).find(
      (event) => event.contractId === factoryId && isExactly(event.templateId, PoolFactory),
    );
    if (!factoryEvent) throw new Error('Pool factory is unavailable');
    const factory = poolFactory(factoryEvent.createArgument);
    if (factory.dvo !== party) throw new Error('Pool factory authority differs');
    const created = acceptedPool(tx, proposalId, expected, factoryId, 'Pool', factory.venueOperator);
    await ensureDelegation(ledger, created.poolId, party, factory.venueOperator, proposalId);
  }
  return tx.updateId;
}

/** The operator's pool factory, proposals and pools, with runtime LP instrument registration. */
export class CantonPoolLedger implements PoolLedger {
  readonly packageId = DEX_PACKAGE_ID;

  constructor(
    private readonly ledger: Ledger,
    private readonly registry: PoolRegistry,
    private readonly tokenRegistry: CantonTokenRegistry,
  ) {}

  operator(): Promise<string> {
    return this.ledger.primaryParty();
  }

  offset(): Promise<bigint> {
    return this.ledger.ledgerEnd();
  }

  /** The lowest contract id of the DVO's factories for this operator. */
  async factory(dvo: string): Promise<string> {
    const operator = await this.operator();
    const [first] = (await this.ledger.activeContracts(operator, PoolFactory))
      .filter((event) => isExactly(event.templateId, PoolFactory))
      .filter((event) => {
        const factory = poolFactory(event.createArgument);
        return factory.dvo === dvo && factory.venueOperator === operator;
      })
      .map((event) => event.contractId)
      .sort();
    if (first === undefined) throw new Unavailable('No compatible pool factory is available');
    return first;
  }

  async propose(proposal: Proposal, commandId: string): Promise<PoolConfirmation> {
    const settings = await this.encode(proposal.settings, proposal.proposalId);
    const disclosures = await proposalDisclosures(proposal.settings, this.tokenRegistry);
    const operator = await this.operator();
    const tx = await submitPoolCommand(() =>
      this.ledger.submit(
        commandId,
        operator,
        [],
        [
          exercise(PoolFactory, proposal.factoryId, 'PoolFactory_ProposePool', {
            settings: encodePoolSettings(settings),
          }),
        ],
        disclosures,
      ),
    );
    const proposalCid = await this.proposed(tx, { proposal, commandId, beginOffset: 0n });
    if (proposalCid === undefined) throw new Error('Proposal not confirmed');
    return { proposalCid, status: 'PENDING', updateId: tx.updateId, pool: null };
  }

  async withdraw(proposal: Proposal, commandId: string): Promise<PoolConfirmation> {
    const { proposalCid } = proposal;
    if (proposalCid === null) throw new Error('A proposal without a contract cannot be withdrawn');
    const operator = await this.operator();
    const tx = await submitPoolCommand(() =>
      this.ledger.submit(commandId, operator, [], [exercise(PoolProposal, proposalCid, WITHDRAW, {})]),
    );
    const confirmed = await this.confirmation(tx, proposal);
    if (!confirmed) throw new Error('Withdrawal not confirmed');
    return confirmed;
  }

  /** The proposal's creation, found by command id, and then its decision, from ledger history. */
  async recover(pending: PendingProposal): Promise<PoolConfirmation[]> {
    const result: PoolConfirmation[] = [];
    let proposal = pending.proposal;
    for (const tx of await this.ledger.transactions(pending.beginOffset, await this.operator())) {
      if (proposal.proposalCid === null) {
        const proposalCid = await this.proposed(tx, pending);
        if (proposalCid !== undefined) {
          result.push({ proposalCid, status: 'PENDING', updateId: tx.updateId, pool: null });
          proposal = { ...proposal, status: 'PENDING', proposalCid, poolId: null, updateId: tx.updateId, error: null };
        }
      } else {
        const confirmed = await this.confirmation(tx, proposal);
        if (confirmed) {
          result.push(confirmed);
          break;
        }
      }
    }
    return result;
  }

  /** The DVO's current pools, read at one ledger offset, and their LP instrument registrations. */
  async pools(names: ReadonlyMap<string, string>, dvo: string): Promise<LedgerPool[]> {
    const operator = await this.operator();
    const offset = await this.ledger.ledgerEnd();
    const current = async (template: DamlName) =>
      (await this.ledger.activeContracts(operator, template, offset)).filter((event) =>
        isExactly(event.templateId, template),
      );
    const configs = (await current(PoolConfig)).map((event) => ({
      event,
      poolCid: poolConfig(event.createArgument).poolCid,
    }));
    const states = (await current(PoolState)).map((event) => ({
      event,
      poolCid: poolState(event.createArgument).poolCid,
    }));
    const result: LedgerPool[] = [];
    for (const event of await current(Pool)) {
      const value = pool(event.createArgument);
      if (value.dvo !== dvo || value.venueOperator !== operator) continue;
      const [config, ...otherConfigs] = configs.filter((candidate) => candidate.poolCid === event.contractId);
      const [state, ...otherStates] = states.filter((candidate) => candidate.poolCid === event.contractId);
      if (!config || !state || otherConfigs.length > 0 || otherStates.length > 0) {
        throw new Error('Pool does not have one current config and state');
      }
      const name =
        names.get(event.contractId) ?? `${value.baseToken.instrument.id} / ${value.quoteToken.instrument.id}`;
      result.push(ledgerPool(event, config.event, state.event, name));
    }
    for (const detail of result) await this.registerLpInstrument(detail);
    return result;
  }

  private async registerLpInstrument(detail: LedgerPool): Promise<void> {
    const lp = detail.settings.lpTokenInstrumentId;
    await this.registry.registerInstrument(lp.admin, lp.id, `LP ${detail.name}`, LP_DECIMALS);
  }

  /** The ledger settings of a proposal, with each issuer's configured factories. */
  private async encode(terms: ProposalTerms, proposalId: string): Promise<PoolSettings> {
    const lp = await this.registry.source(terms.dvo);
    if (!lp) throw new Error('LP issuer registry is unavailable');
    return {
      dvo: terms.dvo,
      poolId: proposalId,
      baseToken: await this.token(terms.baseInstrumentId),
      quoteToken: await this.token(terms.quoteInstrumentId),
      lpAllocationFactory: lp.allocationFactoryId,
      lpSettlementFactory: lp.settlementFactoryId,
      feeBps: terms.feeBps,
    };
  }

  private async token(instrument: Instrument): Promise<Token> {
    const source = await this.registry.source(instrument.admin);
    if (!source) throw new Error('Token registry is unavailable');
    const registered = (await this.registry.instruments()).find(
      (candidate) => candidate.admin === instrument.admin && candidate.id === instrument.id,
    );
    if (!registered) throw new Error('Instrument is not registered');
    return {
      instrument: { admin: instrument.admin, id: instrument.id },
      allocationFactory: source.allocationFactoryId,
      settlementFactory: source.settlementFactoryId,
      decimals: BigInt(registered.decimals),
    };
  }

  /** The proposal that this command created, checked against the stored settings. */
  private async proposed(tx: Transaction, pending: PendingProposal): Promise<string | undefined> {
    if (tx.commandId !== pending.commandId) return undefined;
    const events = createdEvents(tx).filter((event) => isExactly(event.templateId, PoolProposal));
    const [event] = events;
    if (events.length !== 1 || !event) return undefined;
    const value = poolProposal(event.createArgument);
    const expected = pending.proposal;
    const operator = await this.operator();
    if (
      value.accepted ||
      value.settings.poolId !== expected.proposalId ||
      value.factoryCid !== expected.factoryId ||
      value.venueOperator !== operator ||
      !sameProposalTerms(proposalTermsOf(value.settings), expected.settings) ||
      !sameList(event.signatories, [operator]) ||
      !event.observers.includes(value.settings.dvo)
    ) {
      throw new Error('Proposal confirmation differs from submitted settings');
    }
    return event.contractId;
  }

  private decision(tx: Transaction, proposal: Proposal): ExercisedEvent | undefined {
    return exercisedEvents(tx).find(
      (event) =>
        event.contractId === proposal.proposalCid &&
        isExactly(event.templateId, PoolProposal) &&
        event.consuming &&
        DECISIONS.has(event.choice),
    );
  }

  private async confirmation(tx: Transaction, proposal: Proposal): Promise<PoolConfirmation | undefined> {
    const event = this.decision(tx, proposal);
    if (!event) return undefined;
    const operator = await this.operator();
    const actor = event.choice === WITHDRAW ? operator : proposal.settings.dvo;
    if (!sameList(event.actingParties, [actor])) throw new Error('Unexpected pool decision actor');
    const proposalCid = event.contractId;
    switch (event.choice) {
      case ACCEPT: {
        const created = acceptedPool(
          tx,
          proposal.proposalId,
          proposal.settings,
          proposal.factoryId,
          proposal.name,
          operator,
        );
        await this.registerLpInstrument(created);
        return { proposalCid, status: 'CREATED', updateId: tx.updateId, pool: created };
      }
      case REJECT:
        return { proposalCid, status: 'REJECTED', updateId: tx.updateId, pool: null };
      default:
        return { proposalCid, status: 'WITHDRAWN', updateId: tx.updateId, pool: null };
    }
  }
}
