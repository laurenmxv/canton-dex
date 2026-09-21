import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DexProvider, type Session } from '../app/runtime';
import { TraderOnboarding } from '../features/onboarding/TraderOnboarding';
import type { DemoApi } from '../lib/api/demo';
import type { DexClient } from '../lib/api/port';
import { DomainError, type Onboarding, type PartyPreparation, type Profile } from '../lib/api/types';
import { hexToBase64 } from '../wallet/encoding';
import { createMetaMaskWallet } from '../wallet/metamask';
import { WalletError, type CantonWallet } from '../wallet/types';
import { testClient } from './clients';
import { testWallet } from './wallets';
import { renderApp } from './harness';
import { approveForPool, goTo, openRow, submitApplication } from './flows';

const DAVID: Profile = {
  accountId: 'david',
  displayName: 'David Whitfield',
  role: 'TRADER',
  partyId: null,
};
const SECP_SPKI = hexToBase64(`3036301006072a8648ce3d020106052b8104000a03220002${'11'.repeat(32)}`);
/** A second wallet key, for the index that does not match the preparation. */
const OTHER_SPKI = hexToBase64(`3036301006072a8648ce3d020106052b8104000a03220002${'33'.repeat(32)}`);
const ED_SPKI = hexToBase64(`302a300506032b6570032100${'22'.repeat(32)}`);
const MULTIHASH = hexToBase64(`1220${'ab'.repeat(32)}`);
const SIGNATURE = hexToBase64(`3044022011${'00'.repeat(31)}022022${'00'.repeat(31)}`);

function party(overrides: Partial<PartyPreparation> = {}): PartyPreparation {
  return {
    preparationId: 'prep-0001',
    partyId: 'whitfield::1220aa',
    confirmed: false,
    publicKey: SECP_SPKI,
    publicKeyFingerprint: '1220aa',
    multiHash: MULTIHASH,
    synchronizerId: 'global-domain::1220dd',
    status: 'PREPARED',
    participantId: 'venue-participant::1220pp',
    topologyTransactions: ['CgUKA2Fh'],
    ...overrides,
  };
}

function approved(overrides: Partial<Onboarding> = {}): Onboarding {
  return {
    id: 'onb-0001',
    accountId: DAVID.accountId,
    application: {
      legalName: 'Whitfield Capital LLC',
      countryCode: 'US',
      documents: [],
      documentReferences: [],
    },
    status: 'AWAITING_PARTY',
    partyMode: 'external',
    createdAt: '2026-09-18T08:00:00Z',
    review: {
      decision: 'APPROVED',
      approvedPoolIds: ['pool-usdc-eurc'],
      reviewedBy: 'operator',
      reviewedAt: '2026-09-18T09:00:00Z',
      partyHint: 'whitfield',
    },
    party: null,
    ledgerSteps: [],
    suggestedPartyHint: 'whitfield',
    ...overrides,
  };
}

/** The demo surfaces, present but never reached from this screen. */
function unusedDemoApi(): DemoApi {
  const refuse = () => Promise.reject(new Error('this screen must not use the demo surfaces'));
  return {
    pools: {
      list: refuse,
      get: refuse,
      propose: refuse,
      approve: refuse,
      requestCreation: refuse,
      listProposals: refuse,
      getProposal: refuse,
    },
    swaps: { quote: refuse, prepare: refuse, submit: refuse, listRequests: refuse },
    onboarding: { registerParty: refuse },
  } as unknown as DemoApi;
}

/**
 * The disclosure that holds what a reader only needs when something is wrong.
 *
 * It is a collapsible region, so it has to be opened before anything inside it
 * is on the screen at all.
 */
async function openDetails(user: UserEvent): Promise<HTMLElement> {
  const region = screen.queryByRole('region', { name: 'Key details' });
  if (region) return region;
  await user.click(screen.getByRole('button', { name: 'Key details' }));
  return screen.findByRole('region', { name: 'Key details' });
}

function stubWallet(overrides: Partial<CantonWallet> = {}): CantonWallet {
  return testWallet({
    connect: () => Promise.resolve(),
    publicKey: () => Promise.resolve({ publicKey: SECP_SPKI, fingerprint: '1220aa' }),
    signTopology: () => Promise.resolve({ signature: SIGNATURE, fingerprint: '1220aa' }),
    ...overrides,
  });
}

function renderWallet(
  onboarding: Onboarding,
  wallet: CantonWallet,
  client: Partial<DexClient['onboarding']> = {},
  mode: Session['mode'] = 'keycloak',
) {
  const full = testClient({
    me: () => Promise.resolve(DAVID),
    onboarding: { mine: () => Promise.resolve(onboarding), ...client },
    pools: { list: () => Promise.resolve([]) },
  });
  const session: Session = { mode, current: DAVID, loading: false };
  // What makes a screen simulated is the demo surface, so the demo case has to
  // carry one for its assertions to mean anything.
  const demo = mode === 'demo' ? unusedDemoApi() : null;
  render(
    <DexProvider client={full} session={session} wallet={wallet} demo={demo}>
      <TraderOnboarding />
    </DexProvider>,
  );
  return userEvent.setup();
}

describe('connecting the wallet', () => {
  it('offers one control, and asks for nothing until it is clicked', async () => {
    const connect = vi.fn(() => Promise.resolve());
    const publicKey = vi.fn(() => Promise.resolve({ publicKey: SECP_SPKI, fingerprint: '1220aa' }));
    const user = renderWallet(approved(), stubWallet({ connect, publicKey }));

    expect(await screen.findByRole('button', { name: 'Connect MetaMask' })).toBeInTheDocument();
    // Rendering and polling must never open the wallet on their own.
    expect(connect).not.toHaveBeenCalled();
    expect(publicKey).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Connect MetaMask' }));

    expect(connect).toHaveBeenCalledTimes(1);
    // The fingerprint is one of the key details, which the reader opens.
    expect(within(await openDetails(user)).getByText('1220aa')).toBeInTheDocument();
  });

  it('tells the reader when MetaMask is not there, without claiming anything worked', async () => {
    const user = renderWallet(
      approved(),
      stubWallet({
        connect: () =>
          Promise.reject(new WalletError('missing', 'MetaMask was not found in this browser.')),
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));

    expect(await screen.findByText(/MetaMask was not found/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare party' })).not.toBeInTheDocument();
  });

  it('asks for no key once the reader has left while it installs', async () => {
    let release!: () => void;
    const connect = vi.fn(async () => {
      await new Promise<void>((resolve) => (release = resolve));
    });
    const publicKey = vi.fn(() => Promise.resolve({ publicKey: SECP_SPKI, fingerprint: '1220aa' }));
    const user = renderWallet(approved(), stubWallet({ connect, publicKey }));

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));
    expect(connect).toHaveBeenCalledTimes(1);

    // Signing out is what unmounts the screen while MetaMask is still busy.
    cleanup();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(publicKey).not.toHaveBeenCalled();
  });

  it('keeps one key index field, so a two-digit index can be typed', async () => {
    const publicKey = vi.fn((index: number) =>
      Promise.resolve({ publicKey: SECP_SPKI, fingerprint: `1220${index}` }),
    );
    const user = renderWallet(approved(), stubWallet({ publicKey }));

    await screen.findByText('Key details');
    const index = within(await openDetails(user)).getByLabelText('Canton key index');
    await user.type(index, '123');

    expect(index).toHaveValue(123);
    await user.click(screen.getByRole('button', { name: 'Connect MetaMask' }));
    expect(publicKey).toHaveBeenCalledWith(123);
  });

  it('drops a mismatch complaint with the index it was about', async () => {
    const publicKey = vi.fn((index: number) =>
      Promise.resolve({ publicKey: index === 0 ? OTHER_SPKI : SECP_SPKI, fingerprint: '1220aa' }),
    );
    const user = renderWallet(approved({ party: party() }), stubWallet({ publicKey }));

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));
    await user.click(await screen.findByRole('button', { name: 'Sign and register with MetaMask' }));
    expect(await screen.findByText(/prepared with a different key/i)).toBeInTheDocument();

    await user.type(within(await openDetails(user)).getByLabelText('Canton key index'), '1');

    expect(screen.queryByText(/prepared with a different key/i)).not.toBeInTheDocument();
  });

  it('drops the derived key when the index changes, and derives the new one', async () => {
    const publicKey = vi.fn((index: number) =>
      Promise.resolve({ publicKey: SECP_SPKI, fingerprint: `1220${index}` }),
    );
    const user = renderWallet(approved(), stubWallet({ publicKey }));

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));

    // The key and the index it came from are both key details.
    const details = await openDetails(user);
    expect(within(details).getByText('12200')).toBeInTheDocument();

    await user.type(within(details).getByLabelText('Canton key index'), '123');

    // The key on screen belonged to the old index, so it is gone with it.
    expect(within(details).queryByText('12200')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect MetaMask' }));

    expect(publicKey).toHaveBeenLastCalledWith(123);
    expect(await within(await openDetails(user)).findByText('1220123')).toBeInTheDocument();
  });

  it('repeats a refusal in the wallet’s own words, and claims nothing worked', async () => {
    const user = renderWallet(
      approved(),
      stubWallet({
        connect: () =>
          Promise.reject(
            new WalletError('snap', 'MetaMask could not install the Canton Snap: it said no.'),
          ),
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));

    expect(await screen.findByText(/it said no\./)).toBeInTheDocument();
    // A later step can fail after a successful install, so no blanket claim
    // about what did or did not happen belongs here.
    expect(screen.queryByText(/Nothing was installed/)).not.toBeInTheDocument();
  });
});

describe('preparing and signing', () => {
  it('prepares with the key the wallet exported, then signs the venue’s hash', async () => {
    const prepareParty = vi.fn(() => Promise.resolve(approved({ party: party() })));
    const confirmParty = vi.fn(() =>
      Promise.resolve(approved({ party: party({ confirmed: true, status: 'CONFIRMED' }) })),
    );
    const signTopology = vi.fn(() =>
      Promise.resolve({ signature: SIGNATURE, fingerprint: '1220aa' }),
    );
    const user = renderWallet(approved(), stubWallet({ signTopology }), {
      prepareParty,
      confirmParty,
    });

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));
    await user.click(await screen.findByRole('button', { name: 'Prepare party' }));

    expect(prepareParty).toHaveBeenCalledWith('onb-0001', { publicKey: SECP_SPKI });
  });

  it('submits the signature the wallet produced, for the preparation it was given', async () => {
    const confirmParty = vi.fn(() => Promise.resolve(approved({ party: party({ confirmed: true }) })));
    const signTopology = vi.fn(() =>
      Promise.resolve({ signature: SIGNATURE, fingerprint: '1220aa' }),
    );
    const user = renderWallet(approved({ party: party() }), stubWallet({ signTopology }), {
      confirmParty,
    });

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));
    await user.click(
      await screen.findByRole('button', { name: 'Sign and register with MetaMask' }),
    );

    expect(signTopology).toHaveBeenCalledWith(MULTIHASH, 0);
    expect(confirmParty).toHaveBeenCalledWith('onb-0001', {
      preparationId: 'prep-0001',
      signature: SIGNATURE,
    });
  });

  it('submits nothing when the reader dismisses the wallet prompt', async () => {
    const confirmParty = vi.fn(() => Promise.reject(new Error('should not be called')));
    const user = renderWallet(
      approved({ party: party() }),
      stubWallet({
        signTopology: () =>
          Promise.reject(new WalletError('rejected', 'You dismissed the MetaMask prompt.')),
      }),
      { confirmParty },
    );

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));
    await user.click(
      await screen.findByRole('button', { name: 'Sign and register with MetaMask' }),
    );

    expect(await screen.findByText(/Nothing was sent to the venue/)).toBeInTheDocument();
    expect(confirmParty).not.toHaveBeenCalled();
  });

  it('refuses to sign for a preparation made with another key', async () => {
    const confirmParty = vi.fn(() => Promise.reject(new Error('should not be called')));
    const otherKey = hexToBase64(`3036301006072a8648ce3d020106052b8104000a03220002${'99'.repeat(32)}`);
    const user = renderWallet(
      approved({ party: party({ publicKey: otherKey }) }),
      stubWallet(),
      { confirmParty },
    );

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));
    await user.click(
      await screen.findByRole('button', { name: 'Sign and register with MetaMask' }),
    );

    expect(await screen.findByText(/prepared with a different key/)).toBeInTheDocument();
    expect(confirmParty).not.toHaveBeenCalled();
  });

  it('refuses a signature whose fingerprint is not the prepared one', async () => {
    const confirmParty = vi.fn(() => Promise.reject(new Error('should not be called')));
    const user = renderWallet(
      approved({ party: party() }),
      stubWallet({
        signTopology: () => Promise.resolve({ signature: SIGNATURE, fingerprint: '1220ff' }),
      }),
      { confirmParty },
    );

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));
    await user.click(
      await screen.findByRole('button', { name: 'Sign and register with MetaMask' }),
    );

    expect(await screen.findByText(/signed with a different key/)).toBeInTheDocument();
    expect(confirmParty).not.toHaveBeenCalled();
  });

  it('asks the wallet once however many times the button is clicked', async () => {
    let release: (() => void) | undefined;
    const signTopology = vi.fn(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { signature: SIGNATURE, fingerprint: '1220aa' };
    });
    const confirmParty = vi.fn(() => Promise.resolve(approved({ party: party({ confirmed: true }) })));
    const user = renderWallet(approved({ party: party() }), stubWallet({ signTopology }), {
      confirmParty,
    });

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));
    const sign = await screen.findByRole('button', { name: 'Sign and register with MetaMask' });
    await user.click(sign);
    await user.click(sign);
    await user.click(sign);

    expect(signTopology).toHaveBeenCalledTimes(1);
    release!();
    await waitFor(() => expect(confirmParty).toHaveBeenCalledTimes(1));
  });
});

describe('a development snap', () => {
  const local = { snapId: 'local:http://localhost:4040', version: '1.0.0', local: true };

  it('asks for Flask in one line, and keeps the id out of the way', async () => {
    const user = renderWallet(approved(), stubWallet({ target: local }));

    expect(await screen.findByText('This build requires MetaMask Flask.')).toBeInTheDocument();
    // The id is a detail, not a heading, and nothing explains key derivation.
    expect(within(await openDetails(user)).getByText('local:http://localhost:4040@1.0.0')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/derives|seed|Ethereum/i);
  });

  it('says nothing of Flask for the published snap', async () => {
    const user = renderWallet(approved(), stubWallet());

    expect(await screen.findByRole('button', { name: 'Connect MetaMask' })).toBeInTheDocument();
    expect(screen.queryByText(/Flask/)).not.toBeInTheDocument();
    expect(within(await openDetails(user)).getByText('npm:@chainsafe/canton-snap@1.0.0')).toBeInTheDocument();
  });
});

describe('a preparation the venue is still settling', () => {
  it('refreshes a rejected registration and keeps the conflict after reload', async () => {
    const conflict = approved({ status: 'PARTY_CONFLICT', party: party({ status: 'CONFLICT' }) });
    let current = approved({ party: party() });
    const confirmParty = vi.fn(async () => {
      current = conflict;
      throw new DomainError(
        'This party already exists. Registration was stopped.',
        'CONFLICT',
        'PARTY_ALREADY_EXISTS',
      );
    });
    const signTopology = vi.fn(async () => ({ signature: SIGNATURE, fingerprint: '1220aa' }));
    const wallet = stubWallet({ signTopology });
    const mine = vi.fn(() => Promise.resolve(current));
    const user = renderWallet(current, wallet, {
      mine,
      confirmParty,
    });
    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));
    await user.click(await screen.findByRole('button', { name: 'Sign and register with MetaMask' }));
    await waitFor(() => {
      expect(mine).toHaveBeenCalledTimes(2);
      expect(screen.getByText('This party already exists. Registration was stopped.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Sign and register/ })).not.toBeInTheDocument();
    });
    cleanup();
    renderWallet(conflict, wallet, { confirmParty });
    expect(await screen.findByText('This party already exists. Registration was stopped.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect MetaMask|Sign and register/ })).not.toBeInTheDocument();
    expect(confirmParty).toHaveBeenCalledTimes(1);
    expect(signTopology).toHaveBeenCalledTimes(1);
  });

  it.each(['pending', 'failed'] as const)(
    'stops signing immediately when the conflict refresh is %s',
    async (refresh) => {
      const current = approved({ party: party() });
      const mine = vi.fn<DexClient['onboarding']['mine']>()
        .mockResolvedValueOnce(current)
        .mockImplementation(() =>
          refresh === 'pending'
            ? new Promise<Onboarding>(() => {})
            : Promise.reject(new Error('Refresh unavailable')),
        );
      const confirmParty = vi.fn(async () => {
        throw new DomainError(
          'This party already exists. Registration was stopped.',
          'CONFLICT',
          'PARTY_ALREADY_EXISTS',
        );
      });
      const signTopology = vi.fn(async () => ({ signature: SIGNATURE, fingerprint: '1220aa' }));
      const user = renderWallet(current, stubWallet({ signTopology }), { mine, confirmParty });

      await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));
      await user.click(await screen.findByRole('button', { name: 'Sign and register with MetaMask' }));

      expect(await screen.findByText('This party already exists. Registration was stopped.')).toBeInTheDocument();
      await waitFor(() => expect(mine).toHaveBeenCalledTimes(2));
      if (refresh === 'failed') {
        expect(await screen.findByText('Refresh unavailable')).toBeInTheDocument();
      }
      expect(screen.queryByRole('button', { name: /Connect MetaMask|Sign and register/ })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Canton key index')).not.toBeInTheDocument();
      expect(signTopology).toHaveBeenCalledTimes(1);
      expect(confirmParty).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['SUBMITTING' as const, 'Registering'],
    ['UNRESOLVED' as const, 'Confirming'],
  ])('offers no second signature while it is %s', async (status, expected) => {
    const signTopology = vi.fn(() => Promise.reject(new Error('must not be asked')));
    const confirmParty = vi.fn(() => Promise.reject(new Error('must not be called')));
    renderWallet(approved({ party: party({ status }) }), stubWallet({ signTopology }), {
      confirmParty,
    });

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect MetaMask/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign and register/ })).not.toBeInTheDocument();
    expect(signTopology).not.toHaveBeenCalled();
    expect(confirmParty).not.toHaveBeenCalled();
  });
});

describe('a request prepared before wallets', () => {
  it('says the key cannot be signed here, and offers nothing else', async () => {
    renderWallet(approved({ party: party({ publicKey: ED_SPKI }) }), stubWallet());

    expect(await screen.findByText('Prepared with a key MetaMask cannot sign')).toBeInTheDocument();
    expect(screen.getByText(/start a new request/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect MetaMask' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/external-party-signer|Signer response/);
  });
});

describe('the demo', () => {
  it('never reaches for a wallet, even with one wired', async () => {
    const connect = vi.fn(() => Promise.reject(new Error('the demo must not call this')));
    const publicKey = vi.fn(() => Promise.reject(new Error('the demo must not call this')));
    const signTopology = vi.fn(() => Promise.reject(new Error('the demo must not call this')));
    renderWallet(
      approved(),
      stubWallet({ connect, publicKey, signTopology }),
      {},
      'demo',
    );

    // The demo's own path, which never opens a wallet.
    expect(
      await screen.findByRole('button', { name: 'Simulate registration' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect MetaMask' })).not.toBeInTheDocument();
    expect(connect).not.toHaveBeenCalled();
    expect(publicKey).not.toHaveBeenCalled();
    expect(signTopology).not.toHaveBeenCalled();
  });

  it('wires no wallet at all through the demo runtime', async () => {
    const { user, actAs } = renderApp();

    await submitApplication(user);
    await actAs('Venue Operations');
    await openRow(user, 'Acme Trading Ltd');
    await approveForPool(user, 'USDC / EURC');
    await actAs('Alice Carter');
    await goTo(user, 'Onboarding');

    expect(
      await screen.findByRole('button', { name: 'Simulate registration' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect MetaMask' })).not.toBeInTheDocument();
  });
});

describe('when the reader leaves while the wallet is holding on', () => {
  it('registers nothing for an actor who is gone', async () => {
    let release!: () => void;
    const signTopology = vi.fn(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { signature: SIGNATURE, fingerprint: '1220aa' };
    });
    const confirmParty = vi.fn(() => Promise.resolve(approved({ party: party({ confirmed: true }) })));
    const user = renderWallet(approved({ party: party() }), stubWallet({ signTopology }), {
      confirmParty,
    });

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));
    await user.click(await screen.findByRole('button', { name: 'Sign and register with MetaMask' }));
    expect(signTopology).toHaveBeenCalledTimes(1);

    // Signing out is what unmounts the screen under the open dialog.
    cleanup();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(confirmParty).not.toHaveBeenCalled();
  });
});

describe('what MetaMask itself refused', () => {
  it('shows the reason the provider gave, not [object Object]', async () => {
    // The shape a provider rejects with: a plain object, the sentence that
    // names the cause nested under the one that says the request failed.
    const scope = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      ethereum: {
        isMetaMask: true,
        request: () =>
          Promise.reject({
            code: -32603,
            message: 'Internal JSON-RPC error.',
            data: {
              cause: {
                message:
                  'Failed to fetch snap "npm:@chainsafe/canton-snap": Snap icon must be a valid SVG.',
              },
            },
          }),
      },
    } as unknown as Window;
    const user = renderWallet(approved(), createMetaMaskWallet(scope));

    await user.click(await screen.findByRole('button', { name: 'Connect MetaMask' }));

    expect(await screen.findByText(/Snap icon must be a valid SVG/)).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
    // Nothing on screen may guess at a cause the wallet did not give.
    expect(screen.queryByText(/allow/i)).not.toBeInTheDocument();
  });
});
