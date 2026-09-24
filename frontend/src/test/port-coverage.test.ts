import { describe, expect, it } from 'vitest';
import type { DemoApi, DemoControls } from '../lib/api/demo';
import type { DexClient } from '../lib/api/port';
import { createFixtureBackend } from '../mocks/client';

/**
 * Exercises the whole backend surface through the fixture.
 *
 * The webapp never calls the business API directly, so this is the only place
 * that proves every method behind the port works end to end. It also fails if
 * a method is added to `DexClient` and left unexercised.
 */
type Calls = Set<string>;

function recording<T extends object>(target: T, prefix: string, calls: Calls): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(target)) {
    wrapped[name] =
      typeof value === 'function'
        ? (...args: unknown[]) => {
            calls.add(`${prefix}${name}`);
            return (value as (...rest: unknown[]) => unknown)(...args);
          }
        : value;
  }
  return wrapped as T;
}

function instrument(client: DexClient, calls: Calls): DexClient {
  return {
    ...recording({ me: client.me, activity: client.activity }, '', calls),
    onboarding: recording(client.onboarding, 'onboarding.', calls),
    pools: recording(client.pools, 'pools.', calls),
    swaps: recording(client.swaps, 'swaps.', calls),
    lp: recording(client.lp, 'lp.', calls),
    tokens: recording(client.tokens, 'tokens.', calls),
    admin: {
      ...recording(client.admin, 'admin.', calls),
      settlements: recording(client.admin.settlements, 'admin.settlements.', calls),
    },
  } as DexClient;
}

function instrumentDemo(demo: DemoApi, calls: Calls): DemoApi {
  return {
    onboarding: recording(demo.onboarding, 'demo.onboarding.', calls),
    pools: recording(demo.pools, 'demo.pools.', calls),
    swaps: recording(demo.swaps, 'demo.swaps.', calls),
  };
}

function names(client: DexClient, demo: DemoApi, controls: DemoControls): string[] {
  return [
    'me',
    'activity',
    ...Object.keys(client.onboarding).map((key) => `onboarding.${key}`),
    ...Object.keys(client.pools).map((key) => `pools.${key}`),
    ...Object.keys(client.swaps).map((key) => `swaps.${key}`),
    ...Object.keys(client.lp).map((key) => `lp.${key}`),
    ...Object.keys(client.tokens).map((key) => `tokens.${key}`),
    // `settlements` is the nested surface below, not an operation of its own.
    ...Object.keys(client.admin)
      .filter((key) => key !== 'settlements')
      .map((key) => `admin.${key}`),
    ...Object.keys(client.admin.settlements).map((key) => `admin.settlements.${key}`),
    ...Object.keys(demo.onboarding).map((key) => `demo.onboarding.${key}`),
    ...Object.keys(demo.pools).map((key) => `demo.pools.${key}`),
    ...Object.keys(demo.swaps).map((key) => `demo.swaps.${key}`),
    ...Object.keys(controls).map((key) => `controls.${key}`),
  ];
}

/** Walks onboarding, pool creation and a swap request, touching every method. */
async function walkEveryFlow(calls: Calls) {
  const backend = createFixtureBackend({ latencyMs: 0 });
  const controls = recording(backend.controls, 'controls.', calls);

  const rawAlice = backend.clientFor('acc-trader-alice');
  const rawOperator = backend.clientFor('acc-operator');
  expect(rawAlice).not.toBeNull();
  expect(rawOperator).not.toBeNull();
  const alice = instrument(rawAlice!.client, calls);
  const operator = instrument(rawOperator!.client, calls);
  const aliceDemo = instrumentDemo(rawAlice!.demo, calls);
  const operatorDemo = instrumentDemo(rawOperator!.demo, calls);

  // Who am I, and who else can this demo act as.
  expect(await alice.me()).toMatchObject({ role: 'TRADER' });
  expect(await operator.me()).toMatchObject({ role: 'OPERATOR' });
  expect(await controls.listIdentities()).toHaveLength(3);

  // Flow 1: onboarding, party binding before review.
  expect(await alice.onboarding.mine()).toBeNull();
  const created = await alice.onboarding.submitApplication({
    legalName: 'Acme Trading Ltd',
    countryCode: 'PT',
    documents: [
      {
        id: '11111111-0000-4000-8000-000000000001',
        category: 'IDENTITY',
        fileName: 'passport.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 182_311,
        simulated: true,
      },
    ],
  });
  expect(await alice.onboarding.get(created.id)).toMatchObject({ id: created.id });
  expect(await alice.pools.list()).toContainEqual(
    expect.objectContaining({ poolId: 'pool-usdc-eurc' }),
  );

  const queue = await operator.admin.listOnboardings();
  expect(queue.length).toBeGreaterThan(1);
  // The queue carries whole records, so the operator opens one without a second read.
  expect(queue.find((item) => item.id === created.id)?.status).toBe('AWAITING_REVIEW_AND_PARTY');
  await operator.admin.reviewOnboarding(created.id, {
    decision: 'APPROVED',
    approvedPoolIds: ['pool-usdc-eurc'],
    partyHint: 'dex_acme_trading',
  });

  // The trader registers their own party. A real one signs in their wallet;
  // the demo has none, so it stands in for one below the port.
  const registered = await aliceDemo.onboarding.registerParty(created.id);
  expect(registered.party?.confirmed).toBe(true);

  // Both underlying calls are idempotent for the key already prepared, which
  // is what a reload or a second tab does.
  const prepared = await alice.onboarding.prepareParty(created.id, {
    publicKey: registered.party!.publicKey!,
  });
  await alice.onboarding.confirmParty(created.id, {
    preparationId: prepared.party!.preparationId,
    signature: 'c2lnbmF0dXJlLWZvci10aGlzLXByZXBhcmF0aW9u',
  });

  let settled = await alice.onboarding.mine();
  for (let attempt = 0; attempt < 10 && settled?.status !== 'COMPLETED'; attempt += 1) {
    settled = await alice.onboarding.mine();
  }
  expect(settled?.status).toBe('COMPLETED');

  // The venue's own pool administration has no demo world behind it: the demo
  // creates pools through its own approvals, which is a different thing.
  const unavailable = [
    () => operator.admin.poolCreationOptions(),
    () => operator.admin.listPoolProposals(),
    () =>
      operator.admin.createPoolProposal({
        name: 'CC / EURC',
        baseInstrumentId: { admin: 'issuer::1220', id: 'CC' },
        quoteInstrumentId: { admin: 'issuer::1220', id: 'EURC' },
        feeBps: '20',
      }),
    () => operator.admin.getPoolProposal('prop-0001'),
    () => operator.admin.withdrawPoolProposal('prop-0001'),
    () => operator.admin.listPools(),
    () => alice.pools.get('pool-usdc-eurc'),
    // The demo signs nothing and settles nothing, so it serves none of the
    // venue's real swap, balance or settlement routes either.
    () =>
      alice.swaps.quote({
        poolId: 'pool-usdc-eurc',
        direction: 'BaseToQuote',
        amountIn: '1',
        slippageBps: 50,
      }),
    () =>
      alice.swaps.prepare({
        quoteId: 'quote-0001',
        minOut: '1',
        settlementDeadline: '2026-09-19T12:10:00Z',
      }),
    () => alice.swaps.submit({ preparationId: 'prep-0001', signature: 'c2ln' }),
    () => alice.swaps.get('swap-0001'),
    () => alice.swaps.prepareCancellation('swap-0001'),
    () => alice.swaps.submitCancellation('swap-0001', { preparationId: 'p', signature: 'c2ln' }),
    () => alice.swaps.activity(),
    () => alice.activity(),
    // Nor does it hold LP, so none of the liquidity routes either.
    () =>
      alice.lp.quoteDeposit({
        poolId: 'pool-usdc-eurc',
        maxBaseAmount: '1',
        maxQuoteAmount: '1',
        slippageBps: 50,
      }),
    () =>
      alice.lp.prepareDeposit({
        quoteId: 'quote-0001',
        minLpOut: '1',
        minRatio: '1',
        maxRatio: '1',
        settlementDeadline: '2026-09-19T12:10:00Z',
      }),
    () => alice.lp.submitDeposit({ preparationId: 'p', signature: 'c2ln' }),
    () => alice.lp.getDeposit('deposit-0001'),
    () => alice.lp.quoteWithdrawal({ poolId: 'pool-usdc-eurc', lpAmount: '1', slippageBps: 50 }),
    () =>
      alice.lp.prepareWithdrawal({
        quoteId: 'quote-0001',
        minBaseOut: '1',
        minQuoteOut: '1',
        settlementDeadline: '2026-09-19T12:10:00Z',
      }),
    () => alice.lp.submitWithdrawal({ preparationId: 'p', signature: 'c2ln' }),
    () => alice.lp.getWithdrawal('withdraw-0001'),
    () => alice.lp.positions(),
    () => alice.lp.deposits(),
    () => alice.lp.withdrawals(),
    () => alice.lp.prepareDepositCancellation('deposit-0001'),
    () => alice.lp.submitDepositCancellation('deposit-0001', { preparationId: 'p', signature: 'c2ln' }),
    () => alice.lp.prepareWithdrawalCancellation('withdraw-0001'),
    () =>
      alice.lp.submitWithdrawalCancellation('withdraw-0001', { preparationId: 'p', signature: 'c2ln' }),
    () => alice.tokens.balances(),
    () => alice.tokens.faucetStatus(),
    () => alice.tokens.prepareFaucetClaim(),
    () => alice.tokens.submitFaucetClaim({ preparationId: 'p', signature: 'c2ln' }),
    () => operator.admin.settlements.requests('pool-usdc-eurc'),
    () =>
      operator.admin.settlements.setDeferred(
        'pool-usdc-eurc',
        { type: 'swap', requestId: 'swap-0001' },
        true,
      ),
    () => operator.admin.settlements.preview('pool-usdc-eurc', 'swap'),
    () =>
      operator.admin.settlements.previewRequest('pool-usdc-eurc', { type: 'deposit', requestId: 'deposit-0001' }),
    () => operator.admin.settlements.list('pool-usdc-eurc'),
    () => operator.admin.settlements.history('pool-usdc-eurc', { type: 'deposit' }),
    () => operator.admin.settlements.get('settle-0001'),
    () =>
      operator.admin.settlements.run('pool-usdc-eurc', {
        idempotencyKey: '11111111-0000-4000-8000-000000000099',
      }),
    () => operator.admin.settlements.policy('pool-usdc-eurc', 'swap'),
    () =>
      operator.admin.settlements.updatePolicy('pool-usdc-eurc', 'deposit', {
        automaticEnabled: true,
        batchSize: 3,
        expectedVersion: 1,
      }),
    () => operator.admin.settlements.monitoring('pool-usdc-eurc'),
  ];
  for (const call of unavailable) {
    await expect(call()).rejects.toThrow(/does not serve/);
  }

  // Flow 2: pool creation, gated on every required approval.
  const instruments = await operatorDemo.pools.listInstruments();
  expect(instruments.length).toBeGreaterThan(0);
  const proposal = await operatorDemo.pools.createProposal({
    name: 'CC / EURC',
    baseInstrumentId: 'inst-cc',
    quoteInstrumentId: 'inst-eurc',
    feeBps: 20,
    baseReserve: '100000',
    quoteReserve: '95000',
  });
  expect(await operatorDemo.pools.listProposals()).toContainEqual(
    expect.objectContaining({ proposalId: proposal.proposalId }),
  );
  await expect(operatorDemo.pools.requestCreation(proposal.proposalId)).rejects.toThrow(
    'Missing pool approvals',
  );
  for (const approver of ['venueGovernance', 'lpTokenIssuer', 'poolHoldings'] as const) {
    await controls.approveAsCounterparty(proposal.proposalId, approver);
  }
  expect((await operatorDemo.pools.getProposal(proposal.proposalId)).status).toBe('READY');
  const finalized = await operatorDemo.pools.requestCreation(proposal.proposalId);
  expect(finalized.poolId).not.toBeNull();
  expect(await operatorDemo.pools.list()).toContainEqual(
    expect.objectContaining({ poolId: finalized.poolId }),
  );

  // Flow 3: a swap request that ends awaiting settlement.
  const eligible = await aliceDemo.swaps.eligiblePools();
  expect(eligible.map((pool) => pool.poolId)).toEqual(['pool-usdc-eurc']);
  const quote = await aliceDemo.swaps.requestQuote({
    poolId: 'pool-usdc-eurc',
    direction: 'BaseToQuote',
    amountIn: '25000',
    slippageBps: 50,
  });
  const preparation = await aliceDemo.swaps.prepare(quote.quoteId);
  const request = await aliceDemo.swaps.submit(preparation.preparationId);
  expect(request.status).toBe('AWAITING_SETTLEMENT');
  expect(await aliceDemo.swaps.listRequests()).toHaveLength(1);

  // The demo control that puts the world back.
  await controls.reset();

  return { client: rawAlice!.client, demo: rawAlice!.demo, controls: backend.controls };
}

describe('backend surface behind the port', () => {
  it('serves all three flows through the fixture', async () => {
    const calls: Calls = new Set();
    await walkEveryFlow(calls);
    expect(calls.size).toBeGreaterThan(0);
  });

  it('leaves no method of the port unexercised', async () => {
    const calls: Calls = new Set();
    const { client, demo, controls } = await walkEveryFlow(calls);

    const untouched = names(client, demo, controls).filter((name) => !calls.has(name));
    expect(untouched).toEqual([]);
  });
});
