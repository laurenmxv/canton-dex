import type {
  DepositPreparation,
  DepositQuote,
  DepositRequest,
  LpPositions,
  WithdrawalPreparation,
  WithdrawalQuote,
  WithdrawalRequest,
} from './types/liquidity.js';
import type { Onboarding, OnboardingDocument } from './types/onboarding.js';
import type { PoolDetail, PoolProposal, PoolTerms } from './types/pool.js';
import type {
  PoolReserves,
  Settlement,
  SettlementMonitoring,
  SettlementPolicy,
  SettlementPreview,
} from './types/settlement.js';
import type { Swap, SwapPreparation, SwapQuote } from './types/swap.js';
import type { TokenBalances, FaucetPreparation } from './types/token.js';

/** What the client actually put on the wire, as the injected fetch saw it. */
export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  credentials: RequestCredentials | undefined;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | undefined;
}

export interface Recorder {
  calls: RecordedCall[];
  fetchImpl: typeof fetch;
}

/** Reads a plain object, an array of pairs or a `Headers`, as fetch itself would. */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  if (!init?.headers) return {};
  const headers: Record<string, string> = {};
  // Headers lowercases every name itself, which is what the assertions expect.
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  return headers;
}

/** An injected fetch that records every call and answers with `reply`. */
export function recordFetch(reply: (call: RecordedCall) => Response | Promise<Response>): Recorder {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: headersOf(init),
      body: init?.body === undefined || init.body === null ? undefined : String(init.body),
      credentials: init?.credentials,
      redirect: init?.redirect,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

export function jsonResponse(
  status: number,
  body: unknown,
  contentType = 'application/json',
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });
}

export const PASSPORT: OnboardingDocument = {
  id: 'a1b2c3d4-0000-4000-8000-00000000000a',
  category: 'IDENTITY',
  fileName: 'passport.pdf',
  mediaType: 'application/pdf',
  sizeBytes: 182_311,
  simulated: true,
};

/** A complete record with every nullable field filled, as a settled onboarding looks. */
export const COMPLETED_ONBOARDING: Onboarding = {
  id: '7f1c3d9e-0000-4000-8000-000000000001',
  accountId: 'b2e4f6a8-0000-4000-8000-000000000002',
  application: {
    legalName: 'Sullivan Capital Partners LLC',
    countryCode: 'US',
    documents: [PASSPORT],
    documentReferences: [],
  },
  status: 'COMPLETED',
  partyMode: 'external',
  createdAt: '2026-09-16T08:30:00Z',
  review: {
    decision: 'APPROVED',
    approvedPoolIds: ['pool-usdc-eurc'],
    reviewedBy: 'c3d5e7f9-0000-4000-8000-000000000003',
    reviewedAt: '2026-09-16T09:15:00Z',
    partyHint: 'sullivan_capital',
  },
  party: {
    preparationId: 'd4e6f8a0-0000-4000-8000-000000000004',
    partyId: 'sullivan_capital::1220f4c1a977a',
    confirmed: true,
    publicKey: 'MCowBQYDK2VwAyEAdGVzdC1wdWJsaWMta2V5LWJ5dGVzLWZvci1maXh0dXJl',
    publicKeyFingerprint: '1220aa55cc',
    multiHash: '1220ffee01',
    synchronizerId: 'global-domain::1220abcd',
    status: 'CONFIRMED',
    participantId: 'venue-participant::1220a13',
    topologyTransactions: ['CgUKA2Fh', 'CgUKA2Ji'],
  },
  ledgerSteps: [
    {
      key: 'attestation',
      commandId: 'e5f7a9b1-0000-4000-8000-000000000005',
      status: 'CONFIRMED',
      contractId: '00abc123',
      updateId: '1220update01',
      issuer: 'venue-operator::1220beef',
    },
    {
      key: 'access:pool-usdc-eurc',
      commandId: 'f6a8b0c2-0000-4000-8000-000000000006',
      status: 'CONFIRMED',
      contractId: '00def456',
      updateId: '1220update02',
      issuer: 'venue-operator::1220beef',
    },
  ],
  suggestedPartyHint: 'sullivan_capital',
};

/** A fresh record: nothing reviewed, no party, no ledger work. */
export const NEW_ONBOARDING: Onboarding = {
  id: '7f1c3d9e-0000-4000-8000-000000000007',
  accountId: 'b2e4f6a8-0000-4000-8000-000000000002',
  application: {
    legalName: 'Acme Trading Ltd',
    countryCode: 'PT',
    documents: [PASSPORT],
    documentReferences: [],
  },
  status: 'AWAITING_REVIEW_AND_PARTY',
  partyMode: 'external',
  createdAt: '2026-09-17T22:12:00Z',
  review: null,
  party: null,
  ledgerSteps: [],
  suggestedPartyHint: 'acme_trading',
};

/** A pool the dvo configured and nobody has deposited into yet. */
export const POOL_TERMS: PoolTerms = {
  dvo: 'dvo::1220dvo',
  baseInstrumentId: { admin: 'issuer-usdc::1220usdc', id: 'USDC' },
  quoteInstrumentId: { admin: 'issuer-eurc::1220eurc', id: 'EURC' },
  baseAccount: { owner: 'dvo::1220dvo', provider: 'venue-operator::1220beef', id: 'pool-usdc-eurc-base' },
  quoteAccount: { owner: 'dvo::1220dvo', provider: 'venue-operator::1220beef', id: 'pool-usdc-eurc-quote' },
  lpTokenInstrumentId: { admin: 'dvo::1220dvo', id: 'LP-USDC-EURC' },
  feeBps: '30',
  baseReserve: '0.0000000000',
  quoteReserve: '0.0000000000',
  lpTokenSupply: '0.0000000000',
  initialRatio: '0.9200000000',
};

/** A proposal the venue is still holding, waiting for the dvo to act. */
export const PENDING_PROPOSAL: PoolProposal = {
  proposalId: 'a7c9e1f3-0000-4000-8000-00000000000b',
  name: 'USDC / EURC',
  settings: {
    dvo: POOL_TERMS.dvo,
    baseInstrumentId: POOL_TERMS.baseInstrumentId,
    quoteInstrumentId: POOL_TERMS.quoteInstrumentId,
    feeBps: POOL_TERMS.feeBps,
  },
  status: 'PENDING',
  createdAt: '2026-09-18T10:00:00Z',
  updatedAt: '2026-09-18T10:00:05Z',
  proposedBy: 'venue-operator::1220beef',
  proposalCid: '00proposal0001',
  factoryId: '00factory0001',
  poolId: null,
  updateId: '1220update10',
  error: null,
};

/** The same proposal once the dvo accepted it and the pool exists. */
export const CREATED_PROPOSAL: PoolProposal = {
  ...PENDING_PROPOSAL,
  status: 'CREATED',
  updatedAt: '2026-09-18T10:04:00Z',
  poolId: '00pool0001',
  updateId: '1220update11',
};

export const POOL_DETAIL: PoolDetail = {
  poolId: '00pool0001',
  name: 'USDC / EURC',
  settings: POOL_TERMS,
  configId: '00config0001',
  stateId: '00state0001',
  packageId: '1220package01',
  createdAt: '2026-09-18T10:04:00Z',
  updatedAt: '2026-09-18T10:04:00Z',
};

const BTC = { admin: 'issuer::1220iss', id: 'BTC' };
const USDC = { admin: 'issuer::1220iss', id: 'USDC' };

/** A live price, with the minimum the signed request would bind. */
export const SWAP_QUOTE: SwapQuote = {
  quoteId: 'bb111111-0000-4000-8000-00000000000c',
  poolId: '00pool0001',
  poolName: 'BTC / USDC',
  trader: 'sullivan_capital::1220f4c1a977a',
  direction: 'BaseToQuote',
  inputInstrument: BTC,
  outputInstrument: USDC,
  amountIn: '0.05',
  expectedOut: '2961.474103',
  feeAmount: '0.00015',
  minOut: '2946.666732',
  slippageBps: 50,
  stateId: '00state0001',
  quoteExpiresAt: '2026-09-19T12:00:30Z',
  settlementDeadline: '2026-09-19T12:10:00Z',
};

/** What the wallet is asked to sign: a 32-byte hash, base64, under scheme V3. */
export const SWAP_PREPARATION: SwapPreparation = {
  preparationId: 'cc222222-0000-4000-8000-00000000000d',
  swapId: 'dd333333-0000-4000-8000-00000000000e',
  action: 'SUBMIT',
  terms: {
    poolId: SWAP_QUOTE.poolId,
    poolName: SWAP_QUOTE.poolName,
    trader: SWAP_QUOTE.trader,
    direction: SWAP_QUOTE.direction,
    inputInstrument: BTC,
    outputInstrument: USDC,
    amountIn: SWAP_QUOTE.amountIn,
    expectedOut: SWAP_QUOTE.expectedOut,
    feeAmount: SWAP_QUOTE.feeAmount,
    minOut: SWAP_QUOTE.minOut,
    settlementDeadline: SWAP_QUOTE.settlementDeadline,
  },
  preparedTransactionHash: 'ESIzRFVmd4iZqrvM3e7/ABEiM0RVZneImaq7zN3u/wA=',
  hashEncoding: 'base64',
  hashingSchemeVersion: 3,
  partyId: SWAP_QUOTE.trader,
  publicKeyFingerprint: '1220aa55cc',
  expiresAt: '2026-09-19T12:00:45Z',
};

/** A request the ledger confirmed and the pool has queued, not yet settled. */
export const QUEUED_SWAP: Swap = {
  swapId: SWAP_PREPARATION.swapId,
  quoteId: SWAP_QUOTE.quoteId,
  poolId: SWAP_QUOTE.poolId,
  poolName: SWAP_QUOTE.poolName,
  trader: SWAP_QUOTE.trader,
  direction: 'BaseToQuote',
  inputInstrument: BTC,
  outputInstrument: USDC,
  amountIn: SWAP_QUOTE.amountIn,
  expectedOut: SWAP_QUOTE.expectedOut,
  feeAmount: SWAP_QUOTE.feeAmount,
  minOut: SWAP_QUOTE.minOut,
  settlementDeadline: SWAP_QUOTE.settlementDeadline,
  status: 'READY',
  arrivalSequence: 7,
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
};

const LP = { admin: 'dvo::1220dvo', id: 'LP-BTC-USDC' };

/** The first deposit into an empty pool, at the ratio its dvo configured. */
export const DEPOSIT_QUOTE: DepositQuote = {
  quoteId: 'aa666666-0000-4000-8000-000000000011',
  poolId: '00pool0001',
  poolName: 'BTC / USDC',
  trader: SWAP_QUOTE.trader,
  baseInstrument: BTC,
  quoteInstrument: USDC,
  lpInstrument: LP,
  mode: 'INITIAL',
  maxBaseAmount: '5',
  maxQuoteAmount: '300000',
  expectedBaseAmount: '5',
  expectedQuoteAmount: '300000',
  expectedBaseRefund: '0',
  expectedQuoteRefund: '0',
  expectedLpOut: '1224.7448712915',
  minLpOut: '1218.6211469350',
  minRatio: '59700',
  maxRatio: '60300',
  initialMinimumLp: '0.0000001',
  slippageBps: 50,
  stateId: '00state0001',
  quoteExpiresAt: '2026-09-19T12:00:30Z',
  settlementDeadline: '2026-09-19T12:10:00Z',
};

/** One hash for the three allocations a deposit makes. */
export const DEPOSIT_PREPARATION: DepositPreparation = {
  preparationId: 'bb777777-0000-4000-8000-000000000012',
  requestId: 'cc888888-0000-4000-8000-000000000013',
  action: 'SUBMIT',
  terms: {
    poolId: DEPOSIT_QUOTE.poolId,
    poolName: DEPOSIT_QUOTE.poolName,
    trader: DEPOSIT_QUOTE.trader,
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
  preparedTransactionHash: 'ESIzRFVmd4iZqrvM3e7/ABEiM0RVZneImaq7zN3u/wA=',
  hashEncoding: 'base64',
  hashingSchemeVersion: 3,
  partyId: SWAP_QUOTE.trader,
  publicKeyFingerprint: '1220aa55cc',
  expiresAt: '2026-09-19T12:00:45Z',
  recoveryEffects: [],
};

/** The deposit, confirmed and queued, with nothing settled yet. */
export const QUEUED_DEPOSIT: DepositRequest = {
  requestId: DEPOSIT_PREPARATION.requestId,
  quoteId: DEPOSIT_QUOTE.quoteId,
  kind: 'DEPOSIT',
  terms: DEPOSIT_PREPARATION.terms,
  result: null,
  status: 'READY',
  arrivalSequence: 8,
  createdAt: '2026-09-19T12:00:10Z',
  submittedAt: '2026-09-19T12:00:12Z',
  updatedAt: '2026-09-19T12:00:15Z',
  settlementId: null,
  allocationCids: ['00alloc0011', '00alloc0012', '00alloc0013'],
  updateId: '1220update30',
  errorCode: null,
  error: null,
  canRecover: false,
};

export const WITHDRAWAL_QUOTE: WithdrawalQuote = {
  quoteId: 'dd999999-0000-4000-8000-000000000014',
  poolId: '00pool0001',
  poolName: 'BTC / USDC',
  trader: SWAP_QUOTE.trader,
  baseInstrument: BTC,
  quoteInstrument: USDC,
  lpInstrument: LP,
  lpAmount: '100',
  expectedBaseOut: '0.4082482905',
  expectedQuoteOut: '24494.8974278318',
  minBaseOut: '0.4062070490',
  minQuoteOut: '24372.4229406926',
  slippageBps: 50,
  stateId: '00state0002',
  quoteExpiresAt: '2026-09-19T13:00:30Z',
  settlementDeadline: '2026-09-19T13:10:00Z',
};

export const WITHDRAWAL_PREPARATION: WithdrawalPreparation = {
  preparationId: 'ee000000-0000-4000-8000-000000000015',
  requestId: 'ff000000-0000-4000-8000-000000000016',
  action: 'SUBMIT',
  terms: {
    poolId: WITHDRAWAL_QUOTE.poolId,
    poolName: WITHDRAWAL_QUOTE.poolName,
    trader: WITHDRAWAL_QUOTE.trader,
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
  preparedTransactionHash: 'ESIzRFVmd4iZqrvM3e7/ABEiM0RVZneImaq7zN3u/wA=',
  hashEncoding: 'base64',
  hashingSchemeVersion: 3,
  partyId: SWAP_QUOTE.trader,
  publicKeyFingerprint: '1220aa55cc',
  expiresAt: '2026-09-19T13:00:45Z',
  recoveryEffects: [],
};

/** A withdrawal a batch settled, with what it actually burned and paid. */
export const SETTLED_WITHDRAWAL: WithdrawalRequest = {
  requestId: WITHDRAWAL_PREPARATION.requestId,
  quoteId: WITHDRAWAL_QUOTE.quoteId,
  kind: 'WITHDRAW',
  terms: WITHDRAWAL_PREPARATION.terms,
  result: {
    actualLpBurned: '100',
    actualBaseOut: '0.4082482905',
    actualQuoteOut: '24494.8974278318',
  },
  status: 'SETTLED',
  arrivalSequence: 9,
  createdAt: '2026-09-19T13:00:10Z',
  submittedAt: '2026-09-19T13:00:12Z',
  updatedAt: '2026-09-19T13:01:04Z',
  settlementId: 'ee444444-0000-4000-8000-000000000017',
  allocationCids: ['00alloc0021', '00alloc0022', '00alloc0023'],
  updateId: '1220update31',
  errorCode: null,
  error: null,
  canRecover: false,
};

export const POSITIONS: LpPositions = {
  items: [
    {
      poolId: '00pool0001',
      poolName: 'BTC / USDC',
      baseInstrument: BTC,
      quoteInstrument: USDC,
      lpInstrument: LP,
      availableLp: '1124.7448712915',
      allocatedLp: '0',
      totalLp: '1124.7448712915',
      lpTokenSupply: '1124.7448713915',
      share: '0.9999999999',
      baseValue: '4.5917517095',
      quoteValue: '275505.1025721682',
    },
  ],
  asOfOffset: 4822,
};

export const RESERVES_BEFORE: PoolReserves = {
  stateId: '00state0001',
  baseReserve: '5',
  quoteReserve: '300000',
  spotPrice: '60000',
  invariant: '1500000',
};

export const RESERVES_AFTER: PoolReserves = {
  stateId: '00state0002',
  baseReserve: '5.05',
  quoteReserve: '297038.525897',
  spotPrice: '58819.5100786139',
  invariant: '1500044.55577985',
};

export const CONFIRMED_SETTLEMENT: Settlement = {
  settlementId: 'ee444444-0000-4000-8000-00000000000f',
  poolId: '00pool0001',
  trigger: 'MANUAL',
  status: 'CONFIRMED',
  requests: [{ type: 'swap', requestId: QUEUED_SWAP.swapId }],
  fills: [
    {
      type: 'swap',
      requestId: QUEUED_SWAP.swapId,
      amountOut: '2961.474103',
      outputInstrument: USDC,
    },
  ],
  before: RESERVES_BEFORE,
  after: RESERVES_AFTER,
  policyVersion: 4,
  createdAt: '2026-09-19T12:01:00Z',
  updatedAt: '2026-09-19T12:01:04Z',
  updateId: '1220update21',
  errorCode: null,
  error: null,
  retryOf: null,
};

export const SWAP_POLICY: SettlementPolicy = {
  poolId: '00pool0001',
  type: 'swap',
  automaticEnabled: false,
  batchSize: 5,
  maxBatchSize: 10,
  version: 4,
  updatedAt: '2026-09-19T11:30:00Z',
};

export const DEPOSIT_POLICY: SettlementPolicy = {
  ...SWAP_POLICY,
  type: 'deposit',
  automaticEnabled: true,
  batchSize: 3,
  version: 2,
};

export const WITHDRAW_POLICY: SettlementPolicy = { ...SWAP_POLICY, type: 'withdraw', batchSize: 8, version: 7 };

export const MONITORING: SettlementMonitoring = {
  poolId: '00pool0001',
  // The venue lists the queues by name, which is not the order a screen shows them in.
  policies: [DEPOSIT_POLICY, SWAP_POLICY, WITHDRAW_POLICY],
  readyCount: 3,
  pendingCount: 4,
  blockedRequest: null,
  blockedReason: null,
  oldestSubmittedAt: '2026-09-19T11:58:00Z',
  nearestDeadline: '2026-09-19T12:10:00Z',
  activeSettlement: null,
  pool: {
    poolId: '00pool0001',
    version: '00state0001:00config0001',
    reserves: RESERVES_BEFORE,
    lpTokenSupply: '1224.7448713915',
    initialRatio: '60000',
    feeBps: '30',
    health: 'READY',
    reason: null,
    observedAt: '2026-09-19T12:00:20Z',
    ledgerOffset: 4821,
  },
};

const PROJECTED_BEFORE = {
  baseReserve: RESERVES_BEFORE.baseReserve,
  quoteReserve: RESERVES_BEFORE.quoteReserve,
  lpTokenSupply: '1224.7448713915',
  spotPrice: RESERVES_BEFORE.spotPrice,
  invariant: RESERVES_BEFORE.invariant,
};

const PROJECTED_AFTER = {
  baseReserve: RESERVES_AFTER.baseReserve,
  quoteReserve: RESERVES_AFTER.quoteReserve,
  lpTokenSupply: '1224.7448713915',
  spotPrice: RESERVES_AFTER.spotPrice,
  invariant: RESERVES_AFTER.invariant,
};

/** The queued swap projected to settle, and the next one stopped at its signed minimum. */
export const SETTLEMENT_PREVIEW: SettlementPreview = {
  selection: {
    type: 'swap',
    retryOf: null,
    stateVersion: MONITORING.pool.version,
    policyVersion: SWAP_POLICY.version,
    requests: [
      { type: 'swap', requestId: QUEUED_SWAP.swapId },
      { type: 'swap', requestId: 'dd333333-0000-4000-8000-000000000019' },
    ],
  },
  pool: MONITORING.pool,
  steps: [
    {
      request: { type: 'swap', requestId: QUEUED_SWAP.swapId },
      status: 'VALID',
      fill: { type: 'swap', requestId: QUEUED_SWAP.swapId, amountOut: '2961.474103', outputInstrument: USDC },
      before: PROJECTED_BEFORE,
      after: PROJECTED_AFTER,
      outputs: [
        { instrument: USDC, amount: '2961.474103', minimum: '2946.666732', headroomBps: '50' },
      ],
      errorCode: null,
      error: null,
    },
    {
      request: { type: 'swap', requestId: 'dd333333-0000-4000-8000-000000000019' },
      status: 'BLOCKED',
      fill: null,
      before: PROJECTED_AFTER,
      after: null,
      outputs: [{ instrument: USDC, amount: '2902.1', minimum: '2940', headroomBps: '-130.6' }],
      errorCode: 'MIN_OUT_NOT_MET',
      error: 'Output is below the signed minimum at the projected reserves',
    },
  ],
  activeSettlementId: null,
  executable: false,
};

export const BALANCES: TokenBalances = {
  balances: [
    { instrument: BTC, symbol: 'BTC', decimals: 8, available: '0.1', locked: '0', total: '0.1' },
    {
      instrument: USDC,
      symbol: 'USDC',
      decimals: 6,
      available: '9500',
      locked: '500',
      total: '10000',
    },
  ],
  asOfOffset: 4821,
};

export const FAUCET_PREPARATION: FaucetPreparation = {
  preparationId: 'ff555555-0000-4000-8000-000000000010',
  preparedTransactionHash: 'ESIzRFVmd4iZqrvM3e7/ABEiM0RVZneImaq7zN3u/wA=',
  hashEncoding: 'base64',
  hashingSchemeVersion: 3,
  partyId: SWAP_QUOTE.trader,
  publicKeyFingerprint: '1220aa55cc',
  expiresAt: '2026-09-19T12:05:00Z',
  amounts: [
    { instrument: USDC, symbol: 'USDC', decimals: 6, amount: '10000' },
    { instrument: BTC, symbol: 'BTC', decimals: 8, amount: '0.1' },
  ],
};
