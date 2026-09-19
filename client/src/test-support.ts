import type { Onboarding, OnboardingDocument } from './types/onboarding.js';
import type { PoolDetail, PoolProposal, PoolTerms } from './types/pool.js';

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
  dvv: 'dvv::1220dvv',
  baseInstrumentId: { admin: 'issuer-usdc::1220usdc', id: 'USDC' },
  quoteInstrumentId: { admin: 'issuer-eurc::1220eurc', id: 'EURC' },
  baseAccount: { owner: 'dvv::1220dvv', provider: null, id: 'pool-usdc-eurc-base' },
  quoteAccount: { owner: 'dvv::1220dvv', provider: null, id: 'pool-usdc-eurc-quote' },
  lpTokenInstrumentId: { admin: 'dvv::1220dvv', id: 'LP-USDC-EURC' },
  feeBps: '30.0000000000',
  baseReserve: '1000000.0000000000',
  quoteReserve: '920000.0000000000',
  lpTokenSupply: '959166.3050000000',
};

/** A proposal the venue is still holding, waiting for the dvv to act. */
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

/** The same proposal once the dvv accepted it and the pool exists. */
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
