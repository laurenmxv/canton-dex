import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { DexProvider, type Session } from '../app/runtime';
import type { DexClient } from '../lib/api/port';
import type { Onboarding, Profile } from '../lib/api/types';
import { goTo } from './flows';
import '../styles/global.css';

const TRADER: Profile = { accountId: 'acc-trader-alice', displayName: 'Alice Carter', role: 'TRADER', partyId: null };
const OPERATOR: Profile = {
  accountId: 'acc-operator',
  displayName: 'Venue Operations',
  role: 'OPERATOR',
  partyId: null,
};

/** Every call rejects unless the test overrides it. */
function brokenClient(
  overrides: {
    onboarding?: Partial<DexClient['onboarding']>;
    pools?: Partial<DexClient['pools']>;
    admin?: Partial<DexClient['admin']>;
  } = {},
): DexClient {
  const fail = () => Promise.reject(new Error('The venue is unreachable'));
  const ok = <T,>(value: T) => () => Promise.resolve(value);
  return {
    me: fail,
    onboarding: {
      mine: fail,
      submitApplication: fail,
      prepareParty: fail,
      confirmParty: fail,
      get: fail,
      ...overrides.onboarding,
    },
    pools: {
      list: ok([]),
      get: fail,
      ...overrides.pools,
    },
    admin: {
      listOnboardings: fail,
      reviewOnboarding: fail,
      poolCreationOptions: fail,
      listPoolProposals: fail,
      createPoolProposal: fail,
      getPoolProposal: fail,
      withdrawPoolProposal: fail,
      listPools: fail,
      ...overrides.admin,
    },
  } as DexClient;
}

function renderAs(profile: Profile, client: DexClient) {
  const session: Session = { mode: 'demo', current: profile, loading: false };
  render(
    <DexProvider client={client} session={session}>
      <App />
    </DexProvider>,
  );
  return userEvent.setup();
}

describe('when the venue is unreachable', () => {
  it('reports a failed onboarding read and offers a retry', async () => {
    const mine = vi.fn(() => Promise.reject(new Error('The venue is unreachable')));
    const user = renderAs(TRADER, brokenClient({ onboarding: { mine } }));
    await goTo(user, 'Onboarding');

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('The venue is unreachable')).toBeInTheDocument();

    const before = mine.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mine.mock.calls.length).toBeGreaterThan(before);
  });

  it('reports a failed pool list rather than claiming no pools exist', async () => {
    const request: Onboarding = {
      id: 'onb-0001',
      accountId: 'acc-trader-alice',
      application: {
        legalName: 'Acme Trading Ltd',
        countryCode: 'PT',
        documents: [],
        documentReferences: ['doc://x'],
      },
      status: 'AWAITING_REVIEW_AND_PARTY',
      partyMode: 'external',
      createdAt: '2026-09-16T08:30:00Z',
      review: null,
      party: null,
      ledgerSteps: [],
      suggestedPartyHint: 'acme_trading',
    };
    const user = renderAs(
      OPERATOR,
      brokenClient({
        admin: { listOnboardings: () => Promise.resolve([request]) },
        pools: { list: () => Promise.reject(new Error('The venue is unreachable')) },
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Acme Trading Ltd' }));

    expect(await screen.findByText('Could not load pools')).toBeInTheDocument();
    expect(screen.queryByText('No pools exist yet')).not.toBeInTheDocument();
  });

  it('reports a failed pool catalogue on the dashboard instead of hiding the card', async () => {
    renderAs(
      TRADER,
      brokenClient({
        onboarding: { mine: () => Promise.resolve(null) },
        pools: { list: () => Promise.reject(new Error('The venue is unreachable')) },
      }),
    );

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Pools open to you')).toBeInTheDocument();
    expect(screen.queryByText('No pools yet')).not.toBeInTheDocument();
  });
});
