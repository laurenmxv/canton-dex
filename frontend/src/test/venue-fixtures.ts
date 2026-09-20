import { accessStep, ATTESTATION_STEP } from '../lib/api/ledger-steps';
import type {
  Onboarding,
  PoolDetail,
  Profile,
  Settlement,
  SettlementMonitoring,
  SettlementPolicy,
  Swap,
  SwapPreparationRecord,
  SwapQuoteRecord,
  TokenBalances,
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
    baseAccount: { owner: 'dvo::1220dvo', provider: null, id: 'btc-usdc-base' },
    quoteAccount: { owner: 'dvo::1220dvo', provider: null, id: 'btc-usdc-quote' },
    lpTokenInstrumentId: { admin: 'dvo::1220dvo', id: 'LP-BTC-USDC' },
    feeBps: '30.0000000000',
    baseReserve: '5.0000000000',
    quoteReserve: '300000.0000000000',
    lpTokenSupply: '1224.7448713916',
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

export const POLICY: SettlementPolicy = {
  poolId: POOL_ID,
  automaticEnabled: false,
  batchSize: 5,
  maxBatchSize: 10,
  version: 4,
  updatedAt: '2026-09-19T11:30:00Z',
};

export function monitoring(overrides: Partial<SettlementMonitoring> = {}): SettlementMonitoring {
  return {
    poolId: POOL_ID,
    policy: POLICY,
    readyCount: 2,
    pendingCount: 2,
    blockedSwapId: null,
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
    swapIds: ['swap-0001'],
    fills: [{ swapId: 'swap-0001', amountOut: '2941.176470', outputInstrument: USDC }],
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
    ...overrides,
  };
}
