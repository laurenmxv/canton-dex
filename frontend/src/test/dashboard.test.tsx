import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { DexProvider, type Session } from '../app/runtime';
import type { DemoApi } from '../lib/api/demo';
import type { DexClient } from '../lib/api/port';
import type { Pool, Profile, SwapRequest } from '../lib/api/types';
import { createFixtureBackend } from '../mocks/client';
import {
  approveForPool,
  goTo,
  LEDGER_WAIT,
  onboardAlice,
  openRow,
  registerParty,
  submitApplication,
} from './flows';
import { renderApp } from './harness';
import '../styles/global.css';

const ALICE: Profile = { accountId: 'acc-trader-alice', displayName: 'Alice Carter', role: 'TRADER', partyId: null };

function card(title: string): HTMLElement {
  return screen.getByText(title).closest('section')!;
}

describe('the trader dashboard', () => {
  it('is where a trader lands, and names the first thing to do', async () => {
    renderApp();

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(await screen.findByText('Start your onboarding')).toBeInTheDocument();
    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start onboarding' })).toBeInTheDocument();
  });

  it('reports nothing to show before the venue grants anything', async () => {
    renderApp();

    await screen.findByText('Start your onboarding');
    expect(within(card('Pools open to you')).getByText('No pools yet')).toBeInTheDocument();
    expect(within(card('Your swap requests')).getByText('No requests yet')).toBeInTheDocument();
  });

  it('sends the trader to onboarding, and back once they can trade', async () => {
    const { user, actAs } = renderApp();

    await user.click(await screen.findByRole('button', { name: 'Start onboarding' }));
    expect(await screen.findByText('Submit your application')).toBeInTheDocument();

    await onboardAlice(user, actAs);
    await goTo(user, 'Dashboard');

    expect(await screen.findByText('You can trade')).toBeInTheDocument();
    expect(screen.getByText('One pool is open to you.')).toBeInTheDocument();
    expect(within(card('Pools open to you')).getByText('USDC / EURC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request swap' })).toBeInTheDocument();
  });

  it('shows a swap submitted elsewhere as soon as the trader returns', async () => {
    const { user, actAs } = renderApp();
    await onboardAlice(user, actAs);

    await goTo(user, 'Dashboard');
    expect(within(card('Your swap requests')).getByText('No requests yet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Request swap' }));
    await user.type(await screen.findByLabelText('Amount in (USDC)'), '25000');
    await user.click(screen.getByRole('button', { name: 'Request quote' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm these details' }));
    await user.click(await screen.findByRole('button', { name: 'Approve and submit' }));
    await screen.findByText('Request', { selector: 'dt' });

    await goTo(user, 'Dashboard');

    const requests = within(card('Your swap requests'));
    const row = (await requests.findByText('USDC / EURC')).closest('tr')!;
    expect(within(row).getByText('25,000.00 USDC')).toBeInTheDocument();
    expect(within(row).getByText('Awaiting settlement')).toBeInTheDocument();
    // Nothing is settled and nothing is credited.
    expect(requests.queryByText(/received|credited|balance/i)).not.toBeInTheDocument();
  });

  it('opens the pools as the ledger finishes, without navigating away', async () => {
    const { user, actAs } = renderApp();

    await submitApplication(user);
    await actAs('Venue Operations');
    await openRow(user, 'Acme Trading Ltd');
    await approveForPool(user, 'USDC / EURC');
    await actAs('Alice Carter');
    await goTo(user, 'Onboarding');
    await registerParty(user);
    await goTo(user, 'Dashboard');

    // The poll completes the onboarding; the pool list has to follow it, on
    // this screen, without the reader navigating away and back.
    expect(await screen.findByText('You can trade', {}, LEDGER_WAIT)).toBeInTheDocument();
    expect(
      await within(card('Pools open to you')).findByText('USDC / EURC', {}, LEDGER_WAIT),
    ).toBeInTheDocument();
    expect(screen.getByText('One pool is open to you.')).toBeInTheDocument();
  });

  it('never carries one trader’s requests onto another’s dashboard', async () => {
    const { user, actAs } = renderApp();
    await onboardAlice(user, actAs);

    await goTo(user, 'Dashboard');
    await user.click(screen.getByRole('button', { name: 'Request swap' }));
    await user.type(await screen.findByLabelText('Amount in (USDC)'), '25000');
    await user.click(screen.getByRole('button', { name: 'Request quote' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm these details' }));
    await user.click(await screen.findByRole('button', { name: 'Approve and submit' }));
    await screen.findByText('Request', { selector: 'dt' });

    await actAs('Bob Sullivan');

    // Before Bob's own answer lands, Alice's record is already off the screen.
    expect(screen.queryByText('You can trade')).not.toBeInTheDocument();
    expect(screen.queryByText('USDC / EURC')).not.toBeInTheDocument();

    await goTo(user, 'Dashboard');

    // Bob has his own request and none of Alice's grants.
    expect(await screen.findByText('Waiting for the venue operator')).toBeInTheDocument();
    expect(within(card('Your swap requests')).getByText('No requests yet')).toBeInTheDocument();
    expect(within(card('Pools open to you')).getByText('No pools yet')).toBeInTheDocument();
  });
});

describe('a dashboard the venue cannot serve', () => {
  function brokenDashboard(overrides: {
    onboarding?: Partial<DexClient['onboarding']>;
    pools?: Partial<DexClient['pools']>;
    swaps?: Partial<DemoApi['swaps']>;
  }) {
    const backend = createFixtureBackend({ latencyMs: 0 });
    const alice = backend.clientFor(ALICE.accountId)!;
    const client: DexClient = {
      ...alice.client,
      onboarding: { ...alice.client.onboarding, ...overrides.onboarding },
      pools: { ...alice.client.pools, ...overrides.pools },
    };
    const demo: DemoApi = {
      ...alice.demo,
      swaps: { ...alice.demo.swaps, ...overrides.swaps },
    };
    const session: Session = { mode: 'demo', current: ALICE, loading: false };
    render(
      <DexProvider client={client} session={session} demo={demo}>
        <App />
      </DexProvider>,
    );
    return userEvent.setup();
  }

  it('reports a failed pool catalogue without claiming there are none', async () => {
    brokenDashboard({
      pools: { list: () => Promise.reject(new Error('The venue is unreachable')) },
    });

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('The venue is unreachable')).toBeInTheDocument();
    expect(screen.queryByText('No pools yet')).not.toBeInTheDocument();
  });

  it('reports a failed request list and offers a retry', async () => {
    let attempts = 0;
    const user = brokenDashboard({
      swaps: {
        listRequests: () => {
          attempts += 1;
          return Promise.reject(new Error('The venue is unreachable'));
        },
      },
    });

    const failed = (await screen.findAllByText('Something went wrong'))[0]!;
    await user.click(within(failed.closest('section')!).getByRole('button', { name: 'Try again' }));
    expect(attempts).toBeGreaterThan(1);
    expect(screen.queryByText('No requests yet')).not.toBeInTheDocument();
  });

  it('keeps the page when the onboarding call fails, and offers a retry', async () => {
    let attempts = 0;
    const user = brokenDashboard({
      onboarding: {
        mine: () => {
          attempts += 1;
          return Promise.reject(new Error('The venue is unreachable'));
        },
      },
    });

    // The rest of the screen survives, so the reader keeps their bearings.
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Pools open to you')).toBeInTheDocument();
    // Nothing claims a next step the venue never reported.
    expect(screen.queryByText('Start your onboarding')).not.toBeInTheDocument();

    const failed = screen.getByText('Something went wrong').closest('section')!;
    await user.click(within(failed).getByRole('button', { name: 'Try again' }));
    expect(attempts).toBeGreaterThan(1);
  });

  it('marks amounts as raw identifiers when instrument names fail', async () => {
    const pool: Pool = {
      poolId: 'pool-1',
      name: 'USDC / EURC',
      baseInstrumentId: 'inst-usdc',
      quoteInstrumentId: 'inst-eurc',
      feeBps: 30,
      baseReserve: '1000.0',
      quoteReserve: '1000.0',
      lpTokenSupply: '1000.0',
      createdAt: '2026-09-17T08:00:00Z',
    };
    const request: SwapRequest = {
      requestId: 'req-1',
      poolId: 'pool-1',
      poolName: 'USDC / EURC',
      trader: ALICE.accountId,
      direction: 'BaseToQuote',
      amountIn: '25000.0',
      minOut: '24000.0',
      expectedOut: '24900.0',
      status: 'AWAITING_SETTLEMENT',
      submittedAt: '2026-09-17T09:00:00Z',
      settlementDeadline: '2026-09-17T10:00:00Z',
    };
    brokenDashboard({
      swaps: {
        eligiblePools: () => Promise.resolve([pool]),
        listRequests: () => Promise.resolve([request]),
      },
    });

    // The demo's own card carries the request; the venue serves no swap route.
    expect(await screen.findByText('USDC / EURC')).toBeInTheDocument();
    expect(screen.getByText(/Simulated by the demo/)).toBeInTheDocument();
  });
});
