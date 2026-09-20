import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { DexProvider, type Session } from '../app/runtime';
import type { DemoApi } from '../lib/api/demo';
import type { DexClient } from '../lib/api/port';
import type { CantonWallet } from '../wallet/types';
import { testClient } from './clients';
import { testWallet } from './wallets';
import { TraderOnboarding } from '../features/onboarding/TraderOnboarding';
import type { LedgerStep, Onboarding, Profile } from '../lib/api/types';
import '../styles/global.css';

const DAVID: Profile = {
  accountId: 'b2e4f6a8-0000-4000-8000-000000000002',
  displayName: 'David Whitfield',
  role: 'TRADER',
  partyId: 'whitfield::1220aa',
};

const CONTRACT_ID = '00a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f';

function step(overrides: Partial<LedgerStep> & Pick<LedgerStep, 'key'>): LedgerStep {
  return {
    commandId: 'cmd-0001',
    status: 'PENDING',
    contractId: null,
    updateId: null,
    issuer: null,
    ...overrides,
  };
}

function onboardingWith(steps: LedgerStep[], status: Onboarding['status']): Onboarding {
  return {
    id: 'onb-0001',
    accountId: DAVID.accountId,
    application: {
      legalName: 'Whitfield Capital LLC',
      countryCode: 'US',
      documents: [],
      documentReferences: [],
    },
    status,
    partyMode: 'external',
    createdAt: '2026-09-18T08:00:00Z',
    review: {
      decision: 'APPROVED',
      approvedPoolIds: ['pool-usdc-eurc'],
      reviewedBy: 'acc-operator',
      reviewedAt: '2026-09-18T09:00:00Z',
      partyHint: 'whitfield',
    },
    party: {
      preparationId: 'prep-0001',
      partyId: 'whitfield::1220aa',
      confirmed: true,
      publicKey: 'MCowBQYDK2Vw',
      publicKeyFingerprint: '1220aa',
      multiHash: '1220ff',
      synchronizerId: 'global-domain::1220dd',
      status: 'CONFIRMED',
      participantId: 'venue-participant::1220pp',
      topologyTransactions: ['CgUKA2Fh'],
    },
    ledgerSteps: steps,
    suggestedPartyHint: 'whitfield',
  };
}

const CONFIRMED_ATTESTATION = step({
  key: 'attestation',
  status: 'CONFIRMED',
  contractId: CONTRACT_ID,
  updateId: '1220update01',
  issuer: 'venue-operator::1220beef',
});

function renderDashboard(mine: () => Promise<Onboarding | null>) {
  const client = testClient({
    me: () => Promise.resolve(DAVID),
    onboarding: { mine },
    pools: { list: () => Promise.resolve([{ poolId: 'pool-usdc-eurc', name: 'USDC / EURC' }]) },
  });
  const session: Session = { mode: 'keycloak', current: DAVID, loading: false };
  render(
    <DexProvider client={client} session={session}>
      <App />
    </DexProvider>,
  );
}

describe('the attestation receipt', () => {
  it('carries the whole contract identifier, its issuer, the party and the pools', async () => {
    renderDashboard(() =>
      Promise.resolve(
        onboardingWith(
          [CONFIRMED_ATTESTATION, step({ key: 'access:pool-usdc-eurc', status: 'SUBMITTING' })],
          'LEDGER_SUBMITTING',
        ),
      ),
    );

    const receipt = (await screen.findByText('KYC attestation')).closest('section')!;
    // The full identifier, not a shortened one a reader could not use.
    expect(within(receipt).getByText(CONTRACT_ID)).toBeInTheDocument();
    expect(within(receipt).getByText('venue-operator::1220beef')).toBeInTheDocument();
    expect(within(receipt).getByText('whitfield::1220aa')).toBeInTheDocument();
    expect(within(receipt).getByText('USDC / EURC')).toBeInTheDocument();
    expect(within(receipt).getByText('1220update01')).toBeInTheDocument();
  });

  it('appears even while a pool access step is still unresolved', async () => {
    renderDashboard(() =>
      Promise.resolve(
        onboardingWith(
          [CONFIRMED_ATTESTATION, step({ key: 'access:pool-usdc-eurc', status: 'UNRESOLVED' })],
          'LEDGER_UNRESOLVED',
        ),
      ),
    );

    expect(await screen.findByText('KYC attestation')).toBeInTheDocument();
    // The onboarding is not complete, and the screen does not pretend it is.
    expect(screen.getByText('Confirming a ledger command')).toBeInTheDocument();
  });

  it('never labels a real ledger identifier simulated', async () => {
    renderDashboard(() =>
      Promise.resolve(onboardingWith([CONFIRMED_ATTESTATION], 'LEDGER_PENDING')),
    );

    const receipt = (await screen.findByText('KYC attestation')).closest('section')!;
    expect(receipt.textContent).not.toMatch(/simulated|demo/i);
  });

  it('shows nothing before the attestation confirms', async () => {
    renderDashboard(() =>
      Promise.resolve(onboardingWith([step({ key: 'attestation' })], 'LEDGER_PENDING')),
    );

    await screen.findByText('Finishing on the ledger');
    expect(screen.queryByText('KYC attestation')).not.toBeInTheDocument();
  });

  it('announces the confirmation once, and says nothing on a later reload', async () => {
    const answers = [
      onboardingWith([step({ key: 'attestation' })], 'LEDGER_PENDING'),
      onboardingWith([CONFIRMED_ATTESTATION], 'COMPLETED'),
    ];
    let call = 0;
    renderDashboard(() => Promise.resolve(answers[Math.min(call++, answers.length - 1)]!));

    await screen.findByText('Finishing on the ledger');
    expect(screen.queryByText('KYC attestation confirmed')).not.toBeInTheDocument();

    // The poll brings the confirmation in while the reader is looking. It runs
    // on the real three-second interval, and the announcement lands one commit
    // after the record, so both are awaited rather than read synchronously.
    expect(
      await screen.findByText('You can trade', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('KYC attestation confirmed', {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
  });

  it('stays quiet when a reload already finds the attestation', async () => {
    renderDashboard(() => Promise.resolve(onboardingWith([CONFIRMED_ATTESTATION], 'COMPLETED')));

    expect(await screen.findByText('KYC attestation')).toBeInTheDocument();
    expect(screen.queryByText('KYC attestation confirmed')).not.toBeInTheDocument();
  });
});

describe('what the dashboard treats as tradable', () => {
  it('counts only a confirmed access contract, not an approved pool', async () => {
    renderDashboard(() =>
      Promise.resolve(
        onboardingWith(
          [CONFIRMED_ATTESTATION, step({ key: 'access:pool-usdc-eurc', status: 'SUBMITTING' })],
          'LEDGER_SUBMITTING',
        ),
      ),
    );

    const pools = (await screen.findByText('Pools open to you')).closest('section')!;
    expect(within(pools).getByText('No pools yet')).toBeInTheDocument();
    expect(within(pools).queryByText('USDC / EURC')).not.toBeInTheDocument();
  });

  it('opens a pool the moment its access contract confirms', async () => {
    renderDashboard(() =>
      Promise.resolve(
        onboardingWith(
          [
            CONFIRMED_ATTESTATION,
            step({ key: 'access:pool-usdc-eurc', status: 'CONFIRMED', contractId: '00access' }),
          ],
          'COMPLETED',
        ),
      ),
    );

    const pools = (await screen.findByText('Pools open to you')).closest('section')!;
    expect(within(pools).getByText('USDC / EURC')).toBeInTheDocument();
  });
});

describe('work already in flight', () => {
  it('is abandoned when the caller changes, so no answer lands on the wrong screen', async () => {
    const seen: AbortSignal[] = [];
    const client = testClient({
      me: () => Promise.resolve(DAVID),
      onboarding: {
        mine: (options) => {
          if (options?.signal) seen.push(options.signal);
          return new Promise(() => {});
        },
      },
      pools: { list: () => Promise.resolve([]) },
    });
    const session: Session = { mode: 'keycloak', current: DAVID, loading: false };
    const view = render(
      <DexProvider client={client} session={session}>
        <App />
      </DexProvider>,
    );

    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]?.aborted).toBe(false);

    view.unmount();
    expect(seen[0]?.aborted).toBe(true);
  });

  it('asks the venue nothing while the tab is hidden', async () => {
    const mine = vi.fn(() => Promise.resolve(onboardingWith([step({ key: 'attestation' })], 'LEDGER_PENDING')));
    renderDashboard(mine);

    await waitFor(() => expect(mine).toHaveBeenCalled());
    const before = mine.mock.calls.length;

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await new Promise((resolve) => setTimeout(resolve, 3_500));

    expect(mine.mock.calls.length).toBe(before);
    vi.restoreAllMocks();
  });
});

describe('the onboarding screen a trader waits on', () => {
  function renderOnboarding(
    onboarding: Onboarding | (() => Onboarding),
    demo: DemoApi | null = null,
    overrides: Partial<DexClient['onboarding']> = {},
    wallet?: CantonWallet,
  ) {
    const current = typeof onboarding === 'function' ? onboarding : () => onboarding;
    const client = testClient({
      me: () => Promise.resolve(DAVID),
      onboarding: { mine: () => Promise.resolve(current()), ...overrides },
      pools: { list: () => Promise.resolve([{ poolId: 'pool-usdc-eurc', name: 'USDC / EURC' }]) },
    });
    const session: Session = { mode: 'keycloak', current: DAVID, loading: false };
    render(
      <DexProvider client={client} session={session} demo={demo} wallet={wallet}>
        <TraderOnboarding />
      </DexProvider>,
    );
    return userEvent.setup();
  }

  it('reports a completed onboarding as a record, and offers no shortcut of its own', async () => {
    renderOnboarding(onboardingWith([CONFIRMED_ATTESTATION], 'COMPLETED'));

    expect(await screen.findByText('Completed')).toBeInTheDocument();
    // Reaching the swap screen is the sidebar's job, and the dashboard's.
    expect(screen.queryByRole('button', { name: 'Request a swap' })).not.toBeInTheDocument();
  });

  it('carries the receipt on the page the reader is already on', async () => {
    renderOnboarding(
      onboardingWith(
        [CONFIRMED_ATTESTATION, step({ key: 'access:pool-usdc-eurc', status: 'SUBMITTING' })],
        'LEDGER_SUBMITTING',
      ),
    );

    const receipt = (
      await screen.findByRole('heading', { name: 'KYC attestation' })
    ).closest('section')!;
    expect(within(receipt).getByText(CONTRACT_ID)).toBeInTheDocument();
    // KYC evidence is not the same as access, and the card says which is which.
    expect(within(receipt).getByText('USDC / EURC')).toBeInTheDocument();
    expect(
      within(receipt).getByText('Awaiting confirmation'),
    ).toBeInTheDocument();
  });

  it('runs the steps in the order the venue enforces', async () => {
    renderOnboarding(onboardingWith([CONFIRMED_ATTESTATION], 'COMPLETED'));

    await screen.findByText('Completed');
    const titles = Array.from(document.querySelectorAll('.step-title')).map(
      (node) => node.firstChild?.textContent,
    );
    expect(titles).toEqual([
      'Application submitted',
      'Compliance review',
      'Party registration',
      'Ledger confirmations',
    ]);
  });

  it('offers a way back when a refresh fails, without losing what is on screen', async () => {
    const answers: (Onboarding | Error)[] = [
      onboardingWith([step({ key: 'attestation' })], 'LEDGER_PENDING'),
      new Error('The venue is unreachable'),
    ];
    let call = 0;
    const mine = vi.fn(() => {
      const answer = answers[Math.min(call++, answers.length - 1)]!;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    });
    const client = testClient({
      me: () => Promise.resolve(DAVID),
      onboarding: { mine },
      pools: { list: () => Promise.resolve([]) },
    });
    const session: Session = { mode: 'keycloak', current: DAVID, loading: false };
    render(
      <DexProvider client={client} session={session}>
        <TraderOnboarding />
      </DexProvider>,
    );
    const user = userEvent.setup();

    expect(await screen.findByText('Your onboarding')).toBeInTheDocument();
    expect(await screen.findByText('Could not refresh', {}, { timeout: 8_000 })).toBeInTheDocument();
    // The progress the reader was watching is still there.
    expect(screen.getByText('Ledger confirmations')).toBeInTheDocument();

    const before = mine.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mine.mock.calls.length).toBeGreaterThan(before);
  });

  const PREPARED_PARTY = {
    preparationId: 'prep-0001',
    partyId: 'whitfield::1220aa',
    confirmed: false,
    publicKey: 'MCowBQYDK2Vw',
    publicKeyFingerprint: '1220aa',
    multiHash: '1220ff',
    synchronizerId: 'global-domain::1220dd',
    status: 'PREPARED' as const,
    participantId: 'venue-participant::1220pp',
    topologyTransactions: ['CgUKA2Fh'],
  };

  it('says a build with no wallet cannot register, rather than offering another way', async () => {
    renderOnboarding({ ...onboardingWith([], 'AWAITING_PARTY'), party: null });

    expect(await screen.findByText('No wallet configured')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Prepare|Register|Simulate/ })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/external-party-signer|Signer response/);
  });

  it('says an Ed25519 preparation cannot be signed here, and changes nothing', async () => {
    renderOnboarding(
      { ...onboardingWith([], 'AWAITING_PARTY'), party: PREPARED_PARTY },
      null,
      {},
      testWallet(),
    );

    expect(await screen.findByText('Prepared with a key MetaMask cannot sign')).toBeInTheDocument();
    expect(screen.getByText(/start a new request/)).toBeInTheDocument();
    // The party it already holds is untouched, and nothing is resubmitted.
    expect(screen.queryByRole('button', { name: /Prepare|Register|Sign/ })).not.toBeInTheDocument();
  });

  it('never calls a demo identifier real', async () => {
    const demo = { pools: {}, swaps: {} } as unknown as DemoApi;
    renderOnboarding(onboardingWith([CONFIRMED_ATTESTATION], 'COMPLETED'), demo);

    const receipt = (
      await screen.findByRole('heading', { name: 'KYC attestation' })
    ).closest('section')!;
    expect(within(receipt).getByText('Simulated ledger')).toBeInTheDocument();
  });
});
