import { describe, expect, it } from 'vitest';
import { createDexClient } from '../../client.js';
import {
  COMPLETED_ONBOARDING,
  NEW_ONBOARDING,
  PASSPORT,
  jsonResponse,
  recordFetch,
  type RecordedCall,
} from '../../test-support.js';
import type { Onboarding } from '../../types/onboarding.js';

const ID = '7f1c3d9e-0000-4000-8000-000000000001';
const PREPARATION = 'd4e6f8a0-0000-4000-8000-000000000004';
const PUBLIC_KEY = 'MCowBQYDK2VwAyEAdGVzdC1wdWJsaWMta2V5LWJ5dGVzLWZvci1maXh0dXJl';
const SIGNATURE = 'c2lnbmF0dXJlLWJ5dGVz';

function clientWith(body: unknown, status = 200) {
  const recorder = recordFetch(() => jsonResponse(status, body));
  const client = createDexClient({
    baseUrl: 'https://venue.example.com',
    getAccessToken: () => 'token',
    fetchImpl: recorder.fetchImpl,
  });
  return { client, calls: recorder.calls };
}

/** Each case is: what the caller does, and what must appear on the wire. */
const routes: [
  string,
  (client: ReturnType<typeof createDexClient>) => Promise<unknown>,
  string,
  string,
  unknown,
][] = [
  ['me', (client) => client.me(), 'GET', 'https://venue.example.com/v1/me', undefined],
  [
    'mine',
    (client) => client.onboarding.mine(),
    'GET',
    'https://venue.example.com/v1/onboardings/mine',
    undefined,
  ],
  [
    'submitApplication',
    (client) =>
      client.onboarding.submitApplication({
        legalName: 'Acme Trading Ltd',
        countryCode: 'PT',
        documents: [PASSPORT],
      }),
    'POST',
    'https://venue.example.com/v1/onboardings',
    { legalName: 'Acme Trading Ltd', countryCode: 'PT', documents: [PASSPORT] },
  ],
  [
    'get',
    (client) => client.onboarding.get(ID),
    'GET',
    `https://venue.example.com/v1/onboardings/${ID}`,
    undefined,
  ],
  [
    'prepareParty',
    (client) => client.onboarding.prepareParty(ID, { publicKey: PUBLIC_KEY }),
    'POST',
    `https://venue.example.com/v1/onboardings/${ID}/party/prepare`,
    { publicKey: PUBLIC_KEY },
  ],
  [
    'confirmParty',
    (client) =>
      client.onboarding.confirmParty(ID, { preparationId: PREPARATION, signature: SIGNATURE }),
    'POST',
    `https://venue.example.com/v1/onboardings/${ID}/party/submit`,
    { preparationId: PREPARATION, signature: SIGNATURE },
  ],
  [
    'pools.list',
    (client) => client.pools.list(),
    'GET',
    'https://venue.example.com/v1/pools',
    undefined,
  ],
];

describe('the trader operations', () => {
  it.each(routes)('%s reaches its own route', async (_name, call, method, url, body) => {
    const { client, calls } = clientWith(COMPLETED_ONBOARDING);
    await call(client);

    const sent = calls[0] as RecordedCall;
    expect(sent.method).toBe(method);
    expect(sent.url).toBe(url);
    expect(sent.body === undefined ? undefined : (JSON.parse(sent.body) as unknown)).toEqual(body);
  });

  it('encodes an identifier that would otherwise escape its segment', async () => {
    const { client, calls } = clientWith(COMPLETED_ONBOARDING);
    await client.onboarding.get('../../admin/onboardings');

    expect(calls[0]?.url).toBe(
      'https://venue.example.com/v1/onboardings/..%2F..%2Fadmin%2Fonboardings',
    );
  });

  it('puts nothing but the public half of the key pair on the wire', async () => {
    const { client, calls } = clientWith(COMPLETED_ONBOARDING);

    await client.onboarding.prepareParty(ID, { publicKey: PUBLIC_KEY });
    await client.onboarding.confirmParty(ID, {
      preparationId: PREPARATION,
      signature: SIGNATURE,
    });

    const sent = calls.map((call) => call.body ?? '').join(' ');
    expect(sent).not.toMatch(/private|secret|seed|mnemonic/i);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ publicKey: PUBLIC_KEY });
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      preparationId: PREPARATION,
      signature: SIGNATURE,
    });
  });
});

describe('the caller’s own onboarding', () => {
  it('reads a JSON null as "not applied yet", not as a broken answer', async () => {
    const { client } = clientWith(null);
    await expect(client.onboarding.mine()).resolves.toBeNull();
  });

  it('reads an existing record whole', async () => {
    const { client } = clientWith(COMPLETED_ONBOARDING);
    await expect(client.onboarding.mine()).resolves.toEqual(COMPLETED_ONBOARDING);
  });

  it('still rejects an empty body, which is not the same as null', async () => {
    const recorder = recordFetch(() => new Response('', { status: 200 }));
    const client = createDexClient({
      baseUrl: '/api',
      getAccessToken: () => 'token',
      fetchImpl: recorder.fetchImpl,
    });

    await expect(client.onboarding.mine()).rejects.toMatchObject({ kind: 'response' });
  });

  it('keeps that tolerance to itself: no other route accepts a null', async () => {
    const { client } = clientWith(null);
    await expect(client.onboarding.get(ID)).rejects.toMatchObject({ kind: 'response' });
    await expect(client.me()).rejects.toMatchObject({ kind: 'response' });
    await expect(client.pools.list()).rejects.toMatchObject({ kind: 'response' });
  });
});

describe('what the venue answers', () => {
  it('returns the whole record from prepareParty, party field and all', async () => {
    const prepared: Onboarding = {
      ...NEW_ONBOARDING,
      status: 'AWAITING_PARTY',
      party: {
        preparationId: PREPARATION,
        partyId: 'acme_trading::1220f4',
        confirmed: false,
        publicKey: PUBLIC_KEY,
        publicKeyFingerprint: '1220aa55cc',
        multiHash: '1220ffee01',
        synchronizerId: 'global-domain::1220abcd',
        status: 'PREPARED',
        participantId: 'venue-participant::1220a13',
        topologyTransactions: ['CgUKA2Fh', 'CgUKA2Ji'],
      },
    };
    const { client } = clientWith(prepared);

    // Typed as Onboarding, so narrowing the route back to a bare preparation
    // fails the build rather than only the assertion below.
    const answer: Onboarding = await client.onboarding.prepareParty(ID, { publicKey: PUBLIC_KEY });
    expect(answer).toEqual(prepared);
    expect(answer.party?.status).toBe('PREPARED');
    expect(answer.party?.multiHash).toBe('1220ffee01');
    // The signer needs these verbatim to check what it is about to sign.
    expect(answer.party?.participantId).toBe('venue-participant::1220a13');
    expect(answer.party?.topologyTransactions).toEqual(['CgUKA2Fh', 'CgUKA2Ji']);
  });

  it('keeps a new record’s nulls and empty steps exactly as they arrived', async () => {
    const { client } = clientWith(NEW_ONBOARDING);
    const created = await client.onboarding.submitApplication({
      legalName: 'Acme Trading Ltd',
      countryCode: 'PT',
      documents: [PASSPORT],
    });

    expect(created).toEqual(NEW_ONBOARDING);
    expect(created.review).toBeNull();
    expect(created.party).toBeNull();
    expect(created.ledgerSteps).toEqual([]);
  });

  it('keeps both document lists, the hint, and every identifier as a string', async () => {
    const { client } = clientWith(COMPLETED_ONBOARDING);
    const onboarding = await client.onboarding.get(ID);

    expect(onboarding).toEqual(COMPLETED_ONBOARDING);
    expect(onboarding.application.documents).toEqual([PASSPORT]);
    expect(onboarding.application.documentReferences).toEqual([]);
    expect(onboarding.suggestedPartyHint).toBe('sullivan_capital');
    expect(onboarding.createdAt).toBe('2026-09-16T08:30:00Z');
    expect(onboarding.ledgerSteps[0]?.contractId).toBe('00abc123');
    expect(onboarding.ledgerSteps[0]?.updateId).toBe('1220update01');
    expect(onboarding.ledgerSteps[0]?.issuer).toBe('venue-operator::1220beef');
  });

  it('keeps a historical preparation’s empty topology as it arrived', async () => {
    const historical: Onboarding = {
      ...COMPLETED_ONBOARDING,
      partyMode: 'participant-test',
      party: {
        ...COMPLETED_ONBOARDING.party!,
        participantId: null,
        topologyTransactions: [],
      },
    };
    const { client } = clientWith(historical);

    const onboarding = await client.onboarding.get(ID);
    expect(onboarding.party?.participantId).toBeNull();
    expect(onboarding.party?.topologyTransactions).toEqual([]);
  });

  it('passes unresolved party and ledger progress through as the success it is', async () => {
    const stuck: Onboarding = {
      ...COMPLETED_ONBOARDING,
      status: 'PARTY_UNRESOLVED',
      party: { ...COMPLETED_ONBOARDING.party!, confirmed: false, status: 'UNRESOLVED' },
      ledgerSteps: [
        {
          key: 'attestation',
          commandId: 'e5f7a9b1-0000-4000-8000-000000000005',
          status: 'UNRESOLVED',
          contractId: null,
          updateId: null,
          issuer: null,
        },
      ],
    };
    const { client, calls } = clientWith(stuck);

    const onboarding = await client.onboarding.get(ID);
    expect(onboarding).toEqual(stuck);
    // It is business progress, not a failure, so nothing was retried.
    expect(calls).toHaveLength(1);
  });

  it('reports another account’s record as the 404 the backend sends', async () => {
    const { client } = clientWith({ status: 404, detail: 'Onboarding not found' }, 404);

    await expect(client.onboarding.get(ID)).rejects.toMatchObject({
      kind: 'http',
      status: 404,
    });
  });

  it.each([
    ['a malformed signature', 400],
    ['a preparation owned by someone else', 404],
    ['a missing prerequisite', 409],
  ])('reports %s with the status the venue chose', async (_name, status) => {
    const { client } = clientWith({ status, detail: 'Refused' }, status);

    await expect(
      client.onboarding.confirmParty(ID, { preparationId: PREPARATION, signature: SIGNATURE }),
    ).rejects.toMatchObject({ kind: 'http', status });
  });
});

describe('the pool catalogue', () => {
  it('reads the venue’s current pools as a bare array', async () => {
    const pools = [
      { poolId: 'pool-usdc-eurc', name: 'USDC / EURC' },
      { poolId: 'pool-tbill-usdc', name: 'TBILL / USDC' },
    ];
    const { client } = clientWith(pools);

    await expect(client.pools.list()).resolves.toEqual(pools);
  });

  it('reads an empty catalogue as an empty array', async () => {
    const { client } = clientWith([]);
    await expect(client.pools.list()).resolves.toEqual([]);
  });
});

describe('the caller the venue reports', () => {
  it('carries the role and the party, with no party before one is registered', async () => {
    const profile = {
      accountId: 'b2e4f6a8-0000-4000-8000-000000000002',
      displayName: 'David Whitfield',
      role: 'TRADER',
      partyId: null,
    };
    const { client } = clientWith(profile);

    await expect(client.me()).resolves.toEqual(profile);
  });
});
