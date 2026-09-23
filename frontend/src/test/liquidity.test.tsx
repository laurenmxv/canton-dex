import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { DexProvider, KeycloakRuntime, type Session } from '../app/runtime';
import type { AuthAdapter, AuthState } from '../auth/types';
import { LiquidityDesk } from '../features/liquidity/LiquidityDesk';
import { LiquidityHistory } from '../features/liquidity/LiquidityHistory';
import type { DexClient } from '../lib/api/port';
import {
  DomainError,
  type DepositRequest,
  type FaucetResult,
  type LpPositions,
} from '../lib/api/types';
import type { CantonWallet } from '../wallet/types';
import { testClient } from './clients';
import { testWallet } from './wallets';
import {
  ACCESS_REFUSED,
  BALANCES,
  BTC,
  deposit,
  DEPOSIT_PREPARATION,
  DEPOSIT_QUOTE,
  EMPTY_POOL,
  FINGERPRINT,
  LP,
  onboarded,
  position,
  POOL,
  POOL_ID,
  PREPARED_HASH,
  TRADER,
  USDC,
  withdrawal,
  WITHDRAWAL_PREPARATION,
  WITHDRAWAL_QUOTE,
  withoutAccess,
} from './venue-fixtures';

const SIGNATURE = 'MEQCIBEiM0RVZneImaq7zN3u/wACIDNEVWZ3iJmqu8zd7v8AESIz';
const CLAIMED: FaucetResult = { status: 'COMPLETED', updateId: null, errorCode: null, error: null };
const NO_HISTORY = () => Promise.resolve({ items: [], nextCursor: null });

type Parts = Parameters<typeof testClient>[0];

function liquidityClient(parts: Parts = {}): DexClient {
  return testClient({
    me: () => Promise.resolve(TRADER),
    ...parts,
    onboarding: { mine: () => Promise.resolve(onboarded()), ...parts.onboarding },
    pools: {
      list: () => Promise.resolve([{ poolId: POOL_ID, name: POOL.name }]),
      get: () => Promise.resolve(EMPTY_POOL),
      ...parts.pools,
    },
    tokens: {
      balances: () => Promise.resolve(BALANCES),
      faucetStatus: () => Promise.resolve(CLAIMED),
      ...parts.tokens,
    },
    lp: {
      positions: () => Promise.resolve({ items: [], asOfOffset: 4821 }),
      deposits: NO_HISTORY,
      withdrawals: NO_HISTORY,
      ...parts.lp,
    },
  });
}

function signingWallet(overrides: Partial<CantonWallet> = {}): CantonWallet {
  return testWallet({
    connect: () => Promise.resolve(),
    signTransaction: () => Promise.resolve({ signature: SIGNATURE, fingerprint: FINGERPRINT }),
    ...overrides,
  });
}

function desk(parts: Parts = {}, wallet: CantonWallet = signingWallet()) {
  const session: Session = { mode: 'keycloak', current: TRADER, loading: false };
  render(
    <DexProvider client={liquidityClient(parts)} session={session} wallet={wallet}>
      <LiquidityDesk onGoToOnboarding={() => {}} />
    </DexProvider>,
  );
  return userEvent.setup();
}

/** One card's own section, so a label outside it never satisfies a query. */
async function card(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: title });
  return heading.closest<HTMLElement>('[data-slot="card"]')!;
}

async function quoteDeposit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Maximum BTC'), '0.05');
  await user.type(screen.getByLabelText('Maximum USDC'), '3000');
  await user.click(screen.getByRole('button', { name: 'Get a quote' }));
}

describe('where liquidity lives', () => {
  it('is a section of its own for a signed-in trader', async () => {
    const session: Session = { mode: 'keycloak', current: TRADER, loading: false };
    render(
      <DexProvider client={liquidityClient({ swaps: { activity: NO_HISTORY } })} session={session}>
        <App />
      </DexProvider>,
    );
    const user = userEvent.setup();

    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    await user.click(within(nav).getByRole('button', { name: 'Liquidity' }));
    expect(await screen.findByRole('heading', { name: 'Liquidity', level: 1 })).toBeInTheDocument();
  });

  it('signs with the key index chosen at registration, until another principal signs in', async () => {
    let publish: ((state: AuthState) => void) | undefined;
    const signedIn = (subject: string): AuthState => ({
      status: 'authenticated',
      principal: { issuer: 'http://localhost:18082/realms/Dex', subject, username: subject },
      error: null,
    });
    const auth: AuthAdapter = {
      start: async (onChange) => {
        publish = onChange;
        onChange(signedIn('alice'));
      },
      login: async () => {},
      register: async () => {},
      logout: async () => {},
      accessToken: async () => 'stub-token',
    };
    // Approved with no party yet, so onboarding offers the wallet registration.
    let onboarding = onboarded({ status: 'AWAITING_PARTY', party: null, ledgerSteps: [] });
    const signTransaction = vi.fn<CantonWallet['signTransaction']>(() =>
      Promise.resolve({ signature: SIGNATURE, fingerprint: FINGERPRINT }),
    );
    render(
      <KeycloakRuntime
        auth={auth}
        client={liquidityClient({
          onboarding: { mine: () => Promise.resolve(onboarding) },
          lp: {
            quoteDeposit: () => Promise.resolve(DEPOSIT_QUOTE),
            prepareDeposit: () => Promise.resolve(DEPOSIT_PREPARATION),
            submitDeposit: () => Promise.resolve(deposit({ status: 'SUBMITTING' })),
          },
        })}
        wallet={signingWallet({ signTransaction })}
      >
        <App />
      </KeycloakRuntime>,
    );
    const user = userEvent.setup();
    const section = async (name: string) =>
      user.click(
        within(await screen.findByRole('navigation', { name: 'Sections' })).getByRole('button', { name }),
      );

    await section('Onboarding');
    await user.click(await screen.findByRole('button', { name: 'Key details' }));
    const index = await screen.findByLabelText('Canton key index');
    await user.clear(index);
    await user.type(index, '3');

    // The party registered at index 3 is confirmed; that index signs from here on.
    onboarding = onboarded();
    await section('Liquidity');
    await quoteDeposit(user);
    await user.click(await screen.findByRole('button', { name: 'Request deposit' }));
    await waitFor(() => expect(signTransaction).toHaveBeenCalledTimes(1));
    expect(signTransaction.mock.calls[0]?.[1]).toBe(3);

    // Another principal is another reader, whose wallet starts at the first key.
    await act(async () => publish!(signedIn('bob')));
    await section('Liquidity');
    await user.click(await screen.findByRole('button', { name: 'Key details' }));
    expect(await screen.findByLabelText('Canton key index')).toHaveValue(0);
  });
});

describe('a first deposit', () => {
  it('shows the venue’s own terms, including the LP locked in the pool for good', async () => {
    const quoteDepositCall = vi.fn(() => Promise.resolve(DEPOSIT_QUOTE));
    const user = desk({ lp: { quoteDeposit: quoteDepositCall } });

    expect(
      await screen.findByText('Empty pool · initial ratio 60,000.00 USDC per BTC'),
    ).toBeInTheDocument();
    await quoteDeposit(user);

    expect(quoteDepositCall).toHaveBeenCalledWith({
      poolId: POOL_ID,
      maxBaseAmount: '0.05',
      maxQuoteAmount: '3000',
      slippageBps: 50,
    });
    expect(await screen.findByText('Initial ratio')).toBeInTheDocument();
    expect(screen.getByText('Locked in the pool for good')).toBeInTheDocument();
    expect(screen.getByText('0.0000001 LP')).toBeInTheDocument();
    expect(screen.getByText('12.2474486745 LP')).toBeInTheDocument();
  });

  it('prepares with the quote’s bounds unchanged, signs its one hash and submits once', async () => {
    const prepareDeposit = vi.fn(() => Promise.resolve(DEPOSIT_PREPARATION));
    const submitDeposit = vi.fn(() => Promise.resolve(deposit({ status: 'SUBMITTING' })));
    const signTransaction = vi.fn<CantonWallet['signTransaction']>(() =>
      Promise.resolve({ signature: SIGNATURE, fingerprint: FINGERPRINT }),
    );
    const user = desk(
      { lp: { quoteDeposit: () => Promise.resolve(DEPOSIT_QUOTE), prepareDeposit, submitDeposit } },
      signingWallet({ signTransaction }),
    );

    await quoteDeposit(user);
    await user.click(await screen.findByRole('button', { name: 'Request deposit' }));

    await waitFor(() => expect(submitDeposit).toHaveBeenCalledTimes(1));
    // The ratio bounds are the venue's, sent back as given; nothing here edits them.
    expect(prepareDeposit).toHaveBeenCalledWith({
      quoteId: DEPOSIT_QUOTE.quoteId,
      minLpOut: DEPOSIT_QUOTE.minLpOut,
      minRatio: DEPOSIT_QUOTE.minRatio,
      maxRatio: DEPOSIT_QUOTE.maxRatio,
      settlementDeadline: DEPOSIT_QUOTE.settlementDeadline,
    });
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(signTransaction.mock.calls[0]?.[0]).toBe(PREPARED_HASH);
    expect(submitDeposit).toHaveBeenCalledWith({
      preparationId: DEPOSIT_PREPARATION.preparationId,
      signature: SIGNATURE,
    });
    const notice = (await screen.findByText('Request sent')).closest<HTMLElement>('[role="alert"]')!;
    expect(notice.textContent).not.toMatch(/settled|minted|credited/i);
  });

  it('refuses a preparation for another key or another hashing scheme before it reaches the wallet', async () => {
    const signTransaction = vi.fn();
    const submitDeposit = vi.fn();
    const user = desk(
      {
        lp: {
          quoteDeposit: () => Promise.resolve(DEPOSIT_QUOTE),
          prepareDeposit: () =>
            Promise.resolve({ ...DEPOSIT_PREPARATION, hashingSchemeVersion: 2 }),
          submitDeposit,
        },
      },
      signingWallet({ signTransaction }),
    );

    await quoteDeposit(user);
    await user.click(await screen.findByRole('button', { name: 'Request deposit' }));

    expect(await screen.findByText(/hashing scheme 2/)).toBeInTheDocument();
    expect(signTransaction).not.toHaveBeenCalled();
    expect(submitDeposit).not.toHaveBeenCalled();
  });

  it('holds a lost reply as an unknown outcome and never signs it again', async () => {
    let history: DepositRequest[] = [];
    const submitDeposit = vi.fn(() => Promise.reject(new Error('The venue could not be reached.')));
    const signTransaction = vi.fn<CantonWallet['signTransaction']>(() =>
      Promise.resolve({ signature: SIGNATURE, fingerprint: FINGERPRINT }),
    );
    const user = desk(
      {
        lp: {
          quoteDeposit: () => Promise.resolve(DEPOSIT_QUOTE),
          prepareDeposit: () => Promise.resolve(DEPOSIT_PREPARATION),
          submitDeposit,
          deposits: () => Promise.resolve({ items: history, nextCursor: null }),
        },
      },
      signingWallet({ signTransaction }),
    );

    await quoteDeposit(user);
    await user.click(await screen.findByRole('button', { name: 'Request deposit' }));

    expect(await screen.findByText('Sent, outcome unknown')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request deposit' })).toBeDisabled();

    // Seen in history is not resolved: neither status says the submission took effect.
    for (const [status, label] of [
      ['SUBMITTING', 'Submitting'],
      ['PREPARED', 'Awaiting your signature'],
    ] as const) {
      history = [deposit({ status })];
      expect(
        await within(await card('Your deposits')).findByText(label, {}, { timeout: 10_000 }),
      ).toBeInTheDocument();
      expect(screen.getByText('Sent, outcome unknown')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Request deposit' })).toBeDisabled();
    }

    history = [deposit({ status: 'READY' })];

    expect(
      await within(await card('Your deposits')).findByText('Queued for settlement', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Sent, outcome unknown')).not.toBeInTheDocument());
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(submitDeposit).toHaveBeenCalledTimes(1);
  });

  it('treats a submit the venue refused before dispatch as definitive, and offers a new quote', async () => {
    const quoteDepositCall = vi.fn(() => Promise.resolve(DEPOSIT_QUOTE));
    const user = desk({
      lp: {
        quoteDeposit: quoteDepositCall,
        prepareDeposit: () => Promise.resolve(DEPOSIT_PREPARATION),
        submitDeposit: () =>
          Promise.reject(
            new DomainError('Request a new quote', 'CONFLICT', 'PREPARATION_EXPIRED'),
          ),
        deposits: () =>
          Promise.resolve({ items: [deposit({ status: 'PREPARED' })], nextCursor: null }),
      },
    });

    await quoteDeposit(user);
    await user.click(await screen.findByRole('button', { name: 'Request deposit' }));

    expect(await screen.findByText('Signing window closed')).toBeInTheDocument();
    expect(screen.queryByText('Sent, outcome unknown')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request deposit' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Get a quote' }));
    expect(await screen.findByRole('button', { name: 'Request deposit' })).toBeEnabled();
    expect(quoteDepositCall).toHaveBeenCalledTimes(2);
  });

  it('signs with the key index the trader chose', async () => {
    const signTransaction = vi.fn<CantonWallet['signTransaction']>(() =>
      Promise.resolve({ signature: SIGNATURE, fingerprint: FINGERPRINT }),
    );
    const user = desk(
      {
        lp: {
          quoteDeposit: () => Promise.resolve(DEPOSIT_QUOTE),
          prepareDeposit: () => Promise.resolve(DEPOSIT_PREPARATION),
          submitDeposit: () => Promise.resolve(deposit({ status: 'SUBMITTING' })),
        },
      },
      signingWallet({ signTransaction }),
    );

    await user.click(await screen.findByRole('button', { name: 'Key details' }));
    const index = screen.getByLabelText('Canton key index');
    await user.clear(index);
    await user.type(index, '3');
    await quoteDeposit(user);
    await user.click(await screen.findByRole('button', { name: 'Request deposit' }));

    await waitFor(() => expect(signTransaction).toHaveBeenCalledTimes(1));
    expect(signTransaction.mock.calls[0]?.[1]).toBe(3);
  });

  it('reads back an expired preparation’s request, rather than replacing it', async () => {
    const signTransaction = vi.fn();
    const user = desk(
      {
        lp: {
          quoteDeposit: () => Promise.resolve(DEPOSIT_QUOTE),
          prepareDeposit: () =>
            Promise.reject(
              new DomainError('This preparation has expired', 'CONFLICT', 'PREPARATION_EXPIRED'),
            ),
        },
      },
      signingWallet({ signTransaction }),
    );

    await quoteDeposit(user);
    await user.click(await screen.findByRole('button', { name: 'Request deposit' }));

    expect(await screen.findByText('This quote already has a request')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request deposit' })).toBeDisabled();
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('signs nothing once the venue refuses the trader’s pool access', async () => {
    const signTransaction = vi.fn();
    const submitDeposit = vi.fn();
    const user = desk(
      {
        lp: {
          quoteDeposit: () => Promise.resolve(DEPOSIT_QUOTE),
          prepareDeposit: () => Promise.reject(ACCESS_REFUSED),
          submitDeposit,
        },
      },
      signingWallet({ signTransaction }),
    );

    await quoteDeposit(user);
    await user.click(await screen.findByRole('button', { name: 'Request deposit' }));

    expect(await screen.findByText(ACCESS_REFUSED.message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request deposit' })).toBeDisabled();
    expect(signTransaction).not.toHaveBeenCalled();
    expect(submitDeposit).not.toHaveBeenCalled();
  });

  it('treats an access refusal at submit as final, not as an unknown outcome', async () => {
    const submitDeposit = vi.fn(() => Promise.reject(ACCESS_REFUSED));
    const user = desk({
      lp: {
        quoteDeposit: () => Promise.resolve(DEPOSIT_QUOTE),
        prepareDeposit: () => Promise.resolve(DEPOSIT_PREPARATION),
        submitDeposit,
      },
    });

    await quoteDeposit(user);
    await user.click(await screen.findByRole('button', { name: 'Request deposit' }));

    expect(await screen.findByText(ACCESS_REFUSED.message)).toBeInTheDocument();
    expect(screen.queryByText('Sent, outcome unknown')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request deposit' })).not.toBeInTheDocument();
    expect(submitDeposit).toHaveBeenCalledTimes(1);
  });

  it('asks for no deposit into a pool the trader’s current access does not open', async () => {
    desk({
      onboarding: {
        mine: () =>
          Promise.resolve(
            onboarded({
              ledgerSteps: onboarded().ledgerSteps.map((step) => ({
                ...step,
                status: 'PENDING' as const,
              })),
            }),
          ),
      },
    });

    expect(await screen.findByText('No pools are open to you')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get a quote' })).not.toBeInTheDocument();
  });
});

describe('positions and redemption', () => {
  const HELD: LpPositions = { items: [position()], asOfOffset: 4821 };
  const REDEEM = `Remove liquidity · ${POOL.name}`;

  it('lists what the trader owns and redeems it with current pool access', async () => {
    const quoteWithdrawal = vi.fn(() => Promise.resolve(WITHDRAWAL_QUOTE));
    const prepareWithdrawal = vi.fn(() => Promise.resolve(WITHDRAWAL_PREPARATION));
    const submitWithdrawal = vi.fn(() => Promise.resolve(withdrawal({ status: 'SUBMITTING' })));
    const user = desk({
      lp: {
        positions: () => Promise.resolve(HELD),
        quoteWithdrawal,
        prepareWithdrawal,
        submitWithdrawal,
      },
    });

    const table = await card('Your positions');
    expect(await within(table).findByText('91.835%')).toBeInTheDocument();

    await user.click(within(table).getByRole('button', { name: 'Withdraw' }));
    const ticket = await card(REDEEM);
    await user.type(within(ticket).getByLabelText('LP to redeem'), '100');
    await user.click(within(ticket).getByRole('button', { name: 'Get a quote' }));

    expect(quoteWithdrawal).toHaveBeenCalledWith({ poolId: POOL_ID, lpAmount: '100', slippageBps: 50 });
    await user.click(await within(ticket).findByRole('button', { name: 'Request withdrawal' }));

    await waitFor(() => expect(submitWithdrawal).toHaveBeenCalledTimes(1));
    expect(prepareWithdrawal).toHaveBeenCalledWith({
      quoteId: WITHDRAWAL_QUOTE.quoteId,
      minBaseOut: WITHDRAWAL_QUOTE.minBaseOut,
      minQuoteOut: WITHDRAWAL_QUOTE.minQuoteOut,
      settlementDeadline: WITHDRAWAL_QUOTE.settlementDeadline,
    });
  });

  it('still lists a position once pool access lapses, but offers no withdrawal', async () => {
    const quoteWithdrawal = vi.fn();
    const signTransaction = vi.fn();
    const user = desk(
      {
        onboarding: { mine: () => Promise.resolve(withoutAccess()) },
        lp: { positions: () => Promise.resolve(HELD), quoteWithdrawal },
      },
      signingWallet({ signTransaction }),
    );

    expect(await screen.findByText('No pools are open to you')).toBeInTheDocument();
    const table = await card('Your positions');
    expect(await within(table).findByText('91.835%')).toBeInTheDocument();
    const withdraw = within(table).getByRole('button', { name: 'Withdraw' });
    expect(withdraw).toBeDisabled();

    await user.click(withdraw);
    expect(screen.queryByRole('heading', { name: REDEEM })).not.toBeInTheDocument();
    expect(quoteWithdrawal).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('closes an open withdrawal and ignores a late preparation after access disappears', async () => {
    let finish!: (value: typeof WITHDRAWAL_PREPARATION) => void;
    const prepareWithdrawal = vi.fn(() =>
      new Promise<typeof WITHDRAWAL_PREPARATION>((resolve) => { finish = resolve; }),
    );
    const submitWithdrawal = vi.fn();
    const signTransaction = vi.fn();
    const wallet = signingWallet({ signTransaction });
    const session: Session = { mode: 'keycloak', current: TRADER, loading: false };
    const lp = {
      positions: () => Promise.resolve(HELD),
      quoteWithdrawal: () => Promise.resolve(WITHDRAWAL_QUOTE),
      prepareWithdrawal,
      submitWithdrawal,
    };
    const show = (client: DexClient) => (
      <DexProvider client={client} session={session} wallet={wallet}>
        <LiquidityDesk onGoToOnboarding={() => {}} />
      </DexProvider>
    );
    const view = render(show(liquidityClient({ lp })));
    const user = userEvent.setup();
    await user.click(await within(await card('Your positions')).findByRole('button', { name: 'Withdraw' }));
    const ticket = await card(REDEEM);
    await user.type(within(ticket).getByLabelText('LP to redeem'), '100');
    await user.click(within(ticket).getByRole('button', { name: 'Get a quote' }));
    await user.click(await within(ticket).findByRole('button', { name: 'Request withdrawal' }));
    await waitFor(() => expect(prepareWithdrawal).toHaveBeenCalledOnce());

    view.rerender(show(liquidityClient({
      lp,
      onboarding: { mine: () => Promise.resolve(withoutAccess()) },
    })));
    await waitFor(() => expect(screen.queryByRole('heading', { name: REDEEM })).not.toBeInTheDocument());
    await act(async () => finish(WITHDRAWAL_PREPARATION));
    expect(signTransaction).not.toHaveBeenCalled();
    expect(submitWithdrawal).not.toHaveBeenCalled();
  });

  it('signs no withdrawal once the venue refuses the trader’s pool access', async () => {
    const signTransaction = vi.fn();
    const submitWithdrawal = vi.fn();
    const user = desk(
      {
        lp: {
          positions: () => Promise.resolve(HELD),
          quoteWithdrawal: () => Promise.resolve(WITHDRAWAL_QUOTE),
          prepareWithdrawal: () => Promise.reject(ACCESS_REFUSED),
          submitWithdrawal,
        },
      },
      signingWallet({ signTransaction }),
    );

    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const ticket = await card(REDEEM);
    await user.type(within(ticket).getByLabelText('LP to redeem'), '100');
    await user.click(within(ticket).getByRole('button', { name: 'Get a quote' }));
    await user.click(await within(ticket).findByRole('button', { name: 'Request withdrawal' }));

    expect(await within(ticket).findByText(ACCESS_REFUSED.message)).toBeInTheDocument();
    expect(within(ticket).getByRole('button', { name: 'Request withdrawal' })).toBeDisabled();
    expect(signTransaction).not.toHaveBeenCalled();
    expect(submitWithdrawal).not.toHaveBeenCalled();
  });

  it('will not redeem more LP than the position has available', async () => {
    const quoteWithdrawal = vi.fn();
    const user = desk({
      lp: {
        positions: () =>
          Promise.resolve({ items: [position({ availableLp: '10', allocatedLp: '5' })], asOfOffset: 1 }),
        quoteWithdrawal,
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const ticket = await card(REDEEM);
    await user.type(within(ticket).getByLabelText('LP to redeem'), '11');
    await user.click(within(ticket).getByRole('button', { name: 'Get a quote' }));

    expect(await within(ticket).findByText('You have 10.00 LP available.')).toBeInTheDocument();
    expect(quoteWithdrawal).not.toHaveBeenCalled();
  });

  it('reads holdings, positions and the pool again once a request settles, even if the other history fails', async () => {
    let history: DepositRequest[] = [deposit({ status: 'READY' })];
    const positions = vi.fn(() => Promise.resolve(HELD));
    const balances = vi.fn(() => Promise.resolve(BALANCES));
    const get = vi.fn(() => Promise.resolve(EMPTY_POOL));
    desk({
      pools: { get },
      tokens: { balances, faucetStatus: () => Promise.resolve(CLAIMED) },
      lp: {
        positions,
        deposits: () => Promise.resolve({ items: history, nextCursor: null }),
        withdrawals: () => Promise.reject(new Error('The venue could not be reached.')),
      },
    });

    expect(await within(await card('Your deposits')).findByText('Queued for settlement')).toBeInTheDocument();
    const reads = {
      positions: positions.mock.calls.length,
      balances: balances.mock.calls.length,
      pool: get.mock.calls.length,
    };

    history = [
      deposit({
        status: 'SETTLED',
        result: {
          actualBaseIn: '0.05',
          actualQuoteIn: '3000',
          actualBaseRefund: '0',
          actualQuoteRefund: '0',
          actualLpOut: '12.2474486745',
        },
      }),
    ];

    expect(await within(await card('Your deposits')).findByText('Settled', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText('12.2474486745 LP minted')).toBeInTheDocument();
    await waitFor(() => expect(positions.mock.calls.length).toBeGreaterThan(reads.positions));
    expect(balances.mock.calls.length).toBeGreaterThan(reads.balances);
    expect(get.mock.calls.length).toBeGreaterThan(reads.pool);
  });

  it('reads the pool again once the initial deposit settles, so it is no longer empty', async () => {
    let history: DepositRequest[] = [deposit({ status: 'READY' })];
    let detail = EMPTY_POOL;
    desk({
      pools: { get: () => Promise.resolve(detail) },
      lp: { deposits: () => Promise.resolve({ items: history, nextCursor: null }) },
    });

    expect(await screen.findByText(/^Empty pool/)).toBeInTheDocument();

    detail = POOL;
    history = [deposit({ status: 'SETTLED' })];

    expect(await screen.findByText('Fee 30 bps', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.queryByText(/^Empty pool/)).not.toBeInTheDocument();
  });
});

describe('what a settled request did', () => {
  it('details the actual amounts the ledger moved for each kind', async () => {
    const user = desk({
      lp: {
        deposits: () =>
          Promise.resolve({
            items: [
              deposit({
                status: 'SETTLED',
                result: {
                  actualBaseIn: '0.05',
                  actualQuoteIn: '2990',
                  actualBaseRefund: '0',
                  actualQuoteRefund: '10',
                  actualLpOut: '12.2270',
                },
              }),
            ],
            nextCursor: null,
          }),
        withdrawals: () =>
          Promise.resolve({
            items: [
              withdrawal({
                status: 'SETTLED',
                result: { actualLpBurned: '100', actualBaseOut: '0.41', actualQuoteOut: '24500' },
              }),
            ],
            nextCursor: null,
          }),
      },
    });

    const valueOf = (dialog: HTMLElement, label: string) =>
      within(dialog).getByText(label).nextElementSibling!.textContent;

    const deposits = await card('Your deposits');
    await user.click(
      await within(deposits).findByRole('button', { name: 'Details for deposit deposit-0001' }),
    );
    const depositDetail = await screen.findByRole('dialog');
    expect(valueOf(depositDetail, 'Accepted')).toBe('0.05 BTC + 2,990.00 USDC');
    expect(valueOf(depositDetail, 'Refunded')).toBe('0.00 BTC + 10.00 USDC');
    expect(valueOf(depositDetail, 'LP minted')).toBe('12.227 LP');
    // Amounts say "LP"; the pool's own LP instrument is named in full here.
    expect(within(depositDetail).getByText('LP-BTC-USDC')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const withdrawals = await card('Your withdrawals');
    await user.click(
      await within(withdrawals).findByRole('button', { name: 'Details for withdrawal withdraw-0001' }),
    );
    const withdrawalDetail = await screen.findByRole('dialog');
    expect(valueOf(withdrawalDetail, 'LP burned')).toBe('100.00 LP');
    expect(valueOf(withdrawalDetail, 'Paid out')).toBe('0.41 BTC + 24,500.00 USDC');
  });
});

describe('recovering an expired request', () => {
  const EXPIRED = deposit({ status: 'EXPIRED', canRecover: true });
  const RECOVERY = {
    ...DEPOSIT_PREPARATION,
    action: 'RECOVER' as const,
    recoveryEffects: [
      { allocationCid: '00alloc0011', instrument: BTC, amount: '0.05', kind: 'RETURN_FUNDS' as const },
      { allocationCid: '00alloc0012', instrument: USDC, amount: '3000', kind: 'RETURN_FUNDS' as const },
      {
        allocationCid: '00alloc0013',
        instrument: LP,
        amount: '0',
        kind: 'RELEASE_PERMISSION' as const,
      },
    ],
  };

  it('says an elapsed deadline is not a recovery, and offers one only where the venue does', async () => {
    desk({
      lp: {
        deposits: () =>
          Promise.resolve({
            items: [
              deposit({ requestId: 'deposit-0002' }),
              EXPIRED,
              deposit({ requestId: 'deposit-0003', status: 'EXPIRED' }),
            ],
            nextCursor: null,
          }),
      },
    });

    const history = await card('Your deposits');
    expect(await within(history).findAllByText('Deadline elapsed')).toHaveLength(2);
    expect(within(history).getAllByRole('button', { name: 'Recover funds' })).toHaveLength(1);
    expect(within(history).queryByText('Funds recovered')).not.toBeInTheDocument();
  });

  it('shows what comes back and what is only released, then signs and reports it as under way', async () => {
    let answered = EXPIRED;
    const prepareDepositCancellation = vi.fn(() => Promise.resolve(RECOVERY));
    const submitDepositCancellation = vi.fn(async () => {
      answered = deposit({ status: 'RECOVERING' });
      return answered;
    });
    const signTransaction = vi.fn<CantonWallet['signTransaction']>(() =>
      Promise.resolve({ signature: SIGNATURE, fingerprint: FINGERPRINT }),
    );
    const user = desk(
      {
        lp: {
          deposits: () => Promise.resolve({ items: [answered], nextCursor: null }),
          prepareDepositCancellation,
          submitDepositCancellation,
        },
      },
      signingWallet({ signTransaction }),
    );

    await user.click(await screen.findByRole('button', { name: 'Recover funds' }));

    const effects = await screen.findByRole('list', { name: 'What this recovery releases' });
    expect(within(effects).getByText('Returns 0.05 BTC')).toBeInTheDocument();
    expect(within(effects).getByText('Returns 3,000.00 USDC')).toBeInTheDocument();
    expect(
      within(effects).getByText('Releases LP receipt permission (no funds returned)'),
    ).toBeInTheDocument();
    expect(effects.textContent).not.toMatch(/\b0(\.0+)? LP/);
    // Nothing is signed until the trader has read what the recovery does.
    expect(signTransaction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Sign recovery' }));

    await waitFor(() =>
      expect(submitDepositCancellation).toHaveBeenCalledWith(EXPIRED.requestId, {
        preparationId: RECOVERY.preparationId,
        signature: SIGNATURE,
      }),
    );
    expect(prepareDepositCancellation).toHaveBeenCalledWith(EXPIRED.requestId);
    expect(signTransaction.mock.calls[0]?.[0]).toBe(PREPARED_HASH);
    expect(await within(await card('Your deposits')).findByText('Recovering funds')).toBeInTheDocument();
    expect(screen.queryByText('Funds recovered')).not.toBeInTheDocument();
  });

  it('recovers a withdrawal through its own routes', async () => {
    const prepareWithdrawalCancellation = vi.fn(() =>
      Promise.resolve({ ...WITHDRAWAL_PREPARATION, action: 'RECOVER' as const, recoveryEffects: [] }),
    );
    const submitWithdrawalCancellation = vi.fn(() =>
      Promise.resolve(withdrawal({ status: 'RECOVERING' })),
    );
    const user = desk({
      lp: {
        withdrawals: () =>
          Promise.resolve({ items: [withdrawal({ status: 'EXPIRED', canRecover: true })], nextCursor: null }),
        prepareWithdrawalCancellation,
        submitWithdrawalCancellation,
      },
    });

    await user.click(await within(await card('Your withdrawals')).findByRole('button', { name: 'Recover funds' }));
    await user.click(await screen.findByRole('button', { name: 'Sign recovery' }));

    await waitFor(() => expect(submitWithdrawalCancellation).toHaveBeenCalledTimes(1));
    expect(prepareWithdrawalCancellation).toHaveBeenCalledWith('withdraw-0001');
  });

  it.each(['prepared', 'preparing'] as const)('retires a %s recovery when access disappears', async (phase) => {
    let finish!: (value: typeof RECOVERY) => void;
    const pending = new Promise<typeof RECOVERY>((resolve) => { finish = resolve; });
    const prepareRecovery = vi.fn(() => phase === 'prepared' ? Promise.resolve(RECOVERY) : pending);
    const submitRecovery = vi.fn();
    const sign = vi.fn();
    const history = {
      activity: {
        data: { items: [EXPIRED], nextCursor: null },
        loading: false,
        error: undefined,
        reload: vi.fn(),
      },
      recovering: undefined,
      dispatched: vi.fn(),
      olderCursor: undefined,
      canShowNewer: false,
      showOlder: vi.fn(),
      showNewer: vi.fn(),
    };
    const show = (openPoolIds: string[]) => (
      <LiquidityHistory
        title="Your deposits"
        history={history}
        balances={BALANCES.balances}
        signer={{ sign }}
        openPoolIds={openPoolIds}
        prepareRecovery={prepareRecovery}
        submitRecovery={submitRecovery}
        onRecovered={vi.fn()}
      />
    );
    const view = render(show([POOL_ID]));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Recover funds' }));
    if (phase === 'prepared') await screen.findByRole('button', { name: 'Sign recovery' });
    view.rerender(show([]));
    await act(async () => finish(RECOVERY));
    expect(screen.queryByRole('button', { name: 'Sign recovery' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recover funds' })).toBeDisabled();
    expect(sign).not.toHaveBeenCalled();
    expect(submitRecovery).not.toHaveBeenCalled();
  });

  it('offers no recovery once pool access lapses, and signs nothing', async () => {
    const prepareDepositCancellation = vi.fn();
    const prepareWithdrawalCancellation = vi.fn();
    const signTransaction = vi.fn();
    const user = desk(
      {
        onboarding: { mine: () => Promise.resolve(withoutAccess()) },
        lp: {
          deposits: () => Promise.resolve({ items: [EXPIRED], nextCursor: null }),
          withdrawals: () =>
            Promise.resolve({ items: [withdrawal({ status: 'EXPIRED', canRecover: true })], nextCursor: null }),
          prepareDepositCancellation,
          prepareWithdrawalCancellation,
        },
      },
      signingWallet({ signTransaction }),
    );

    for (const title of ['Your deposits', 'Your withdrawals']) {
      const recover = await within(await card(title)).findByRole('button', { name: 'Recover funds' });
      expect(recover).toBeDisabled();
      await user.click(recover);
    }
    expect(screen.queryByRole('list', { name: 'What this recovery releases' })).not.toBeInTheDocument();
    expect(prepareDepositCancellation).not.toHaveBeenCalled();
    expect(prepareWithdrawalCancellation).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
  });
});
