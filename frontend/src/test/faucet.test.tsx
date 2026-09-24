import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { App } from '../App';
import { describe, expect, it, vi } from 'vitest';
import { DexProvider, type Session } from '../app/runtime';
import { Faucet } from '../features/tokens/Faucet';
import { DomainError, type FaucetResult } from '../lib/api/types';
import type { CantonWallet } from '../wallet/types';
import { testClient } from './clients';
import { testWallet } from './wallets';
import { BALANCES, BTC, onboarded, PREPARATION, PREPARED_HASH, TRADER, USDC } from './venue-fixtures';

const SIGNATURE = 'MEQCIBEiM0RVZneImaq7zN3u/wACIDNEVWZ3iJmqu8zd7v8AESIz';
const CLAIMED: FaucetResult = {
  status: 'COMPLETED', updateId: '1220update99', errorCode: null, error: null,
};

function signingWallet(overrides: Partial<CantonWallet> = {}): CantonWallet {
  return testWallet({
    connect: () => Promise.resolve(),
    signTransaction: () => Promise.resolve({ signature: SIGNATURE, fingerprint: PREPARATION.publicKeyFingerprint }),
    ...overrides,
  });
}

function faucet(parts: Parameters<typeof testClient>[0] = {}, wallet = signingWallet(), content: ReactElement = <Faucet />) {
  const client = testClient({
    ...parts,
    onboarding: { mine: () => Promise.resolve(onboarded()), ...parts.onboarding },
    tokens: { faucetStatus: () => Promise.resolve(CLAIMED), ...parts.tokens },
  });
  const session: Session = { mode: 'keycloak', current: TRADER, loading: false };
  render(<DexProvider client={client} session={session} wallet={wallet}>{content}</DexProvider>);
  return userEvent.setup();
}

function card(title: string): HTMLElement {
  return screen.getByText(title).closest<HTMLElement>('[data-slot="card"]')!;
}

it('opens Faucet below Onboarding and keeps claim controls out of Swap and Liquidity', async () => {
  const faucetStatus = vi.fn(() => Promise.resolve(CLAIMED));
  const user = faucet({
    pools: { list: () => Promise.resolve([]) },
    tokens: { balances: () => Promise.resolve(BALANCES), faucetStatus },
    swaps: { activity: () => Promise.resolve({ items: [], nextCursor: null }) },
  }, signingWallet(), <App />);
  const navigation = within(await screen.findByRole('navigation', { name: 'Sections' }));
  expect(navigation.getAllByRole('button').map((button) => button.textContent)).toEqual([
    'Dashboard', 'Swap', 'Liquidity', 'Onboarding', 'Faucet',
  ]);
  for (const section of ['Swap', 'Liquidity']) {
    await user.click(navigation.getByRole('button', { name: section }));
    expect(await screen.findByRole('heading', { name: 'Balances' })).toBeInTheDocument();
    expect(screen.queryByText('Test tokens claimed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get test tokens' })).not.toBeInTheDocument();
  }
  expect(faucetStatus).not.toHaveBeenCalled();
  await user.click(navigation.getByRole('button', { name: 'Faucet' }));
  expect(await screen.findByRole('heading', { name: 'Faucet' })).toBeInTheDocument();
  expect(await screen.findByText('Test tokens claimed')).toBeInTheDocument();
  expect(navigation.getByRole('button', { name: 'Faucet' })).toHaveAttribute('aria-current', 'page');
});

describe('the development faucet', () => {
  it('claims the bundle the venue named, once, with the trader’s own signature', async () => {
    const prepareFaucetClaim = vi.fn(() =>
      Promise.resolve({
        preparationId: 'prep-faucet-0001',
        preparedTransactionHash: PREPARED_HASH,
        hashEncoding: 'base64',
        hashingSchemeVersion: 3,
        partyId: PREPARATION.partyId,
        publicKeyFingerprint: PREPARATION.publicKeyFingerprint,
        expiresAt: '2099-01-01T00:05:00Z',
        amounts: [
          { instrument: { admin: 'issuer::1220iss', id: 'USDC' }, symbol: 'USDC', decimals: 6, amount: '10000' },
          { instrument: { admin: 'issuer::1220iss', id: 'BTC' }, symbol: 'BTC', decimals: 8, amount: '0.1' },
        ],
      }),
    );
    const submitFaucetClaim = vi.fn(() =>
      Promise.resolve({ status: 'SUBMITTING' as const, updateId: null, errorCode: null, error: null }),
    );

    const user = faucet({
      tokens: {
        balances: () => Promise.resolve(BALANCES),
        faucetStatus: () =>
          Promise.resolve({ status: 'AVAILABLE', updateId: null, errorCode: null, error: null }),
        prepareFaucetClaim,
        submitFaucetClaim,
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Get test tokens' }));

    expect(await screen.findByText('Grants 10,000.00 USDC, 0.10 BTC')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in MetaMask' }));

    await waitFor(() =>
      expect(submitFaucetClaim).toHaveBeenCalledWith({
        preparationId: 'prep-faucet-0001',
        signature: SIGNATURE,
      }),
    );
  });

  it('offers no second claim once the account has had its one bundle', async () => {
    faucet();

    const card = (await screen.findByText('Test tokens')).closest<HTMLElement>('[data-slot="card"]')!;
    expect(await within(card).findByText('Test tokens claimed')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Get test tokens' })).not.toBeInTheDocument();
  });

  it('explains when the venue serves no faucet', async () => {
    faucet({
      tokens: {
        balances: () => Promise.resolve(BALANCES),
        // What the venue answers for a route a deployment does not serve.
        faucetStatus: () => Promise.reject(new DomainError('Resource not found', 'NOT_FOUND')),
      },
    });

    await screen.findByText('Faucet unavailable');
    expect(screen.queryByRole('button', { name: 'Get test tokens' })).not.toBeInTheDocument();
    expect(screen.queryByText('One test-token claim')).not.toBeInTheDocument();
  });
});

describe('a faucet claim whose reply never arrives', () => {
  function faucetPreparation() {
    return {
      preparationId: 'prep-faucet-0001',
      preparedTransactionHash: PREPARED_HASH,
      hashEncoding: 'base64',
      hashingSchemeVersion: 3,
      partyId: PREPARATION.partyId,
      publicKeyFingerprint: PREPARATION.publicKeyFingerprint,
      expiresAt: '2099-01-01T00:05:00Z',
      amounts: [
        { instrument: USDC, symbol: 'USDC', decimals: 6, amount: '10000' },
        { instrument: BTC, symbol: 'BTC', decimals: 8, amount: '0.1' },
      ],
    };
  }

  it('closes signing while the outcome is unknown, even when the status read also fails', async () => {
    const prepared: FaucetResult = {
      status: 'PREPARED',
      updateId: null,
      errorCode: null,
      error: null,
    };
    let answer: () => Promise<FaucetResult> = () => Promise.resolve(prepared);
    const submitFaucetClaim = vi.fn(() =>
      Promise.reject(new Error('The venue could not be reached.')),
    );
    const signTransaction = vi.fn<CantonWallet['signTransaction']>(() =>
      Promise.resolve({ signature: SIGNATURE, fingerprint: PREPARATION.publicKeyFingerprint }),
    );

    const user = faucet(
      {
        tokens: {
          balances: () => Promise.resolve(BALANCES),
          faucetStatus: () => answer(),
          prepareFaucetClaim: () => Promise.resolve(faucetPreparation()),
          submitFaucetClaim,
        },
      },
      signingWallet({ signTransaction }),
    );

    await user.click(await screen.findByRole('button', { name: 'Get test tokens' }));
    await user.click(await screen.findByRole('button', { name: 'Sign in MetaMask' }));

    // The status read fails too, so nothing new is known about the claim.
    answer = () => Promise.reject(new Error('The venue could not be reached.'));

    expect(await screen.findByText('Claim sent, outcome unknown')).toBeInTheDocument();
    // The cached PREPARED status must not put a signing button back.
    expect(screen.queryByRole('button', { name: 'Sign in MetaMask' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get test tokens' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(submitFaucetClaim).toHaveBeenCalledTimes(1);

    // The venue answers at last, and its answer is what is shown.
    answer = () => Promise.resolve(CLAIMED);
    await user.click(screen.getByRole('button', { name: 'Check again' }));

    expect(await within(card('Test tokens')).findByText('Test tokens claimed')).toBeInTheDocument();
    expect(screen.queryByText('Claim sent, outcome unknown')).not.toBeInTheDocument();
    expect(submitFaucetClaim).toHaveBeenCalledTimes(1);
  });

  it('watches a pending claim until it completes', async () => {
    let status: FaucetResult = {
      status: 'SUBMITTING',
      updateId: null,
      errorCode: null,
      error: null,
    };

    faucet({
      tokens: { faucetStatus: () => Promise.resolve(status) },
    });

    expect(await screen.findByText('Submitting')).toBeInTheDocument();

    status = CLAIMED;

    expect(
      await within(card('Test tokens')).findByText('Test tokens claimed', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
  });
});
