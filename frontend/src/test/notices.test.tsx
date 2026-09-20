import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { DexProvider, type Session } from '../app/runtime';
import { TraderOnboarding } from '../features/onboarding/TraderOnboarding';
import { noticesBetween } from '../features/onboarding/notices';
import { testClient } from './clients';
import type { LedgerStep, Onboarding, Profile } from '../lib/api/types';
import '../styles/global.css';

const DAVID: Profile = {
  accountId: 'david',
  displayName: 'David Whitfield',
  role: 'TRADER',
  partyId: null,
};
const CONTRACT_ID = '00a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071829';

function step(overrides: Partial<LedgerStep> & Pick<LedgerStep, 'key'>): LedgerStep {
  return {
    commandId: 'cmd',
    status: 'PENDING',
    contractId: null,
    updateId: null,
    issuer: null,
    ...overrides,
  };
}

function record(overrides: Partial<Onboarding> = {}): Onboarding {
  return {
    id: 'onb-0001',
    accountId: DAVID.accountId,
    application: {
      legalName: 'Whitfield Capital LLC',
      countryCode: 'US',
      documents: [],
      documentReferences: [],
    },
    status: 'AWAITING_REVIEW_AND_PARTY',
    partyMode: 'external',
    createdAt: '2026-09-18T08:00:00Z',
    review: null,
    party: null,
    ledgerSteps: [],
    suggestedPartyHint: 'whitfield',
    ...overrides,
  };
}

const APPROVED = record({
  status: 'AWAITING_PARTY',
  review: {
    decision: 'APPROVED',
    approvedPoolIds: ['pool-usdc-eurc'],
    reviewedBy: 'operator',
    reviewedAt: '2026-09-18T09:00:00Z',
    partyHint: 'whitfield',
  },
});

const REGISTERED = record({
  ...APPROVED,
  status: 'LEDGER_PENDING',
  party: {
    preparationId: 'prep',
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
  ledgerSteps: [step({ key: 'attestation' })],
});

const ATTESTED = record({
  ...REGISTERED,
  status: 'LEDGER_SUBMITTING',
  ledgerSteps: [
    step({ key: 'attestation', status: 'CONFIRMED', contractId: CONTRACT_ID, issuer: 'venue' }),
    step({ key: 'access:pool-usdc-eurc', status: 'SUBMITTING' }),
  ],
});

describe('what counts as news', () => {
  it('says nothing about a record the reader has only just opened', () => {
    expect(noticesBetween(null, ATTESTED)).toEqual([]);
  });

  it('announces an approval without repeating the next action', () => {
    const [notice] = noticesBetween(record(), APPROVED);
    expect(notice?.kind).toBe('approved');
    expect(notice?.title).toBe('Application approved');
    expect(notice?.detail).toBeUndefined();
  });

  it('announces a rejection without offering anything to sign', () => {
    const rejected = record({
      status: 'REJECTED',
      review: {
        decision: 'REJECTED',
        approvedPoolIds: [],
        reviewedBy: 'operator',
        reviewedAt: '2026-09-18T09:00:00Z',
        partyHint: null,
      },
    });
    const [notice] = noticesBetween(record(), rejected);
    expect(notice?.kind).toBe('rejected');
    expect(notice?.contract).toBeUndefined();
  });

  it('announces the party once it is registered, naming it', () => {
    const [notice] = noticesBetween(APPROVED, REGISTERED);
    expect(notice?.kind).toBe('party');
    expect(notice?.detail).toBe('Your party: whitfield::1220aa');
  });

  it('announces the attestation with its contract, even with access pending', () => {
    const [notice] = noticesBetween(REGISTERED, ATTESTED);
    expect(notice?.kind).toBe('attestation');
    expect(notice?.contract).toEqual({ label: 'Attestation contract', value: CONTRACT_ID });
    expect(notice?.detail).toBeUndefined();
  });

  it('says nothing twice for the same change', () => {
    expect(noticesBetween(ATTESTED, ATTESTED)).toEqual([]);
    expect(noticesBetween(APPROVED, APPROVED)).toEqual([]);
  });

  it('carries every change that landed between two readings', () => {
    const kinds = noticesBetween(record(), ATTESTED).map((notice) => notice.kind);
    expect(kinds).toEqual(['approved', 'party', 'attestation']);
  });
});

function renderTrader(answers: Onboarding[]) {
  let call = 0;
  const client = testClient({
    me: () => Promise.resolve(DAVID),
    onboarding: { mine: () => Promise.resolve(answers[Math.min(call++, answers.length - 1)]!) },
    pools: { list: () => Promise.resolve([{ poolId: 'pool-usdc-eurc', name: 'USDC / EURC' }]) },
  });
  const session: Session = { mode: 'keycloak', current: DAVID, loading: false };
  render(
    <DexProvider client={client} session={session}>
      <App />
    </DexProvider>,
  );
  return userEvent.setup();
}

describe('what the trader is shown while they wait', () => {
  it('announces the approval on the screen they are already on', async () => {
    renderTrader([record(), APPROVED]);

    await screen.findByText('Waiting for the venue operator');
    expect(
      await screen.findByText('Application approved', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
  });

  it('puts the announcement where a screen reader will hear it', async () => {
    renderTrader([record(), APPROVED]);

    await screen.findByText('Application approved', {}, { timeout: 15_000 });
    const live = screen.getByRole('status', { name: 'Updates' });
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(within(live).getByText('Application approved')).toBeInTheDocument();
  });

  it('offers the attestation contract to copy, from the announcement itself', async () => {
    renderTrader([REGISTERED, ATTESTED]);

    await screen.findByText('KYC attestation confirmed', {}, { timeout: 15_000 });
    const live = screen.getByRole('status', { name: 'Updates' });
    expect(within(live).getByText(CONTRACT_ID)).toBeInTheDocument();
    expect(within(live).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('can be dismissed, and does not come back on the next poll', async () => {
    const user = renderTrader([record(), APPROVED]);

    await screen.findByText('Application approved', {}, { timeout: 15_000 });
    await user.click(
      screen.getByRole('button', { name: 'Dismiss: Application approved' }),
    );
    expect(screen.queryByText('Application approved')).not.toBeInTheDocument();

    // Several more polls go by, and the reader is not told again.
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    expect(screen.queryByText('Application approved')).not.toBeInTheDocument();
  });

  it('still announces the party after the reader asks for an update', async () => {
    let answer = record();
    const client = testClient({
      me: () => Promise.resolve(DAVID),
      onboarding: { mine: () => Promise.resolve(answer) },
      pools: { list: () => Promise.resolve([]) },
    });
    const session: Session = { mode: 'keycloak', current: DAVID, loading: false };
    render(
      <DexProvider client={client} session={session}>
        <TraderOnboarding />
      </DexProvider>,
    );
    const user = userEvent.setup();
    await screen.findByText('Your onboarding');

    // A reload must not wipe what this screen has already seen, or the change
    // it fetches would read as a first sighting and announce nothing.
    answer = REGISTERED;
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));

    expect(await screen.findByText('Party registered')).toBeInTheDocument();
    expect(screen.getByText('Application approved')).toBeInTheDocument();
  });

  it('says nothing about a record that was already approved when it opened', async () => {
    renderTrader([APPROVED]);

    await screen.findByText('Register your party');
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(screen.queryByText('Application approved')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Updates' }).textContent).toBe('');
  });

  it('keeps the record and the receipt readable after a reload', async () => {
    // A reload is a fresh tree reading the same record from the venue.
    renderTrader([ATTESTED]);
    await screen.findByText('KYC attestation');
    cleanup();
    renderTrader([ATTESTED]);

    // No announcement, because nothing changed while the reader was watching,
    // and the receipt is there to be read instead.
    expect(await screen.findByText('KYC attestation')).toBeInTheDocument();
    expect(screen.getByText(CONTRACT_ID)).toBeInTheDocument();
    expect(screen.queryByText('KYC attestation confirmed')).not.toBeInTheDocument();
  });
});

describe('notices and identity', () => {
  it('never carries one caller’s announcement into another caller’s screen', async () => {
    const first = renderTrader([record(), APPROVED]);
    await screen.findByText('Application approved', {}, { timeout: 15_000 });
    void first;

    // A different caller's screen is a different tree: it starts with nothing
    // to announce, because it has never seen this record change.
    cleanup();
    renderTrader([APPROVED]);

    await screen.findByText('Register your party');
    expect(screen.queryByText('Application approved')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Updates' }).textContent).toBe('');
  });
});
