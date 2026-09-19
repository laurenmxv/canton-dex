import { describe, expect, it, vi } from 'vitest';
import type { DexClient } from '../lib/api/port';
import { createFixtureBackend } from '../mocks/client';

/**
 * Regressions that keep the fixture honest. If the mock is more permissive
 * than the real backend, swapping in the SDK would surface bugs late.
 */
function world() {
  const backend = createFixtureBackend({ latencyMs: 0 });
  const as = (accountId: string): DexClient => {
    const session = backend.clientFor(accountId);
    if (!session) throw new Error(`No fixture account ${accountId}`);
    return session.client;
  };
  const demoFor = (accountId: string) => {
    const session = backend.clientFor(accountId);
    if (!session) throw new Error(`No fixture account ${accountId}`);
    return session.demo;
  };
  return { backend, as, demoFor };
}

const PUBLIC_KEY = 'MCowBQYDK2VwAyEAdGVzdC1wdWJsaWMta2V5LWJ5dGVzLWZvci1maXh0dXJl';
const SIGNATURE = 'c2lnbmF0dXJlLWZvci10aGlzLXByZXBhcmF0aW9u';

const application = {
  legalName: 'Acme Trading Ltd',
  countryCode: 'PT',
  documents: [
    {
      id: '11111111-0000-4000-8000-000000000001',
      category: 'IDENTITY' as const,
      fileName: 'passport.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 182_311,
      simulated: true as const,
    },
  ],
};

const APPROVAL = {
  decision: 'APPROVED' as const,
  approvedPoolIds: ['pool-usdc-eurc'],
  partyHint: 'acme_trading',
};

describe('the caller', () => {
  it('is unknown to the backend when no account matches', () => {
    expect(world().backend.clientFor('acc-nobody')).toBeNull();
  });

  it('reports its own role rather than letting the app guess one', async () => {
    const { as } = world();
    expect(await as('acc-operator').me()).toMatchObject({ role: 'OPERATOR' });
    expect(await as('acc-trader-alice').me()).toMatchObject({ role: 'TRADER' });
  });
});

describe('onboarding authorization', () => {
  it('hides one trader’s onboarding from another', async () => {
    const { as } = world();
    const alice = await as('acc-trader-alice').onboarding.submitApplication(application);
    const bob = as('acc-trader-bob');

    await expect(bob.onboarding.prepareParty(alice.id, { publicKey: PUBLIC_KEY })).rejects.toThrow('not found');
    await expect(bob.onboarding.confirmParty(alice.id, { preparationId: 'prep-0001', signature: SIGNATURE })).rejects.toThrow('not found');
  });

  it('refuses to let a trader review anything', async () => {
    const { as } = world();
    const alice = await as('acc-trader-alice').onboarding.submitApplication(application);

    await expect(
      as('acc-trader-bob').admin.reviewOnboarding(alice.id, APPROVAL),
    ).rejects.toThrow('cannot perform');
    await expect(as('acc-trader-alice').admin.listOnboardings()).rejects.toThrow('cannot perform');
  });

  it('refuses to let the operator apply or bind a trading party', async () => {
    const { as } = world();
    await expect(as('acc-operator').onboarding.submitApplication(application)).rejects.toThrow(
      'cannot perform',
    );
    await expect(as('acc-operator').onboarding.mine()).rejects.toThrow('cannot perform');
  });
});

describe('party preparation', () => {
  it('refuses to prepare before the venue has approved', async () => {
    const alice = world().as('acc-trader-alice');
    const onboarding = await alice.onboarding.submitApplication(application);

    await expect(
      alice.onboarding.prepareParty(onboarding.id, { publicKey: PUBLIC_KEY }),
    ).rejects.toThrow('not approved');
  });

  it('answers with the whole record, as the backend route does', async () => {
    const { as } = world();
    const alice = as('acc-trader-alice');
    const onboarding = await alice.onboarding.submitApplication(application);
    await as('acc-operator').admin.reviewOnboarding(onboarding.id, APPROVAL);

    const prepared = await alice.onboarding.prepareParty(onboarding.id, { publicKey: PUBLIC_KEY });

    expect(prepared.id).toBe(onboarding.id);
    expect(prepared.status).toBe('AWAITING_PARTY');
    expect(prepared.party?.confirmed).toBe(false);
    expect(prepared.party?.status).toBe('PREPARED');
    expect(prepared.party?.publicKey).toBe(PUBLIC_KEY);
    expect(prepared.party?.multiHash).toBeTruthy();
  });

  it('refuses a second, different key rather than replacing the first', async () => {
    const { as } = world();
    const alice = as('acc-trader-alice');
    const onboarding = await alice.onboarding.submitApplication(application);
    await as('acc-operator').admin.reviewOnboarding(onboarding.id, APPROVAL);
    await alice.onboarding.prepareParty(onboarding.id, { publicKey: PUBLIC_KEY });

    await expect(
      alice.onboarding.prepareParty(onboarding.id, { publicKey: 'a-different-key' }),
    ).rejects.toThrow('different key');
  });

  it('returns the same preparation on repeat calls, before and after confirming', async () => {
    const { as } = world();
    const alice = as('acc-trader-alice');
    const onboarding = await alice.onboarding.submitApplication(application);
    await as('acc-operator').admin.reviewOnboarding(onboarding.id, APPROVAL);

    const first = (await alice.onboarding.prepareParty(onboarding.id, { publicKey: PUBLIC_KEY })).party!;
    expect((await alice.onboarding.prepareParty(onboarding.id, { publicKey: PUBLIC_KEY })).party!.preparationId).toBe(
      first.preparationId,
    );

    await alice.onboarding.confirmParty(onboarding.id, { preparationId: first.preparationId, signature: SIGNATURE });
    const again = (await alice.onboarding.prepareParty(onboarding.id, { publicKey: PUBLIC_KEY })).party!;

    expect(again.preparationId).toBe(first.preparationId);
    expect(again.confirmed).toBe(true);
  });
});

describe('review', () => {
  it('accepts the identical decision twice and stores pools once, sorted', async () => {
    const operator = world().as('acc-operator');
    const [seeded] = await operator.admin.listOnboardings();

    const first = await operator.admin.reviewOnboarding(seeded!.id, {
      decision: 'APPROVED',
      approvedPoolIds: ['pool-usdc-eurc', 'pool-cc-usdc', 'pool-usdc-eurc'],
      partyHint: 'sullivan_capital',
    });
    const second = await operator.admin.reviewOnboarding(seeded!.id, {
      decision: 'APPROVED',
      approvedPoolIds: ['pool-cc-usdc', 'pool-usdc-eurc'],
      partyHint: 'sullivan_capital',
    });

    expect(first.review?.approvedPoolIds).toEqual(['pool-cc-usdc', 'pool-usdc-eurc']);
    expect(second.review?.reviewedAt).toBe(first.review?.reviewedAt);
  });

  it('refuses a decision that conflicts with the stored one', async () => {
    const operator = world().as('acc-operator');
    const [seeded] = await operator.admin.listOnboardings();
    await operator.admin.reviewOnboarding(seeded!.id, APPROVAL);

    await expect(
      operator.admin.reviewOnboarding(seeded!.id, {
        decision: 'REJECTED',
        approvedPoolIds: [],
        partyHint: null,
      }),
    ).rejects.toThrow('already reviewed');
  });

  it('refuses to approve a pool that does not exist', async () => {
    const operator = world().as('acc-operator');
    const [seeded] = await operator.admin.listOnboardings();

    await expect(
      operator.admin.reviewOnboarding(seeded!.id, { ...APPROVAL, approvedPoolIds: ['pool-imaginary'] }),
    ).rejects.toThrow('Unknown pool');
  });

  it('refuses an approval whose party name the ledger would not accept', async () => {
    const operator = world().as('acc-operator');
    const [seeded] = await operator.admin.listOnboardings();

    await expect(
      operator.admin.reviewOnboarding(seeded!.id, { ...APPROVAL, partyHint: 'Not A Hint' }),
    ).rejects.toThrow('party name');
  });

  it('refuses a rejection that names a party', async () => {
    const operator = world().as('acc-operator');
    const [seeded] = await operator.admin.listOnboardings();

    await expect(
      operator.admin.reviewOnboarding(seeded!.id, {
        decision: 'REJECTED',
        approvedPoolIds: [],
        partyHint: 'acme_trading',
      }),
    ).rejects.toThrow('cannot name a party');
  });
});

describe('application validation', () => {
  it('mirrors the backend bounds on name and documents', async () => {
    const alice = world().as('acc-trader-alice');

    await expect(
      alice.onboarding.submitApplication({ ...application, legalName: '   ' }),
    ).rejects.toThrow('Legal name is required');
    await expect(
      alice.onboarding.submitApplication({ ...application, legalName: 'x'.repeat(121) }),
    ).rejects.toThrow('longer than 120');
    await expect(
      alice.onboarding.submitApplication({
        ...application,
        documentReferences: Array.from({ length: 11 }, (_, index) => `doc://${index}`),
      }),
    ).rejects.toThrow('between 1 and 10');
  });

  it('keeps no reference to the caller’s object', async () => {
    const alice = world().as('acc-trader-alice');
    const mutable = { ...application, documentReferences: ['doc://kyc/acme/incorporation'] };
    await alice.onboarding.submitApplication(mutable);

    mutable.legalName = 'TAMPERED';
    mutable.documentReferences.push('doc://injected');

    const stored = await alice.onboarding.mine();
    expect(stored?.application.legalName).toBe('Acme Trading Ltd');
    expect(stored?.application.documentReferences).toHaveLength(1);
  });
});

describe('pool creation authorization', () => {
  it('refuses a trader asking the venue to create a pool', async () => {
    const { backend, demoFor } = world();
    for (const approver of ['venueGovernance', 'lpTokenIssuer', 'poolHoldings'] as const) {
      await backend.controls.approveAsCounterparty('prop-tbill-usdc', approver).catch(() => {});
    }

    await expect(
      demoFor('acc-trader-alice').pools.requestCreation('prop-tbill-usdc'),
    ).rejects.toThrow('cannot perform');
  });

  it('refuses creation until every approval is present', async () => {
    const { backend, demoFor } = world();
    const operator = demoFor('acc-operator');

    await expect(operator.pools.requestCreation('prop-tbill-usdc')).rejects.toThrow(
      'Missing pool approvals',
    );
    await backend.controls.approveAsCounterparty('prop-tbill-usdc', 'lpTokenIssuer');
    await expect(operator.pools.requestCreation('prop-tbill-usdc')).rejects.toThrow(
      'Missing pool approvals',
    );
    await backend.controls.approveAsCounterparty('prop-tbill-usdc', 'poolHoldings');

    expect((await operator.pools.requestCreation('prop-tbill-usdc')).status).toBe('CREATED');
  });

  it('refuses a proposal naming an instrument the venue does not list', async () => {
    await expect(
      world().demoFor('acc-operator').pools.createProposal({
        name: 'GHOST / USDC',
        baseInstrumentId: 'inst-ghost',
        quoteInstrumentId: 'inst-usdc',
        feeBps: 10,
        baseReserve: '1000',
        quoteReserve: '1000',
      }),
    ).rejects.toThrow('Unknown instrument');
  });

  it('refuses reserves that are not finite positive numbers', async () => {
    const operator = world().demoFor('acc-operator');
    const base = {
      name: 'CC / EURC',
      baseInstrumentId: 'inst-cc',
      quoteInstrumentId: 'inst-eurc',
      feeBps: 10,
      quoteReserve: '1000',
    };

    await expect(operator.pools.createProposal({ ...base, baseReserve: '1e999' })).rejects.toThrow(
      'greater than zero',
    );
    await expect(operator.pools.createProposal({ ...base, baseReserve: 'abc' })).rejects.toThrow(
      'greater than zero',
    );
  });
});

describe('swap ownership and idempotency', () => {
  async function aliceWithQuote() {
    const { as, backend, demoFor } = world();
    const alice = as('acc-trader-alice');
    const aliceDemo = demoFor('acc-trader-alice');
    const operator = as('acc-operator');

    const onboarding = await alice.onboarding.submitApplication(application);
    await operator.admin.reviewOnboarding(onboarding.id, APPROVAL);
    const prepared = await alice.onboarding.prepareParty(onboarding.id, { publicKey: PUBLIC_KEY });
    await alice.onboarding.confirmParty(onboarding.id, {
      preparationId: prepared.party!.preparationId,
      signature: SIGNATURE,
    });
    // Drain the ledger steps the way a polling screen would.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await alice.onboarding.mine();
      if (current?.status === 'COMPLETED') break;
    }

    const quote = await aliceDemo.swaps.requestQuote({
      poolId: 'pool-usdc-eurc',
      direction: 'BaseToQuote',
      amountIn: '25000.0000000000',
      slippageBps: 50,
    });
    return { as, backend, demoFor, alice: aliceDemo, quote };
  }

  it('refuses to prepare another account’s quote', async () => {
    const { demoFor, quote } = await aliceWithQuote();
    await expect(demoFor('acc-trader-bob').swaps.prepare(quote.quoteId)).rejects.toThrow(
      'Quote not found',
    );
  });

  it('refuses to submit another account’s preparation', async () => {
    const { demoFor, alice, quote } = await aliceWithQuote();
    const preparation = await alice.swaps.prepare(quote.quoteId);
    const bob = demoFor('acc-trader-bob');

    await expect(bob.swaps.submit(preparation.preparationId)).rejects.toThrow(
      'Preparation not found',
    );
    await expect(bob.swaps.listRequests()).resolves.toHaveLength(0);
  });

  it('spends a quote once, however many times it is prepared', async () => {
    const { alice, quote } = await aliceWithQuote();
    const first = await alice.swaps.prepare(quote.quoteId);
    const second = await alice.swaps.prepare(quote.quoteId);

    expect(second.preparationId).toBe(first.preparationId);
  });

  it('registers one request, however many times it is submitted', async () => {
    const { alice, quote } = await aliceWithQuote();
    const preparation = await alice.swaps.prepare(quote.quoteId);

    const first = await alice.swaps.submit(preparation.preparationId);
    const second = await alice.swaps.submit(preparation.preparationId);

    expect(second.requestId).toBe(first.requestId);
    expect(first.status).toBe('AWAITING_SETTLEMENT');
    await expect(alice.swaps.listRequests()).resolves.toHaveLength(1);
  });

  it('never promises more output than the constant product allows', async () => {
    const { quote } = await aliceWithQuote();
    // 25000 USDC into 4200000 / 3885000 at 30 bps.
    const netInput = (25000 * (10000 - 30)) / 10000;
    const exact = (3885000 * netInput) / (4200000 + netInput);

    expect(Number(quote.expectedOut)).toBeLessThanOrEqual(exact);
    expect(Number(quote.minOut)).toBeLessThanOrEqual(Number(quote.expectedOut));
  });
});

describe('quote expiry', () => {
  it('refuses to prepare a quote whose window has closed', async () => {
    const { as, demoFor } = world();
    const alice = as('acc-trader-alice');
    const aliceDemo = demoFor('acc-trader-alice');
    const operator = as('acc-operator');

    const onboarding = await alice.onboarding.submitApplication(application);
    await operator.admin.reviewOnboarding(onboarding.id, APPROVAL);
    const prepared = await alice.onboarding.prepareParty(onboarding.id, { publicKey: PUBLIC_KEY });
    await alice.onboarding.confirmParty(onboarding.id, {
      preparationId: prepared.party!.preparationId,
      signature: SIGNATURE,
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await alice.onboarding.mine();
      if (current?.status === 'COMPLETED') break;
    }
    const quote = await aliceDemo.swaps.requestQuote({
      poolId: 'pool-usdc-eurc',
      direction: 'BaseToQuote',
      amountIn: '25000.0000000000',
      slippageBps: 50,
    });

    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(quote.quoteExpiresAt) + 1000);
    try {
      await expect(aliceDemo.swaps.prepare(quote.quoteId)).rejects.toThrow('Quote expired');
    } finally {
      vi.useRealTimers();
    }
  });
});
