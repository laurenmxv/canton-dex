import type { Onboarding, OnboardingDocument } from './types/onboarding.js';
import type { PoolDetail, PoolProposal, PoolTerms } from './types/pool.js';
import type {
  PoolReserves,
  Settlement,
  SettlementMonitoring,
  SettlementPolicy,
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

/** The terms a proposal carries, with every party and amount the venue assigned. */
export const POOL_TERMS: PoolTerms = {
  dvo: 'dvo::1220dvo',
  baseInstrumentId: { admin: 'issuer-usdc::1220usdc', id: 'USDC' },
  quoteInstrumentId: { admin: 'issuer-eurc::1220eurc', id: 'EURC' },
  baseAccount: { owner: 'dvo::1220dvo', provider: null, id: 'pool-usdc-eurc-base' },
  quoteAccount: { owner: 'dvo::1220dvo', provider: null, id: 'pool-usdc-eurc-quote' },
  lpTokenInstrumentId: { admin: 'dvo::1220dvo', id: 'LP-USDC-EURC' },
  feeBps: '30.0000000000',
  baseReserve: '1000000.0000000000',
  quoteReserve: '920000.0000000000',
  lpTokenSupply: '959166.3050000000',
};

/** A proposal the venue is still holding, waiting for the dvo to act. */
export const PENDING_PROPOSAL: PoolProposal = {
  proposalId: 'a7c9e1f3-0000-4000-8000-00000000000b',
  name: 'USDC / EURC',
  settings: POOL_TERMS,
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
  swapIds: [QUEUED_SWAP.swapId],
  fills: [{ swapId: QUEUED_SWAP.swapId, amountOut: '2961.474103', outputInstrument: USDC }],
  before: RESERVES_BEFORE,
  after: RESERVES_AFTER,
  policyVersion: 4,
  createdAt: '2026-09-19T12:01:00Z',
  updatedAt: '2026-09-19T12:01:04Z',
  updateId: '1220update21',
  errorCode: null,
  error: null,
};

export const SETTLEMENT_POLICY: SettlementPolicy = {
  poolId: '00pool0001',
  automaticEnabled: false,
  batchSize: 5,
  maxBatchSize: 10,
  version: 4,
  updatedAt: '2026-09-19T11:30:00Z',
};

export const MONITORING: SettlementMonitoring = {
  poolId: '00pool0001',
  policy: SETTLEMENT_POLICY,
  readyCount: 3,
  pendingCount: 4,
  blockedSwapId: null,
  blockedReason: null,
  oldestSubmittedAt: '2026-09-19T11:58:00Z',
  nearestDeadline: '2026-09-19T12:10:00Z',
  activeSettlement: null,
  pool: {
    poolId: '00pool0001',
    version: '00state0001:00config0001',
    reserves: RESERVES_BEFORE,
    feeBps: '30',
    health: 'READY',
    reason: null,
    observedAt: '2026-09-19T12:00:20Z',
    ledgerOffset: 4821,
  },
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
