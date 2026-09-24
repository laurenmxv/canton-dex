import { pairKey, type Terms } from '../pools/model.js';
import type { Instrument } from '../tokens/model.js';
import { poolTerms } from './pools.js';
import { divideFloor, numericText, numericUnits, sameNumeric } from '../platform/decimal.js';
import { ledgerTime } from '../platform/time.js';
import { nameUuid } from '../platform/uuid.js';
import {
  account,
  encodePoolSettings,
  instrument,
  numeric,
  pool,
  poolConfig,
  poolSettings,
  poolState,
  sameAccount,
  testTokenAmounts,
  type DamlAccount,
  type TestTokenAmount,
  type Token,
} from './contracts.js';
import { boolean, optionalString, record, string, strings } from './decode.js';
import {
  create,
  created,
  EMPTY_EXTRA_ARGS,
  exercise,
  interfaceView,
  type CreatedEvent,
  type DisclosedContract,
  type Ledger,
} from './ledger.js';
import {
  AllocationInterface,
  DEX_PACKAGE_ID,
  FAUCET_PACKAGE_ID,
  KycAttestation,
  packageOf,
  Pool,
  PoolAccess,
  PoolConfig,
  PoolFactory,
  PoolProposal,
  PoolState,
  TestTokenFaucet,
  TestTokenGrant,
  TestTokenReceipt,
  TOKEN_PACKAGE_ID,
  TokenHolding,
  TokenRules,
  VenueDelegation,
  type DamlName,
} from './packages.js';

const CLAIM_AMOUNTS: readonly TestTokenAmount[] = [
  { instrumentId: 'USDC', amount: '10000' },
  { instrumentId: 'BTC', amount: '0.1' },
  { instrumentId: 'ETH', amount: '2' },
];
const DECIMALS: Readonly<Record<string, number>> = { USDC: 6, BTC: 8 };
const DEFAULT_DECIMALS = 10;
const LP_DECIMALS = 10;
const QUOTE = 'USDC';
const FEE_BPS = '30';
const RULES_MAX_TTL_MICROS = '3600000000';
const RULES_LOCK_GRACE_MICROS = '300000000';
const DEPOSIT_DEADLINE_SECONDS = 1_800;
const MAX_SEED_HOLDINGS = 16;
/** Packages of the current contract generation; older versions are not reused. */
const CURRENT_PACKAGES = new Set([TOKEN_PACKAGE_ID, DEX_PACKAGE_ID, FAUCET_PACKAGE_ID]);

/** The durable records of the fixture. Every write is idempotent. */
export interface FixtureStore {
  savedConfiguration(): Promise<SavedConfiguration | undefined>;
  saveConfiguration(
    configuration: SavedConfiguration & { readonly rulesBlob: string; readonly synchronizerId: string },
  ): Promise<void>;
  saveRegistry(admin: string, rules: DisclosedContract): Promise<void>;
  saveInstrument(admin: string, instrumentId: string, symbol: string, decimals: number): Promise<void>;
  saveTestInstrument(symbol: string, decimals: number, initialClaimAmount: string): Promise<void>;
  storePool(
    poolId: string,
    configId: string,
    stateId: string,
    packageId: string,
    name: string,
    terms: Terms,
  ): Promise<void>;
  savePoolPair(pair: string, poolId: string): Promise<void>;
  delegationId(poolId: string): Promise<string | null>;
  saveDelegation(poolId: string, delegationId: string): Promise<void>;
  savePairClaim(pairKey: string, poolId: string): Promise<void>;
}

export interface SavedConfiguration {
  readonly issuerPartyId: string;
  readonly rulesId: string;
  readonly packageId: string;
  readonly faucetFactoryId: string;
}

/** Deterministic command ids make every fixture step safe to repeat. */
function command(action: string, key: string): string {
  return nameUuid(`canton-dex:${DEX_PACKAGE_ID}:${action}:${key}`);
}

function sameAmounts(left: readonly TestTokenAmount[], right: readonly TestTokenAmount[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return other !== undefined && item.instrumentId === other.instrumentId && sameNumeric(item.amount, other.amount);
    })
  );
}

function single(events: readonly CreatedEvent[], label: string): CreatedEvent {
  const [only] = events;
  if (events.length !== 1 || !only) throw new Error(`Expected one ${label}, found ${String(events.length)}`);
  return only;
}

interface AllocationSummary {
  readonly settlementId: string;
  readonly admin: string;
  readonly settlementDeadline: string | undefined;
  readonly fundedInstruments: readonly string[];
}

function allocation(event: CreatedEvent): AllocationSummary {
  const view = record(interfaceView(event, AllocationInterface), 'AllocationView');
  const specification = record(view.allocation, 'AllocationView.allocation');
  const funding = specification.nextIterationFunding;
  return {
    settlementId: string(record(view.settlement, 'AllocationView.settlement').id, 'settlement.id'),
    admin: string(specification.admin, 'allocation.admin'),
    settlementDeadline: optionalString(specification.settlementDeadline, 'allocation.settlementDeadline'),
    fundedInstruments:
      funding === null || funding === undefined ? [] : Object.keys(record(funding, 'nextIterationFunding')),
  };
}

/**
 * Local test instruments and one-time pool funding: the issuer's token registry and faucet, the
 * DVO's LP registry, and the funded BTC/USDC and ETH/USDC pools. A repeated run reuses every
 * contract and never replenishes reserves.
 */
export class TestTokenFixture {
  private rules: DisclosedContract | undefined;
  private lpRules: DisclosedContract | undefined;

  private constructor(
    private readonly store: FixtureStore,
    private readonly issuerLedger: Ledger,
    private readonly authority: Ledger,
    private readonly operatorLedger: Ledger,
    private readonly issuer: string,
    private readonly dvo: string,
    private readonly operator: string,
  ) {}

  static async create(
    store: FixtureStore,
    issuerLedger: Ledger,
    authority: Ledger,
    operatorLedger: Ledger,
  ): Promise<TestTokenFixture> {
    return new TestTokenFixture(
      store,
      issuerLedger,
      authority,
      operatorLedger,
      await issuerLedger.primaryParty(),
      await authority.primaryParty(),
      await operatorLedger.primaryParty(),
    );
  }

  async initialize(): Promise<void> {
    await this.registry();
    await this.lpRegistry();
    await this.pool('BTC', 8, '5', '300000');
    await this.pool('ETH', 10, '100', '300000');
  }

  private get rulesDisclosure(): DisclosedContract {
    if (!this.rules) throw new Error('The test-token registry is not initialized');
    return this.rules;
  }

  private get lpRulesDisclosure(): DisclosedContract {
    if (!this.lpRules) throw new Error('The LP token registry is not initialized');
    return this.lpRules;
  }

  /** Active contracts of the current packages that satisfy the predicate. */
  private async find(
    ledger: Ledger,
    party: string,
    template: DamlName,
    predicate: (payload: unknown) => boolean,
  ): Promise<CreatedEvent[]> {
    return (await ledger.activeContracts(party, template)).filter(
      (event) => CURRENT_PACKAGES.has(packageOf(event.templateId)) && predicate(event.createArgument),
    );
  }

  private async disclosure(ledger: Ledger, event: CreatedEvent): Promise<DisclosedContract> {
    if (event.createdEventBlob === '') throw new Error('Fixture disclosure is missing');
    return {
      contractId: event.contractId,
      templateId: event.templateId,
      createdEventBlob: event.createdEventBlob,
      synchronizerId: await ledger.singleSynchronizer(),
    };
  }

  private async rulesOf(ledger: Ledger, admin: string): Promise<CreatedEvent[]> {
    return this.find(ledger, admin, TokenRules, (payload) => record(payload, 'TokenRules').admin === admin);
  }

  private async createRules(ledger: Ledger, action: string, admin: string): Promise<CreatedEvent[]> {
    await ledger.submit(
      command(action, admin),
      admin,
      [],
      [
        create(TokenRules, {
          admin,
          maxTTL: { microseconds: RULES_MAX_TTL_MICROS },
          lockGrace: { microseconds: RULES_LOCK_GRACE_MICROS },
        }),
      ],
    );
    return this.rulesOf(ledger, admin);
  }

  private async registry(): Promise<void> {
    const saved = await this.store.savedConfiguration();
    const candidates = await this.rulesOf(this.issuerLedger, this.issuer);
    let rules: CreatedEvent;
    if (saved) {
      if (saved.issuerPartyId !== this.issuer || saved.packageId !== TOKEN_PACKAGE_ID) {
        throw new Error(
          'Test-token registry identity changed; recreate the local participant and application databases',
        );
      }
      const configured = candidates.find((event) => event.contractId === saved.rulesId);
      if (!configured) throw new Error('Configured test-token rules are inactive');
      rules = configured;
    } else if (candidates.length === 0) {
      rules = single(await this.createRules(this.issuerLedger, 'rules', this.issuer), 'test-token rules');
    } else {
      rules = single(candidates, 'test-token rules');
    }
    if (rules.createdEventBlob === '') throw new Error('Registry disclosure is missing');
    this.rules = await this.disclosure(this.issuerLedger, rules);
    const faucet = await this.faucet(saved, rules.contractId);
    await this.store.saveConfiguration({
      issuerPartyId: this.issuer,
      rulesId: rules.contractId,
      packageId: TOKEN_PACKAGE_ID,
      faucetFactoryId: faucet.contractId,
      rulesBlob: rules.createdEventBlob,
      synchronizerId: this.rulesDisclosure.synchronizerId,
    });
    await this.store.saveRegistry(this.issuer, this.rulesDisclosure);
    for (const token of CLAIM_AMOUNTS) {
      const decimals = DECIMALS[token.instrumentId] ?? DEFAULT_DECIMALS;
      await this.store.saveInstrument(this.issuer, token.instrumentId, token.instrumentId, decimals);
      await this.store.saveTestInstrument(token.instrumentId, decimals, token.amount);
    }
  }

  private async faucet(saved: SavedConfiguration | undefined, rulesId: string): Promise<CreatedEvent> {
    const matching = () =>
      this.find(this.issuerLedger, this.issuer, TestTokenFaucet, (payload) => {
        const fields = record(payload, 'TestTokenFaucet');
        return (
          fields.issuer === this.issuer &&
          fields.operator === this.operator &&
          fields.rulesCid === rulesId &&
          sameAmounts(testTokenAmounts(fields.amounts, 'TestTokenFaucet.amounts'), CLAIM_AMOUNTS)
        );
      });
    let faucets = await matching();
    if (saved) {
      const configured = faucets.find((event) => event.contractId === saved.faucetFactoryId);
      if (!configured) throw new Error('Configured test-token faucet is inactive');
      return configured;
    }
    if (faucets.length === 0) {
      await this.issuerLedger.submit(
        command('faucet', rulesId),
        this.issuer,
        [],
        [
          create(TestTokenFaucet, {
            issuer: this.issuer,
            operator: this.operator,
            rulesCid: rulesId,
            amounts: CLAIM_AMOUNTS,
          }),
        ],
      );
      faucets = await matching();
    }
    return single(faucets, 'test-token faucet');
  }

  private async lpRegistry(): Promise<void> {
    let matches = await this.rulesOf(this.authority, this.dvo);
    if (matches.length === 0) matches = await this.createRules(this.authority, 'lp-rules', this.dvo);
    this.lpRules = await this.disclosure(this.authority, single(matches, 'LP token rules'));
    await this.store.saveRegistry(this.dvo, this.lpRulesDisclosure);
  }

  private token(id: string, decimals: number): Token {
    return {
      instrument: { admin: this.issuer, id },
      allocationFactory: this.rulesDisclosure.contractId,
      settlementFactory: this.rulesDisclosure.contractId,
      decimals: BigInt(decimals),
    };
  }

  private async poolsWithLpToken(fixtureId: string, strict: boolean): Promise<CreatedEvent[]> {
    return this.find(this.authority, this.dvo, Pool, (payload) => {
      const value = pool(payload);
      const sameLp = value.lpToken.instrument.id === `lp:${fixtureId}`;
      return strict ? sameLp && value.dvo === this.dvo && value.venueOperator === this.operator : sameLp;
    });
  }

  private async pool(base: string, decimals: number, baseReserve: string, quoteReserve: string): Promise<void> {
    const pair = `${base}/${QUOTE}`;
    const fixtureId = command('fixture-pool', pair);
    const matches = await this.poolsWithLpToken(fixtureId, true);
    const poolEvent =
      matches.length === 0
        ? await this.createPool(fixtureId, base, decimals, baseReserve, quoteReserve)
        : single(matches, `fixture pool ${pair}`);
    const poolId = poolEvent.contractId;
    const value = pool(poolEvent.createArgument);
    const configEvent = single(
      await this.find(this.authority, this.dvo, PoolConfig, (payload) => poolConfig(payload).poolCid === poolId),
      'pool configuration',
    );
    let stateEvent = await this.state(poolId);
    await this.storePool(poolEvent, configEvent, stateEvent, pair);
    await this.store.savePoolPair(pair, poolId);
    const delegationId = await this.delegation(poolId);
    if (numericUnits(poolState(stateEvent.createArgument).lpTokenSupply) === 0n) {
      await this.seed(poolEvent, configEvent, stateEvent, delegationId, baseReserve, quoteReserve);
      stateEvent = await this.state(poolId);
    }
    const terms = await this.storePool(poolEvent, configEvent, stateEvent, pair);
    await this.store.savePairClaim(pairKey(terms.baseInstrumentId, terms.quoteInstrumentId), poolId);
    await this.store.saveInstrument(this.dvo, value.lpToken.instrument.id, `LP-${base}-${QUOTE}`, LP_DECIMALS);
  }

  private async createPool(
    fixtureId: string,
    base: string,
    decimals: number,
    baseReserve: string,
    quoteReserve: string,
  ): Promise<CreatedEvent> {
    const factory = await this.factory();
    let proposals = await this.find(this.authority, this.dvo, PoolProposal, (payload) => {
      const fields = record(payload, 'PoolProposal');
      return (
        !boolean(fields.accepted, 'PoolProposal.accepted') &&
        fields.factoryCid === factory.contractId &&
        poolSettings(fields.settings).poolId === fixtureId
      );
    });
    if (proposals.length === 0) {
      const settings = {
        dvo: this.dvo,
        poolId: fixtureId,
        baseToken: this.token(base, decimals),
        quoteToken: this.token(QUOTE, DECIMALS[QUOTE] ?? DEFAULT_DECIMALS),
        lpAllocationFactory: this.lpRulesDisclosure.contractId,
        lpSettlementFactory: this.lpRulesDisclosure.contractId,
        feeBps: FEE_BPS,
      };
      const proposed = await this.operatorLedger.submit(
        command('propose', fixtureId),
        this.operator,
        [],
        [
          exercise(PoolFactory, factory.contractId, 'PoolFactory_ProposePool', {
            settings: encodePoolSettings(settings),
          }),
        ],
      );
      proposals = [created(proposed, PoolProposal)];
    }
    const initialRatio = numericText(divideFloor(numericUnits(quoteReserve), numericUnits(baseReserve)));
    const accepted = await this.authority.submit(
      command('accept', fixtureId),
      this.dvo,
      [],
      [
        exercise(PoolProposal, single(proposals, 'fixture proposal').contractId, 'PoolProposal_Accept', {
          initialRatio,
        }),
      ],
      [this.rulesDisclosure, this.lpRulesDisclosure],
    );
    const createdPoolId = created(accepted, Pool).contractId;
    const poolEvent = single(await this.poolsWithLpToken(fixtureId, false), 'created fixture pool');
    if (poolEvent.contractId !== createdPoolId) throw new Error('Fixture pool identity differs');
    return poolEvent;
  }

  private async storePool(
    poolEvent: CreatedEvent,
    configEvent: CreatedEvent,
    stateEvent: CreatedEvent,
    pair: string,
  ): Promise<Terms> {
    const terms = poolTerms(
      pool(poolEvent.createArgument),
      poolConfig(configEvent.createArgument),
      poolState(stateEvent.createArgument),
    );
    await this.store.storePool(
      poolEvent.contractId,
      configEvent.contractId,
      stateEvent.contractId,
      packageOf(poolEvent.templateId),
      `${pair} test pool`,
      terms,
    );
    return terms;
  }

  private async seed(
    poolEvent: CreatedEvent,
    configEvent: CreatedEvent,
    stateEvent: CreatedEvent,
    delegationId: string,
    baseAmount: string,
    quoteAmount: string,
  ): Promise<void> {
    const poolId = poolEvent.contractId;
    const value = pool(poolEvent.createArgument);
    const config = poolConfig(configEvent.createArgument);
    const access = await this.seedAccess(poolId);
    const requestId = command('initial-liquidity', poolId);
    const deposits = async () =>
      (await this.issuerLedger.activeInterfaceContracts(this.issuer, AllocationInterface)).filter((event) =>
        allocation(event).settlementId.startsWith(`deposit:${requestId}:`),
      );
    let allocations = await deposits();
    let deadline: string;
    if (allocations.length === 0) {
      const funding = { owner: this.issuer, provider: null, id: '' };
      await this.claim(`pool:${poolId}:base`, funding, [
        { instrumentId: value.baseToken.instrument.id, amount: baseAmount },
      ]);
      await this.claim(`pool:${poolId}:quote`, funding, [
        { instrumentId: value.quoteToken.instrument.id, amount: quoteAmount },
      ]);
      deadline = ledgerTime(Date.now() + DEPOSIT_DEADLINE_SECONDS * 1_000);
      await this.issuerLedger.submit(
        command('deposit', requestId),
        this.issuer,
        [],
        [
          exercise(PoolAccess, access.contractId, 'PoolAccess_RequestLiquidityDeposit', {
            terms: this.seedTerms(requestId, baseAmount, quoteAmount, config.initialRatio, deadline),
            requestedAt: ledgerTime(Date.now() - 1_000),
            baseHoldingCids: await this.seedHoldings(value.baseToken.instrument, baseAmount),
            quoteHoldingCids: await this.seedHoldings(value.quoteToken.instrument, quoteAmount),
            baseAllocationArgs: EMPTY_EXTRA_ARGS,
            quoteAllocationArgs: EMPTY_EXTRA_ARGS,
            lpAllocationArgs: EMPTY_EXTRA_ARGS,
          }),
        ],
        [this.rulesDisclosure, this.lpRulesDisclosure, await this.disclosure(this.authority, poolEvent)],
      );
      allocations = await deposits();
    } else {
      const first = allocations[0];
      const stored = first === undefined ? undefined : allocation(first).settlementDeadline;
      if (stored === undefined) throw new Error('Initial liquidity allocation has no deadline');
      deadline = stored;
    }
    if (allocations.length !== 3 || Date.now() >= Date.parse(deadline)) {
      throw new Error(`Initial liquidity requires three live allocations: ${poolId}`);
    }
    const request = {
      poolCid: poolId,
      trader: this.issuer,
      terms: this.seedTerms(requestId, baseAmount, quoteAmount, config.initialRatio, deadline),
      baseAllocation: this.seedAllocation(allocations, value.baseToken.instrument),
      quoteAllocation: this.seedAllocation(allocations, value.quoteToken.instrument),
      lpAllocation: single(
        allocations.filter((event) => allocation(event).admin === this.dvo),
        'LP receipt allocation',
      ).contractId,
    };
    await this.operatorLedger.submit(
      command('settle-initial-liquidity', requestId),
      this.operator,
      [],
      [
        exercise(VenueDelegation, delegationId, 'VenueDelegation_AddLiquidity', {
          configCid: configEvent.contractId,
          stateCid: stateEvent.contractId,
          requests: [
            {
              accessCid: access.contractId,
              request: {
                request,
                tokenArgs: {
                  baseAllocationArgs: EMPTY_EXTRA_ARGS,
                  quoteAllocationArgs: EMPTY_EXTRA_ARGS,
                  lpAllocationArgs: EMPTY_EXTRA_ARGS,
                  baseSettlementArgs: EMPTY_EXTRA_ARGS,
                  quoteSettlementArgs: EMPTY_EXTRA_ARGS,
                  lpSettlementArgs: EMPTY_EXTRA_ARGS,
                },
              },
            },
          ],
        }),
      ],
      [this.rulesDisclosure, this.lpRulesDisclosure],
    );
  }

  private seedTerms(requestId: string, base: string, quote: string, ratio: string, deadline: string) {
    return {
      requestId,
      mode: 'InitializeOnly',
      maxBaseAmount: base,
      maxQuoteAmount: quote,
      minLpOut: '0',
      minRatio: ratio,
      maxRatio: ratio,
      settlementDeadline: deadline,
    };
  }

  private seedAllocation(allocations: readonly CreatedEvent[], token: Instrument): string {
    return single(
      allocations.filter((event) => {
        const summary = allocation(event);
        return summary.admin === token.admin && summary.fundedInstruments.includes(token.id);
      }),
      `${token.id} funding allocation`,
    ).contractId;
  }

  private async seedAccess(poolId: string): Promise<CreatedEvent> {
    let attestations = await this.find(this.operatorLedger, this.operator, KycAttestation, (payload) => {
      const fields = record(payload, 'KycAttestation');
      const pools = strings(fields.pools, 'KycAttestation.pools');
      return (
        fields.venueOperator === this.operator &&
        fields.trader === this.issuer &&
        pools.length === 1 &&
        pools[0] === poolId
      );
    });
    if (attestations.length === 0) {
      const tx = await this.operatorLedger.submit(
        command('seed-kyc', poolId),
        this.operator,
        [],
        [create(KycAttestation, { venueOperator: this.operator, trader: this.issuer, pools: [poolId] })],
      );
      attestations = [created(tx, KycAttestation)];
    }
    const attestationId = single(attestations, 'initial LP attestation').contractId;
    const accesses = await this.find(this.operatorLedger, this.operator, PoolAccess, (payload) => {
      const fields = record(payload, 'PoolAccess');
      return (
        fields.venueOperator === this.operator &&
        fields.trader === this.issuer &&
        fields.poolCid === poolId &&
        fields.attestationCid === attestationId
      );
    });
    if (accesses.length > 0) return single(accesses, 'initial LP access');
    const tx = await this.operatorLedger.submit(
      command('seed-access', poolId),
      this.operator,
      [],
      [
        create(PoolAccess, {
          venueOperator: this.operator,
          trader: this.issuer,
          poolCid: poolId,
          attestationCid: attestationId,
        }),
      ],
    );
    return created(tx, PoolAccess);
  }

  private async seedHoldings(token: Instrument, amount: string): Promise<string[]> {
    const funding: DamlAccount = { owner: this.issuer, provider: null, id: '' };
    const holdings = await this.find(this.issuerLedger, this.issuer, TokenHolding, (payload) => {
      const holding = record(record(payload, 'TokenHolding').holding, 'TokenHolding.holding');
      const held = instrument(holding.instrumentId, 'holding.instrumentId');
      return (
        held.admin === token.admin &&
        held.id === token.id &&
        sameAccount(account(holding.account, 'holding.account'), funding) &&
        (holding.lock === null || holding.lock === undefined)
      );
    });
    const selected: string[] = [];
    let total = 0n;
    const required = numericUnits(amount);
    for (const event of holdings) {
      selected.push(event.contractId);
      const holding = record(record(event.createArgument, 'TokenHolding').holding, 'TokenHolding.holding');
      total += numericUnits(numeric(holding.amount, 'holding.amount'));
      if (total >= required) return selected;
      if (selected.length === MAX_SEED_HOLDINGS) break;
    }
    throw new Error(`Initial LP has insufficient available holdings for ${token.id}`);
  }

  private async factory(): Promise<CreatedEvent> {
    const factories = await this.find(this.authority, this.dvo, PoolFactory, (payload) => {
      const fields = record(payload, 'PoolFactory');
      return fields.dvo === this.dvo && fields.venueOperator === this.operator;
    });
    const [first, ...others] = factories;
    if (first === undefined) {
      const tx = await this.authority.submit(
        command('factory', this.dvo),
        this.dvo,
        [],
        [create(PoolFactory, { dvo: this.dvo, venueOperator: this.operator })],
      );
      return created(tx, PoolFactory);
    }
    return others.reduce((lowest, event) => (event.contractId < lowest.contractId ? event : lowest), first);
  }

  private async state(poolId: string): Promise<CreatedEvent> {
    return single(
      await this.find(this.authority, this.dvo, PoolState, (payload) => poolState(payload).poolCid === poolId),
      'pool state',
    );
  }

  private matchesGrant(
    payload: unknown,
    template: string,
    funding: DamlAccount,
    amounts: readonly TestTokenAmount[],
  ): boolean {
    const fields = record(payload, template);
    return (
      fields.issuer === this.issuer &&
      fields.recipient === this.issuer &&
      sameAccount(account(fields.account, `${template}.account`), funding) &&
      fields.rulesCid === this.rulesDisclosure.contractId &&
      sameAmounts(testTokenAmounts(fields.amounts, `${template}.amounts`), amounts)
    );
  }

  private async claim(grantId: string, funding: DamlAccount, amounts: readonly TestTokenAmount[]): Promise<void> {
    const byGrant = (template: string) => (payload: unknown) => record(payload, template).grantId === grantId;
    const receipts = await this.find(this.issuerLedger, this.issuer, TestTokenReceipt, byGrant('TestTokenReceipt'));
    if (receipts.length > 0) {
      if (
        !this.matchesGrant(single(receipts, 'funding receipt').createArgument, 'TestTokenReceipt', funding, amounts)
      ) {
        throw new Error('Pool funding receipt differs');
      }
      return;
    }
    let grants = await this.find(this.issuerLedger, this.issuer, TestTokenGrant, byGrant('TestTokenGrant'));
    if (grants.length === 0) {
      const tx = await this.issuerLedger.submit(
        command('grant', grantId),
        this.issuer,
        [],
        [
          create(TestTokenGrant, {
            issuer: this.issuer,
            operator: this.operator,
            grantId,
            rulesCid: this.rulesDisclosure.contractId,
            recipient: this.issuer,
            account: funding,
            amounts,
          }),
        ],
      );
      grants = [created(tx, TestTokenGrant)];
    }
    const grant = single(grants, 'pool funding grant');
    if (!this.matchesGrant(grant.createArgument, 'TestTokenGrant', funding, amounts))
      throw new Error('Pool funding grant differs');
    const claimed = await this.issuerLedger.submit(
      command('claim', grantId),
      this.issuer,
      [],
      [exercise(TestTokenGrant, grant.contractId, 'TestTokenGrant_Claim', {})],
      [this.rulesDisclosure],
    );
    created(claimed, TestTokenReceipt);
  }

  private async delegation(poolId: string): Promise<string> {
    const stored = await this.store.delegationId(poolId);
    if (stored !== null) return stored;
    let delegates = await this.find(this.authority, this.dvo, VenueDelegation, (payload) => {
      const fields = record(payload, 'VenueDelegation');
      return fields.poolCid === poolId && fields.dvo === this.dvo && fields.venueOperator === this.operator;
    });
    if (delegates.length === 0) {
      const tx = await this.authority.submit(
        command('delegate', poolId),
        this.dvo,
        [],
        [create(VenueDelegation, { dvo: this.dvo, venueOperator: this.operator, poolCid: poolId })],
      );
      delegates = [created(tx, VenueDelegation)];
    }
    const delegationId = single(delegates, 'venue delegation').contractId;
    await this.store.saveDelegation(poolId, delegationId);
    return delegationId;
  }
}
