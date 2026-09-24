import { accessStep, ATTESTATION_STEP } from '../lib/api/ledger-steps';
import { DomainError } from '../lib/api/types';
import type {
  DepositPreparation,
  DepositQuote,
  DepositRequest,
  LpPosition,
  Onboarding,
  PoolDetail,
  Profile,
  ProjectedPoolState,
  RequestType,
  Settlement,
  SettlementMonitoring,
  SettlementPolicy,
  SettlementPreview,
  SettlementPreviewStep,
  Swap,
  SwapPreparationRecord,
  SwapQuoteRecord,
  TokenBalances,
  WithdrawalPreparation,
  WithdrawalQuote,
  WithdrawalRequest,
} from '../lib/api/types';

/**
 * One funded pool as the local venue serves it, with the trader who has been
 * granted access to it. Amounts are the decimal strings the ledger stores.
 */
export const POOL_ID = '00pool00btcusdc';
export const TRADER_PARTY = 'sullivan::1220aa55cc';
export const FINGERPRINT = '1220aa55cc';

export const BTC = { admin: 'issuer::1220iss', id: 'BTC' };
export const USDC = { admin: 'issuer::1220iss', id: 'USDC' };

export const TRADER: Profile = {
  accountId: 'acc-trader-sullivan',
  displayName: 'Sullivan Capital',
  role: 'TRADER',
  partyId: TRADER_PARTY,
};

export const OPERATOR: Profile = {
  accountId: 'acc-operator',
  displayName: 'Venue Operations',
  role: 'OPERATOR',
  partyId: null,
};

export const POOL: PoolDetail = {
  poolId: POOL_ID,
  name: 'BTC / USDC',
  settings: {
    dvo: 'dvo::1220dvo',
    baseInstrumentId: BTC,
    quoteInstrumentId: USDC,
    baseAccount: { owner: 'dvo::1220dvo', provider: 'venue-operator::1220beef', id: 'btc-usdc-base' },
    quoteAccount: { owner: 'dvo::1220dvo', provider: 'venue-operator::1220beef', id: 'btc-usdc-quote' },
    lpTokenInstrumentId: { admin: 'dvo::1220dvo', id: 'LP-BTC-USDC' },
    feeBps: '30',
    baseReserve: '5.0000000000',
    quoteReserve: '300000.0000000000',
    lpTokenSupply: '1224.7448713916',
    initialRatio: '60000.0000000000',
  },
  configId: '00config0001',
  stateId: '00state0001',
  packageId: '1220package01',
  createdAt: '2026-09-19T08:00:00Z',
  updatedAt: '2026-09-19T08:00:00Z',
};

/** An onboarded trader whose party is registered and whose pool access is confirmed. */
export function onboarded(overrides: Partial<Onboarding> = {}): Onboarding {
  return {
    id: 'onb-0001',
    accountId: TRADER.accountId,
    application: {
      legalName: 'Sullivan Capital Partners LLC',
      countryCode: 'US',
      documents: [],
      documentReferences: [],
    },
    status: 'COMPLETED',
    partyMode: 'external',
    createdAt: '2026-09-19T07:00:00Z',
    review: {
      decision: 'APPROVED',
      approvedPoolIds: [POOL_ID],
      reviewedBy: 'operator',
      reviewedAt: '2026-09-19T07:30:00Z',
      partyHint: 'sullivan',
    },
    party: {
      preparationId: 'prep-party-0001',
      partyId: TRADER_PARTY,
      confirmed: true,
      publicKey: 'MCowBQYDK2VwAyEAdGVzdC1wdWJsaWMta2V5LWJ5dGVzLWZvci1maXh0dXJl',
      publicKeyFingerprint: FINGERPRINT,
      multiHash: '1220ffee01',
      synchronizerId: 'global-domain::1220abcd',
      status: 'CONFIRMED',
      participantId: 'venue-participant::1220a13',
      topologyTransactions: [],
    },
    ledgerSteps: [
      {
        key: ATTESTATION_STEP,
        commandId: 'cmd-0001',
        status: 'CONFIRMED',
        contractId: '00attest0001',
        updateId: '1220update01',
        issuer: 'venue-operator::1220beef',
      },
      {
        key: accessStep(POOL_ID),
        commandId: 'cmd-0002',
        status: 'CONFIRMED',
        contractId: '00access0001',
        updateId: '1220update02',
        issuer: 'venue-operator::1220beef',
      },
    ],
    suggestedPartyHint: 'sullivan',
    ...overrides,
  };
}

/** A trader whose attestation stands but whose pool access the ledger no longer confirms. */
export function withoutAccess(): Onboarding {
  return onboarded({
    ledgerSteps: onboarded().ledgerSteps.filter((step) => step.key === ATTESTATION_STEP),
  });
}

/** What the venue answers once the trader's KYC or pool access is not current. */
export const ACCESS_REFUSED = new DomainError(
  'Current KYC and access to this pool are required',
  'CONFLICT',
  'POOL_ACCESS_REQUIRED',
);

export const BALANCES: TokenBalances = {
  balances: [
    { instrument: BTC, symbol: 'BTC', decimals: 8, available: '0.1', locked: '0', total: '0.1' },
    {
      instrument: USDC,
      symbol: 'USDC',
      decimals: 6,
      available: '10000',
      locked: '0',
      total: '10000',
    },
  ],
  asOfOffset: 4821,
};

export const QUOTE: SwapQuoteRecord = {
  quoteId: 'quote-0001',
  poolId: POOL_ID,
  poolName: POOL.name,
  trader: TRADER_PARTY,
  direction: 'BaseToQuote',
  inputInstrument: BTC,
  outputInstrument: USDC,
  amountIn: '0.05',
  expectedOut: '2941.176470',
  feeAmount: '0.00015',
  minOut: '2926.470588',
  slippageBps: 50,
  stateId: '00state0001',
  quoteExpiresAt: '2099-01-01T00:00:30Z',
  settlementDeadline: '2099-01-01T00:10:00Z',
};

/** A 32-byte hash, base64, as the participant prepares one. */
export const PREPARED_HASH = 'zc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc0=';

export const PREPARATION: SwapPreparationRecord = {
  preparationId: 'prep-swap-0001',
  swapId: 'swap-0001',
  action: 'SUBMIT',
  terms: {
    poolId: POOL_ID,
    poolName: POOL.name,
    trader: TRADER_PARTY,
    direction: 'BaseToQuote',
    inputInstrument: BTC,
    outputInstrument: USDC,
    amountIn: QUOTE.amountIn,
    expectedOut: QUOTE.expectedOut,
    feeAmount: QUOTE.feeAmount,
    minOut: QUOTE.minOut,
    settlementDeadline: QUOTE.settlementDeadline,
  },
  preparedTransactionHash: PREPARED_HASH,
  hashEncoding: 'base64',
  hashingSchemeVersion: 3,
  partyId: TRADER_PARTY,
  publicKeyFingerprint: FINGERPRINT,
  expiresAt: '2099-01-01T00:00:45Z',
};

export function swap(overrides: Partial<Swap> = {}): Swap {
  return {
    swapId: 'swap-0001',
    quoteId: QUOTE.quoteId,
    poolId: POOL_ID,
    poolName: POOL.name,
    trader: TRADER_PARTY,
    direction: 'BaseToQuote',
    inputInstrument: BTC,
    outputInstrument: USDC,
    amountIn: QUOTE.amountIn,
    expectedOut: QUOTE.expectedOut,
    feeAmount: QUOTE.feeAmount,
    minOut: QUOTE.minOut,
    settlementDeadline: QUOTE.settlementDeadline,
    status: 'READY',
    arrivalSequence: 1,
    createdAt: '2026-09-19T12:00:10Z',
    submittedAt: '2026-09-19T12:00:12Z',
    updatedAt: '2026-09-19T12:00:15Z',
    settlementId: null,
    amountOut: null,
    allocationCids: ['00alloc0001', '00alloc0002'],
    updateId: '1220update20',
    errorCode: null,
    error: null,
    canWithdraw: false,
    ...overrides,
  };
}

export const LP = { admin: 'dvo::1220dvo', id: 'LP-BTC-USDC' };

/** The same pool before anyone deposits, at the ratio its dvo configured. */
export const EMPTY_POOL: PoolDetail = {
  ...POOL,
  settings: {
    ...POOL.settings,
    baseReserve: '0.0000000000',
    quoteReserve: '0.0000000000',
    lpTokenSupply: '0.0000000000',
  },
};

/** The first deposit: the whole offer at the configured ratio, less the locked minimum. */
export const DEPOSIT_QUOTE: DepositQuote = {
  quoteId: 'quote-deposit-0001',
  poolId: POOL_ID,
  poolName: POOL.name,
  trader: TRADER_PARTY,
  baseInstrument: BTC,
  quoteInstrument: USDC,
  lpInstrument: LP,
  mode: 'INITIAL',
  maxBaseAmount: '0.05',
  maxQuoteAmount: '3000',
  expectedBaseAmount: '0.05',
  expectedQuoteAmount: '3000',
  expectedBaseRefund: '0',
  expectedQuoteRefund: '0',
  expectedLpOut: '12.2474486745',
  minLpOut: '12.1862114311',
  minRatio: '59700',
  maxRatio: '60300',
  initialMinimumLp: '0.0000001',
  slippageBps: 50,
  stateId: '00state0001',
  quoteExpiresAt: '2099-01-01T00:00:30Z',
  settlementDeadline: '2099-01-01T00:10:00Z',
};

export const DEPOSIT_PREPARATION: DepositPreparation = {
  preparationId: 'prep-deposit-0001',
  requestId: 'deposit-0001',
  action: 'SUBMIT',
  terms: {
    poolId: POOL_ID,
    poolName: POOL.name,
    trader: TRADER_PARTY,
    baseInstrument: BTC,
    quoteInstrument: USDC,
    lpInstrument: LP,
    mode: DEPOSIT_QUOTE.mode,
    maxBaseAmount: DEPOSIT_QUOTE.maxBaseAmount,
    maxQuoteAmount: DEPOSIT_QUOTE.maxQuoteAmount,
    expectedBaseAmount: DEPOSIT_QUOTE.expectedBaseAmount,
    expectedQuoteAmount: DEPOSIT_QUOTE.expectedQuoteAmount,
    expectedBaseRefund: DEPOSIT_QUOTE.expectedBaseRefund,
    expectedQuoteRefund: DEPOSIT_QUOTE.expectedQuoteRefund,
    expectedLpOut: DEPOSIT_QUOTE.expectedLpOut,
    minLpOut: DEPOSIT_QUOTE.minLpOut,
    minRatio: DEPOSIT_QUOTE.minRatio,
    maxRatio: DEPOSIT_QUOTE.maxRatio,
    initialMinimumLp: DEPOSIT_QUOTE.initialMinimumLp,
    settlementDeadline: DEPOSIT_QUOTE.settlementDeadline,
  },
  preparedTransactionHash: PREPARED_HASH,
  hashEncoding: 'base64',
  hashingSchemeVersion: 3,
  partyId: TRADER_PARTY,
  publicKeyFingerprint: FINGERPRINT,
  expiresAt: '2099-01-01T00:00:45Z',
  recoveryEffects: [],
};

export function deposit(overrides: Partial<DepositRequest> = {}): DepositRequest {
  return {
    requestId: 'deposit-0001',
    quoteId: DEPOSIT_QUOTE.quoteId,
    kind: 'DEPOSIT',
    terms: DEPOSIT_PREPARATION.terms,
    result: null,
    status: 'READY',
    arrivalSequence: 2,
    createdAt: '2026-09-19T12:00:10Z',
    submittedAt: '2026-09-19T12:00:12Z',
    updatedAt: '2026-09-19T12:00:15Z',
    settlementId: null,
    allocationCids: ['00alloc0011', '00alloc0012', '00alloc0013'],
    updateId: '1220update30',
    errorCode: null,
    error: null,
    canRecover: false,
    ...overrides,
  };
}

export const WITHDRAWAL_QUOTE: WithdrawalQuote = {
  quoteId: 'quote-withdraw-0001',
  poolId: POOL_ID,
  poolName: POOL.name,
  trader: TRADER_PARTY,
  baseInstrument: BTC,
  quoteInstrument: USDC,
  lpInstrument: LP,
  lpAmount: '100',
  expectedBaseOut: '0.4082482905',
  expectedQuoteOut: '24494.8974278318',
  minBaseOut: '0.4062070490',
  minQuoteOut: '24372.4229406926',
  slippageBps: 50,
  stateId: '00state0001',
  quoteExpiresAt: '2099-01-01T00:00:30Z',
  settlementDeadline: '2099-01-01T00:10:00Z',
};

export const WITHDRAWAL_PREPARATION: WithdrawalPreparation = {
  preparationId: 'prep-withdraw-0001',
  requestId: 'withdraw-0001',
  action: 'SUBMIT',
  terms: {
    poolId: POOL_ID,
    poolName: POOL.name,
    trader: TRADER_PARTY,
    baseInstrument: BTC,
    quoteInstrument: USDC,
    lpInstrument: LP,
    lpAmount: WITHDRAWAL_QUOTE.lpAmount,
    expectedBaseOut: WITHDRAWAL_QUOTE.expectedBaseOut,
    expectedQuoteOut: WITHDRAWAL_QUOTE.expectedQuoteOut,
    minBaseOut: WITHDRAWAL_QUOTE.minBaseOut,
    minQuoteOut: WITHDRAWAL_QUOTE.minQuoteOut,
    settlementDeadline: WITHDRAWAL_QUOTE.settlementDeadline,
  },
  preparedTransactionHash: PREPARED_HASH,
  hashEncoding: 'base64',
  hashingSchemeVersion: 3,
  partyId: TRADER_PARTY,
  publicKeyFingerprint: FINGERPRINT,
  expiresAt: '2099-01-01T00:00:45Z',
  recoveryEffects: [],
};

export function withdrawal(overrides: Partial<WithdrawalRequest> = {}): WithdrawalRequest {
  return {
    requestId: 'withdraw-0001',
    quoteId: WITHDRAWAL_QUOTE.quoteId,
    kind: 'WITHDRAW',
    terms: WITHDRAWAL_PREPARATION.terms,
    result: null,
    status: 'READY',
    arrivalSequence: 3,
    createdAt: '2026-09-19T12:00:10Z',
    submittedAt: '2026-09-19T12:00:12Z',
    updatedAt: '2026-09-19T12:00:15Z',
    settlementId: null,
    allocationCids: ['00alloc0021', '00alloc0022', '00alloc0023'],
    updateId: '1220update31',
    errorCode: null,
    error: null,
    canRecover: false,
    ...overrides,
  };
}

export function position(overrides: Partial<LpPosition> = {}): LpPosition {
  return {
    poolId: POOL_ID,
    poolName: POOL.name,
    baseInstrument: BTC,
    quoteInstrument: USDC,
    lpInstrument: LP,
    availableLp: '1124.7448713915',
    allocatedLp: '0',
    totalLp: '1124.7448713915',
    lpTokenSupply: '1224.7448713916',
    share: '0.9183503419',
    baseValue: '4.5917517095',
    quoteValue: '275505.1025721682',
    ...overrides,
  };
}

const SWAP_POLICY: SettlementPolicy = {
  poolId: POOL_ID,
  type: 'swap',
  automaticEnabled: false,
  batchSize: 5,
  maxBatchSize: 10,
  version: 4,
  updatedAt: '2026-09-19T11:30:00Z',
};

/** Each queue's own settings, apart in mode, size and version so a screen showing the wrong one is caught. */
export const POLICIES: Record<RequestType, SettlementPolicy> = {
  swap: SWAP_POLICY,
  deposit: { ...SWAP_POLICY, type: 'deposit', automaticEnabled: true, batchSize: 3, version: 2 },
  withdraw: { ...SWAP_POLICY, type: 'withdraw', batchSize: 8, version: 7 },
};

export function monitoring(overrides: Partial<SettlementMonitoring> = {}): SettlementMonitoring {
  return {
    poolId: POOL_ID,
    // The venue lists the queues by name, which is not the order the screen shows.
    policies: [POLICIES.deposit, POLICIES.swap, POLICIES.withdraw],
    readyCount: 2,
    pendingCount: 2,
    blockedRequest: null,
    blockedReason: null,
    oldestSubmittedAt: '2026-09-19T11:58:00Z',
    nearestDeadline: '2099-01-01T00:10:00Z',
    activeSettlement: null,
    pool: {
      poolId: POOL_ID,
      version: '00state0001:00config0001',
      reserves: {
        stateId: '00state0001',
        baseReserve: '5',
        quoteReserve: '300000',
        spotPrice: '60000',
        invariant: '1500000',
      },
      lpTokenSupply: '1224.7448713916',
      initialRatio: '60000',
      feeBps: '30',
      health: 'READY',
      reason: null,
      observedAt: new Date().toISOString(),
      ledgerOffset: 4821,
    },
    ...overrides,
  };
}

export function settlement(overrides: Partial<Settlement> = {}): Settlement {
  return {
    settlementId: 'settle-0001',
    poolId: POOL_ID,
    trigger: 'MANUAL',
    status: 'CONFIRMED',
    requests: [{ type: 'swap', requestId: 'swap-0001' }],
    fills: [
      { type: 'swap', requestId: 'swap-0001', amountOut: '2941.176470', outputInstrument: USDC },
    ],
    before: {
      stateId: '00state0001',
      baseReserve: '5',
      quoteReserve: '300000',
      spotPrice: '60000',
      invariant: '1500000',
    },
    after: {
      stateId: '00state0002',
      baseReserve: '5.05',
      quoteReserve: '297058.823530',
      spotPrice: '58823.5294118812',
      invariant: '1500147.0588265',
    },
    policyVersion: 4,
    createdAt: '2026-09-19T12:01:00Z',
    updatedAt: '2026-09-19T12:01:04Z',
    updateId: '1220update21',
    errorCode: null,
    error: null,
    retryOf: null,
    ...overrides,
  };
}

/** A pool state as a preview projects it. The venue computes every figure here. */
export function projected(baseReserve: string, quoteReserve: string): ProjectedPoolState {
  return {
    baseReserve,
    quoteReserve,
    lpTokenSupply: '1224.7448713916',
    spotPrice: null,
    invariant: '0',
  };
}

/** A swap the preview projects to settle comfortably above its signed minimum. */
export function previewStep(overrides: Partial<SettlementPreviewStep> = {}): SettlementPreviewStep {
  return {
    request: { type: 'swap', requestId: 'swap-0001' },
    status: 'VALID',
    fill: { type: 'swap', requestId: 'swap-0001', amountOut: '2950.123456', outputInstrument: USDC },
    before: projected('5', '300000'),
    after: projected('5.05', '297049.876544'),
    outputs: [{ instrument: USDC, amount: '2950.123456', minimum: '2926.470588', headroomBps: '80.1' }],
    errorCode: null,
    error: null,
    ...overrides,
  };
}

/**
 * The next batch of one queue. Its selection is the membership of its steps,
 * at the pool version and that queue's policy version monitoring reports,
 * unless overridden.
 */
export function preview(overrides: Partial<SettlementPreview> = {}): SettlementPreview {
  const steps = overrides.steps ?? [previewStep()];
  const observed = monitoring().pool;
  const type = steps[0]?.request.type ?? 'swap';
  return {
    selection: {
      type,
      retryOf: null,
      stateVersion: observed.version,
      policyVersion: POLICIES[type].version,
      requests: steps.map((step) => step.request),
    },
    pool: observed,
    steps,
    activeSettlementId: null,
    executable: steps.length > 0 && steps.every((step) => step.status === 'VALID'),
    ...overrides,
  };
}
