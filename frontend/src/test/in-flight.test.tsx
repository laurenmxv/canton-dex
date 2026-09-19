import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DexProvider, type Session } from '../app/runtime';
import type { DemoApi } from '../lib/api/demo';
import { SwapRequestFlow } from '../features/swap/SwapRequestFlow';
import type { Profile } from '../lib/api/types';
import { createFixtureBackend } from '../mocks/client';
import { fieldValue } from './flows';
import '../styles/global.css';

const ALICE: Profile = {
  accountId: 'acc-trader-alice',
  displayName: 'Alice Carter',
  role: 'TRADER',
  partyId: null,
};
const PUBLIC_KEY = 'MCowBQYDK2VwAyEAdGVzdC1wdWJsaWMta2V5LWJ5dGVzLWZvci1maXh0dXJl';

/** A promise the test opens by hand, so a reply can be held mid-flight. */
function gate() {
  let open = () => {};
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { held, open: () => open() };
}

/** Onboards Alice for one pool, then hands back her client. */
async function tradingAlice() {
  const backend = createFixtureBackend({ latencyMs: 0 });
  const alice = backend.clientFor(ALICE.accountId)!;
  const operator = backend.clientFor('acc-operator')!;

  const onboarding = await alice.client.onboarding.submitApplication({
    legalName: 'Acme Trading Ltd',
    countryCode: 'PT',
    documentReferences: ['doc://kyc/acme/incorporation'],
  });
  await operator.client.admin.reviewOnboarding(onboarding.id, {
    decision: 'APPROVED',
    approvedPoolIds: ['pool-usdc-eurc', 'pool-cc-usdc'],
    partyHint: 'acme_trading',
  });
  const prepared = await alice.client.onboarding.prepareParty(onboarding.id, {
    publicKey: PUBLIC_KEY,
  });
  await alice.client.onboarding.confirmParty(onboarding.id, {
    preparationId: prepared.party!.preparationId,
    signature: 'c2lnbmF0dXJlLWZvci10aGlzLXByZXBhcmF0aW9u',
  });
  let settled = await alice.client.onboarding.mine();
  for (let attempt = 0; attempt < 12 && settled?.status !== 'COMPLETED'; attempt += 1) {
    settled = await alice.client.onboarding.mine();
  }
  expect(settled?.status).toBe('COMPLETED');
  return alice;
}

function renderSwap(demo: DemoApi, client = createFixtureBackend({ latencyMs: 0 }).clientFor(ALICE.accountId)!.client) {
  const session: Session = { mode: 'demo', current: ALICE, loading: false };
  render(
    <DexProvider client={client} session={session} demo={demo}>
      <SwapRequestFlow onGoToOnboarding={() => {}} />
    </DexProvider>,
  );
  return userEvent.setup();
}

describe('a reply that arrives late', () => {
  it('reviews the quote the venue answered, not the form as it now stands', async () => {
    const alice = await tradingAlice();
    const held = gate();
    const demo: DemoApi = {
      ...alice.demo,
      swaps: {
        ...alice.demo.swaps,
        requestQuote: async (input) => {
          await held.held;
          return alice.demo.swaps.requestQuote(input);
        },
      },
    };
    const user = renderSwap(demo);

    await user.type(await screen.findByLabelText('Amount in (USDC)'), '25000');
    await user.click(screen.getByRole('button', { name: 'Request quote' }));

    // The terms are locked while the venue answers them.
    await waitFor(() => expect(screen.getByLabelText('Direction')).toBeDisabled());
    expect(screen.getByLabelText('Pool')).toBeDisabled();
    expect(screen.getByLabelText('Amount in (USDC)')).toBeDisabled();

    held.open();

    await screen.findByText('Expected output', { selector: 'dt' });
    expect(fieldValue('Direction')).toBe('USDC to EURC');
    expect(fieldValue('Amount in')).toBe('25,000.00 USDC');
    expect(fieldValue('Expected output')).toMatch(/ EURC$/);
    expect(fieldValue('Fee')).toMatch(/ USDC · 30 bps$/);
  });

  it('reads the terms off the quote even when they differ from the request', async () => {
    const alice = await tradingAlice();
    const demo: DemoApi = {
      ...alice.demo,
      swaps: {
        ...alice.demo.swaps,
        // The venue answered a different pool and direction than the form asked.
        requestQuote: async () =>
          alice.demo.swaps.requestQuote({
            poolId: 'pool-cc-usdc',
            direction: 'QuoteToBase',
            amountIn: '500.0000000000',
            slippageBps: 50,
          }),
      },
    };
    const user = renderSwap(demo);

    await user.type(await screen.findByLabelText('Amount in (USDC)'), '25000');
    await user.click(screen.getByRole('button', { name: 'Request quote' }));

    await screen.findByText('Expected output', { selector: 'dt' });
    expect(fieldValue('Pool')).toBe('CC / USDC');
    expect(fieldValue('Direction')).toBe('USDC to CC');
    expect(fieldValue('Amount in')).toBe('500.00 USDC');
    expect(fieldValue('Expected output')).toMatch(/ CC$/);
    expect(fieldValue('Fee')).toMatch(/ USDC · 5 bps$/);
  });

  it('never borrows the form\u2019s pool for a quote it cannot resolve', async () => {
    const alice = await tradingAlice();
    const demo: DemoApi = {
      ...alice.demo,
      swaps: {
        ...alice.demo.swaps,
        // A quote naming a pool this caller cannot see.
        requestQuote: async (input) => ({
          ...(await alice.demo.swaps.requestQuote(input)),
          poolId: 'pool-vanished',
        }),
      },
    };
    const user = renderSwap(demo);

    await user.type(await screen.findByLabelText('Amount in (USDC)'), '25000');
    await user.click(screen.getByRole('button', { name: 'Request quote' }));

    await screen.findByText('Expected output', { selector: 'dt' });
    // The identifier is shown plainly, and no pool's name or fee is invented.
    expect(fieldValue('Pool')).toBe('pool-vanished');
    expect(fieldValue('Fee')).not.toMatch(/bps/);
    expect(screen.queryByText('USDC / EURC')).not.toBeInTheDocument();
  });
});

describe('starting over', () => {
  it('does not greet the next attempt with the last one\u2019s error', async () => {
    const alice = await tradingAlice();
    let failNext = true;
    const demo: DemoApi = {
      ...alice.demo,
      swaps: {
        ...alice.demo.swaps,
        prepare: async (quoteId) => {
          if (failNext) {
            failNext = false;
            throw new Error('The venue refused that quote');
          }
          return alice.demo.swaps.prepare(quoteId);
        },
      },
    };
    const user = renderSwap(demo);

    await user.type(await screen.findByLabelText('Amount in (USDC)'), '25000');
    await user.click(screen.getByRole('button', { name: 'Request quote' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm these details' }));
    expect(await screen.findByText('The venue refused that quote')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Change amount' }));
    await user.type(await screen.findByLabelText('Amount in (USDC)'), '1000');
    await user.click(screen.getByRole('button', { name: 'Request quote' }));

    await screen.findByText('Expected output', { selector: 'dt' });
    expect(screen.queryByText('The venue refused that quote')).not.toBeInTheDocument();
  });
});

describe('a submission already on its way', () => {
  it('cannot be cancelled, and registers exactly one request', async () => {
    const alice = await tradingAlice();
    const held = gate();
    const demo: DemoApi = {
      ...alice.demo,
      swaps: {
        ...alice.demo.swaps,
        submit: async (preparationId) => {
          await held.held;
          return alice.demo.swaps.submit(preparationId);
        },
      },
    };
    const user = renderSwap(demo);

    await user.type(await screen.findByLabelText('Amount in (USDC)'), '25000');
    await user.click(screen.getByRole('button', { name: 'Request quote' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm these details' }));
    await user.click(await screen.findByRole('button', { name: 'Approve and submit' }));

    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toBeDisabled());
    await user.click(cancel);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    held.open();

    await screen.findByText('Request', { selector: 'dt' });
    expect(fieldValue('Status')).toBe('Awaiting settlement');
    await expect(alice.demo.swaps.listRequests()).resolves.toHaveLength(1);
  });

  it('holds the way back while a preparation is still in flight', async () => {
    const alice = await tradingAlice();
    const held = gate();
    const demo: DemoApi = {
      ...alice.demo,
      swaps: {
        ...alice.demo.swaps,
        prepare: async (quoteId) => {
          await held.held;
          return alice.demo.swaps.prepare(quoteId);
        },
      },
    };
    const user = renderSwap(demo);

    await user.type(await screen.findByLabelText('Amount in (USDC)'), '25000');
    await user.click(screen.getByRole('button', { name: 'Request quote' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm these details' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Change amount' })).toBeDisabled(),
    );

    held.open();

    expect(await screen.findByText('Simulated wallet approval')).toBeInTheDocument();
  });
});
