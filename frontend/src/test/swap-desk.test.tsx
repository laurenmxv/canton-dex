import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DexProvider, type Session } from '../app/runtime';
import { SwapDesk } from '../features/swap/SwapDesk';
import type { DexClient } from '../lib/api/port';
import { DomainError, type FaucetResult, type SubmitSignatureInput, type Swap } from '../lib/api/types';
import { WalletError, type CantonWallet } from '../wallet/types';
import { testClient } from './clients';
import { testWallet } from './wallets';
import {
  ACCESS_REFUSED,
  BALANCES,
  BTC,
  onboarded,
  POOL,
  POOL_ID,
  PREPARATION,
  PREPARED_HASH,
  QUOTE,
  swap,
  TRADER,
  USDC,
  withoutAccess,
} from './venue-fixtures';

const SIGNATURE = 'MEQCIBEiM0RVZneImaq7zN3u/wACIDNEVWZ3iJmqu8zd7v8AESIz';
const CLAIMED: FaucetResult = {
  status: 'COMPLETED',
  updateId: '1220update99',
  errorCode: null,
  error: null,
};

type Parts = Parameters<typeof testClient>[0];

function desk(parts: Parts = {}, wallet: CantonWallet = signingWallet()) {
  const client = testClient({
    me: () => Promise.resolve(TRADER),
    ...parts,
    onboarding: { mine: () => Promise.resolve(onboarded()), ...parts.onboarding },
    pools: {
      list: () => Promise.resolve([{ poolId: POOL_ID, name: POOL.name }]),
      get: () => Promise.resolve(POOL),
      ...parts.pools,
    },
    tokens: {
      balances: () => Promise.resolve(BALANCES),
      faucetStatus: () => Promise.resolve(CLAIMED),
      ...parts.tokens,
    },
    swaps: {
      activity: () => Promise.resolve({ items: [], nextCursor: null }),
      ...parts.swaps,
    },
  });
  return renderDesk(client, wallet);
}

function renderDesk(client: DexClient, wallet: CantonWallet) {
  const session: Session = { mode: 'keycloak', current: TRADER, loading: false };
  render(
    <DexProvider client={client} session={session} wallet={wallet}>
      <SwapDesk onGoToOnboarding={() => {}} />
    </DexProvider>,
  );
  return userEvent.setup();
}

function signingWallet(overrides: Partial<CantonWallet> = {}): CantonWallet {
  return testWallet({
    connect: () => Promise.resolve(),
    signTransaction: () =>
      Promise.resolve({ signature: SIGNATURE, fingerprint: PREPARATION.publicKeyFingerprint }),
    ...overrides,
  });
}

async function quoteFor(user: ReturnType<typeof userEvent.setup>, amount: string) {
  await user.type(await screen.findByLabelText('Amount in (BTC)'), amount);
  await user.click(screen.getByRole('button', { name: 'Get a quote' }));
}

describe('requesting a swap', () => {
  it('prices, signs and submits exactly what the venue prepared', async () => {
    const quote = vi.fn(() => Promise.resolve(QUOTE));
    const prepare = vi.fn(() => Promise.resolve(PREPARATION));
    const submit = vi.fn(() => Promise.resolve(swap({ status: 'SUBMITTING' })));
    const signTransaction = vi.fn<CantonWallet['signTransaction']>(() =>
      Promise.resolve({ signature: SIGNATURE, fingerprint: PREPARATION.publicKeyFingerprint }),
    );

    const user = desk({ swaps: { quote, prepare, submit } }, signingWallet({ signTransaction }));
    await quoteFor(user, '0.05');

    expect(quote).toHaveBeenCalledWith({
      poolId: POOL_ID,
      direction: 'BaseToQuote',
      amountIn: '0.05',
      slippageBps: 50,
    });
    expect(await screen.findByText('2,941.17647 USDC')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Request swap' }));

    // The trader approves the quoted minimum and deadline, not terms of the
    // browser's own making.
    await waitFor(() =>
      expect(prepare).toHaveBeenCalledWith({
        quoteId: QUOTE.quoteId,
        minOut: QUOTE.minOut,
        settlementDeadline: QUOTE.settlementDeadline,
      }),
    );
    // The venue's own hash goes to the wallet unchanged.
    expect(signTransaction.mock.calls[0]?.[0]).toBe(PREPARED_HASH);
    expect(submit).toHaveBeenCalledWith({
      preparationId: PREPARATION.preparationId,
      signature: SIGNATURE,
    });
  });

  it('says the request is queued, not that an exchange happened', async () => {
    const user = desk({
      swaps: {
        quote: () => Promise.resolve(QUOTE),
        prepare: () => Promise.resolve(PREPARATION),
        submit: () => Promise.resolve(swap({ status: 'SUBMITTING' })),
      },
    });

    await quoteFor(user, '0.05');
    await user.click(await screen.findByRole('button', { name: 'Request swap' }));

    const notice = (await screen.findByText('Request sent')).closest<HTMLElement>('[role="alert"]')!;
    expect(notice.textContent).toContain(swap().swapId);
    expect(notice.textContent).not.toMatch(/settled|exchanged|credited|received/i);
  });

  it('retires a quote as soon as the terms behind it change', async () => {
    const quote = vi.fn(() => Promise.resolve(QUOTE));
    const user = desk({ swaps: { quote } });

    await quoteFor(user, '0.05');
    expect(await screen.findByRole('button', { name: 'Request swap' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Amount in (BTC)'), '5');

    expect(screen.queryByRole('button', { name: 'Request swap' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get a quote' })).toBeInTheDocument();
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it('submits nothing when the wallet prompt is dismissed, and lets it be tried again', async () => {
    const submit = vi.fn(() => Promise.resolve(swap({ status: 'SUBMITTING' })));
    const prepare = vi.fn(() => Promise.resolve(PREPARATION));
    const signTransaction = vi
      .fn()
      .mockRejectedValueOnce(new WalletError('rejected', 'You dismissed the MetaMask prompt.'))
      .mockResolvedValue({ signature: SIGNATURE, fingerprint: PREPARATION.publicKeyFingerprint });

    const user = desk(
      { swaps: { quote: () => Promise.resolve(QUOTE), prepare, submit } },
      signingWallet({ signTransaction }),
    );

    await quoteFor(user, '0.05');
    await user.click(await screen.findByRole('button', { name: 'Request swap' }));

    expect(
      await screen.findByText(/You dismissed the MetaMask prompt\. Nothing was sent to the venue\./),
    ).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Request swap' }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    // The second attempt re-prepares the same quote, which the venue answers
    // with the preparation that already exists rather than a second request.
    expect(prepare.mock.calls).toHaveLength(2);
    expect(prepare.mock.calls[0]).toEqual(prepare.mock.calls[1]);
  });

  it('refuses a signature from a key the party is not registered to', async () => {
    const submit = vi.fn(() => Promise.resolve(swap()));
    const user = desk(
      {
        swaps: {
          quote: () => Promise.resolve(QUOTE),
          prepare: () => Promise.resolve(PREPARATION),
          submit,
        },
      },
      signingWallet({
        signTransaction: () =>
          Promise.resolve({ signature: SIGNATURE, fingerprint: '1220someotherkey' }),
      }),
    );

    await quoteFor(user, '0.05');
    await user.click(await screen.findByRole('button', { name: 'Request swap' }));

    expect(await screen.findByText(/registered to another one/)).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it('refuses a preparation under a hashing scheme this build does not approve', async () => {
    const signTransaction = vi.fn();
    const user = desk(
      {
        swaps: {
          quote: () => Promise.resolve(QUOTE),
          prepare: () => Promise.resolve({ ...PREPARATION, hashingSchemeVersion: 2 }),
          submit: () => Promise.resolve(swap()),
        },
      },
      signingWallet({ signTransaction }),
    );

    await quoteFor(user, '0.05');
    await user.click(await screen.findByRole('button', { name: 'Request swap' }));

    expect(await screen.findByText(/hashing scheme 2/)).toBeInTheDocument();
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['preparing', { prepare: () => Promise.reject(ACCESS_REFUSED) }, 0],
    [
      'submitting',
      { prepare: () => Promise.resolve(PREPARATION), submit: () => Promise.reject(ACCESS_REFUSED) },
      1,
    ],
  ] as const)('signs nothing more once the venue refuses pool access while %s', async (_, swaps, signed) => {
    const signTransaction = vi.fn<CantonWallet['signTransaction']>(() =>
      Promise.resolve({ signature: SIGNATURE, fingerprint: PREPARATION.publicKeyFingerprint }),
    );
    const user = desk(
      { swaps: { quote: () => Promise.resolve(QUOTE), ...swaps } },
      signingWallet({ signTransaction }),
    );

    await quoteFor(user, '0.05');
    await user.click(await screen.findByRole('button', { name: 'Request swap' }));

    expect(await screen.findByText(ACCESS_REFUSED.message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request swap' })).toBeDisabled();
    expect(screen.queryByText('Sent, outcome unknown')).not.toBeInTheDocument();
    expect(signTransaction).toHaveBeenCalledTimes(signed);

    // Only a new quote, which the venue gives only with access, opens signing again.
    await user.click(screen.getByRole('button', { name: 'Refresh quote' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request swap' })).toBeEnabled());
  });
});

describe('what the form refuses before asking the venue', () => {
  it('will not spend more than the ledger says is available', async () => {
    const quote = vi.fn(() => Promise.resolve(QUOTE));
    const user = desk({ swaps: { quote } });

    await quoteFor(user, '1');

    expect(await screen.findByText('You have 0.10 BTC available.')).toBeInTheDocument();
    expect(quote).not.toHaveBeenCalled();
  });

  it('will not offer more decimal places than the token carries', async () => {
    const quote = vi.fn(() => Promise.resolve(QUOTE));
    const user = desk({ swaps: { quote } });

    await quoteFor(user, '0.000000001');

    expect(await screen.findByText('BTC has 8 decimal places.')).toBeInTheDocument();
    expect(quote).not.toHaveBeenCalled();
  });

  it('will not send something that is not a plain decimal', async () => {
    const quote = vi.fn(() => Promise.resolve(QUOTE));
    const user = desk({ swaps: { quote } });

    await quoteFor(user, '1e3');

    expect(await screen.findByText(/plain decimal amount/)).toBeInTheDocument();
    expect(quote).not.toHaveBeenCalled();
  });

  // How much a pool will price is the venue's answer. The form holds no size
  // of its own, so an amount the trader holds goes out whatever its magnitude.
  it('prices an amount the trader holds, however large', async () => {
    const quote = vi.fn(() =>
      Promise.resolve({
        ...QUOTE,
        amountIn: '1500000.5',
        expectedOut: '88235294.117647',
        minOut: '87794117.647058',
      }),
    );
    const user = desk({
      tokens: {
        balances: () =>
          Promise.resolve({
            ...BALANCES,
            balances: [
              {
                instrument: BTC,
                symbol: 'BTC',
                decimals: 8,
                available: '2500000',
                locked: '0',
                total: '2500000',
              },
            ],
          }),
      },
      swaps: { quote },
    });

    await quoteFor(user, '1500000.5');

    expect(quote).toHaveBeenCalledWith({
      poolId: POOL_ID,
      direction: 'BaseToQuote',
      amountIn: '1500000.5',
      slippageBps: 50,
    });
    expect(await screen.findByText('88,235,294.117647 USDC')).toBeInTheDocument();
    expect(screen.getByText(/87,794,117\.647058 USDC/)).toBeInTheDocument();
  });
});

describe('the trader’s own requests', () => {
  it('come from the venue, so a reload shows what this browser never held', async () => {
    const user = desk({
      swaps: {
        activity: () =>
          Promise.resolve({
            items: [swap({ status: 'SETTLED', amountOut: '2950.123456' })],
            nextCursor: null,
          }),
      },
    });

    expect(await screen.findByText('Settled')).toBeInTheDocument();
    expect(screen.getByText('2,950.123456 USDC')).toBeInTheDocument();

    // The detail opens at full width, with every identifier whole.
    await user.click(screen.getByRole('button', { name: 'Details for swap swap-0001' }));
    const detail = await screen.findByRole('dialog');
    expect(within(detail).getByText('Paid out').nextElementSibling).toHaveTextContent('2,950.123456 USDC');
    expect(within(detail).getByText('00alloc0002')).toBeInTheDocument();
  });

  it('shows a minimum, not an output, until the pool has actually paid one', async () => {
    desk({ swaps: { activity: () => Promise.resolve({ items: [swap()], nextCursor: null }) } });

    expect(await screen.findByText('Queued for settlement')).toBeInTheDocument();
    expect(screen.getByText(/minimum 2,926.470588 USDC/)).toBeInTheDocument();
  });

  it('offers a reclaim only where the venue says one is possible', async () => {
    const reclaimable = swap({ status: 'EXPIRED', canWithdraw: true, swapId: 'swap-0002' });
    desk({
      swaps: {
        activity: () =>
          Promise.resolve({ items: [swap(), reclaimable], nextCursor: null }),
      },
    });

    await screen.findByText('Deadline elapsed');
    expect(screen.getAllByRole('button', { name: 'Reclaim' })).toHaveLength(1);
  });

  it('signs a reclaim and reports it as under way, not as released funds', async () => {
    const prepareCancellation = vi.fn(() =>
      Promise.resolve({ ...PREPARATION, action: 'WITHDRAW' as const }),
    );
    const submitCancellation = vi.fn((_swapId: string, _input: SubmitSignatureInput) =>
      Promise.resolve(swap({ status: 'WITHDRAWING' })),
    );
    const expired = swap({ status: 'EXPIRED', canWithdraw: true });
    let answered: Swap = expired;

    const user = desk({
      swaps: {
        activity: () => Promise.resolve({ items: [answered], nextCursor: null }),
        prepareCancellation,
        submitCancellation: async (swapId, input) => {
          const result = await submitCancellation(swapId, input);
          answered = result;
          return result;
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Reclaim' }));

    await waitFor(() => expect(prepareCancellation).toHaveBeenCalledWith(expired.swapId));
    expect(submitCancellation).toHaveBeenCalledWith(expired.swapId, {
      preparationId: PREPARATION.preparationId,
      signature: SIGNATURE,
    });
    expect(await screen.findByText('Reclaiming')).toBeInTheDocument();
    expect(screen.queryByText('Reclaimed')).not.toBeInTheDocument();
  });

  it('offers no reclaim once pool access lapses, and signs nothing', async () => {
    const prepareCancellation = vi.fn();
    const signTransaction = vi.fn();
    const user = desk(
      {
        onboarding: { mine: () => Promise.resolve(withoutAccess()) },
        swaps: {
          activity: () =>
            Promise.resolve({ items: [swap({ status: 'EXPIRED', canWithdraw: true })], nextCursor: null }),
          prepareCancellation,
        },
      },
      signingWallet({ signTransaction }),
    );

    const reclaim = await screen.findByRole('button', { name: 'Reclaim' });
    expect(reclaim).toBeDisabled();
    await user.click(reclaim);
    expect(prepareCancellation).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
  });
});

describe('which pools are open', () => {
  it('offers only a pool the ledger has confirmed access to', async () => {
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

describe('a submission whose reply never arrives', () => {
  it('recovers the request from the venue rather than asking for another signature', async () => {
    // The venue took the submission and only the answer was lost, so the
    // request appears a read or two later rather than at once.
    let history: Swap[] = [];
    const signTransaction = vi.fn<CantonWallet['signTransaction']>(() =>
      Promise.resolve({ signature: SIGNATURE, fingerprint: PREPARATION.publicKeyFingerprint }),
    );
    const submit = vi.fn(() => Promise.reject(new Error('The venue could not be reached.')));

    const user = desk(
      {
        swaps: {
          quote: () => Promise.resolve(QUOTE),
          prepare: () => Promise.resolve(PREPARATION),
          submit,
          activity: () => Promise.resolve({ items: history, nextCursor: null }),
        },
      },
      signingWallet({ signTransaction }),
    );

    await quoteFor(user, '0.05');
    await user.click(await screen.findByRole('button', { name: 'Request swap' }));

    expect(await screen.findByText('Sent, outcome unknown')).toBeInTheDocument();
    // Nothing here may be signed again: that would be a second request.
    expect(screen.getByRole('button', { name: 'Request swap' })).toBeDisabled();

    history = [swap({ status: 'READY' })];

    // The history is read until the venue reports it, and the notice goes
    // when it does.
    expect(
      await screen.findByText('Queued for settlement', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Sent, outcome unknown')).not.toBeInTheDocument(),
    );
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('reconciles the original request when the venue refuses to prepare the quote again', async () => {
    const signTransaction = vi.fn<CantonWallet['signTransaction']>();
    const user = desk(
      {
        swaps: {
          quote: () => Promise.resolve(QUOTE),
          prepare: () =>
            Promise.reject(
              new DomainError('This preparation has expired', 'CONFLICT', 'PREPARATION_EXPIRED'),
            ),
          activity: () => Promise.resolve({ items: [swap({ status: 'UNRESOLVED' })], nextCursor: null }),
        },
      },
      signingWallet({ signTransaction }),
    );

    await quoteFor(user, '0.05');
    await user.click(await screen.findByRole('button', { name: 'Request swap' }));

    expect(await screen.findByText('This quote already has a request')).toBeInTheDocument();
    // A dispatched submission can still recover to READY, so nothing is signed
    // until that request has an outcome.
    expect(screen.getByRole('button', { name: 'Request swap' })).toBeDisabled();
    expect(signTransaction).not.toHaveBeenCalled();
    expect(screen.getByText('Confirming')).toBeInTheDocument();
  });
});

describe('what the ledger does to a balance', () => {
  it('reads holdings again when a queued request settles', async () => {
    let history: Swap[] = [swap({ status: 'READY' })];
    let held = BALANCES;
    const balances = vi.fn(() => Promise.resolve(held));

    desk({
      tokens: { balances, faucetStatus: () => Promise.resolve(CLAIMED) },
      swaps: { activity: () => Promise.resolve({ items: history, nextCursor: null }) },
    });

    expect(await screen.findByText('Queued for settlement')).toBeInTheDocument();
    const reads = balances.mock.calls.length;

    history = [swap({ status: 'SETTLED', amountOut: '2950.123456' })];
    held = {
      ...BALANCES,
      balances: [
        { instrument: BTC, symbol: 'BTC', decimals: 8, available: '0.05', locked: '0', total: '0.05' },
        {
          instrument: USDC,
          symbol: 'USDC',
          decimals: 6,
          available: '12950.123456',
          locked: '0',
          total: '12950.123456',
        },
      ],
    };

    // The poll notices the settlement, and the holdings follow from it.
    expect(await screen.findByText('Settled', {}, { timeout: 10_000 })).toBeInTheDocument();
    await waitFor(() => expect(balances.mock.calls.length).toBeGreaterThan(reads));
    expect(await screen.findByText('0.05 BTC available')).toBeInTheDocument();
  });

  it('reads holdings again once a reclaim is submitted', async () => {
    const balances = vi.fn(() => Promise.resolve(BALANCES));
    const user = desk({
      tokens: { balances, faucetStatus: () => Promise.resolve(CLAIMED) },
      swaps: {
        activity: () =>
          Promise.resolve({ items: [swap({ status: 'EXPIRED', canWithdraw: true })], nextCursor: null }),
        prepareCancellation: () => Promise.resolve({ ...PREPARATION, action: 'WITHDRAW' as const }),
        submitCancellation: () => Promise.resolve(swap({ status: 'WITHDRAWING' })),
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Reclaim' }));

    const reads = balances.mock.calls.length;
    await waitFor(() => expect(balances.mock.calls.length).toBeGreaterThanOrEqual(reads));
    expect(balances).toHaveBeenCalled();
  });
});

describe('reaching an old request', () => {
  it('pages back to one no page of newer requests would show', async () => {
    const newest = Array.from({ length: 20 }, (_, index) =>
      swap({ swapId: `swap-new-${index}`, status: 'SETTLED', amountOut: '2941.176470' }),
    );
    const oldest = swap({ swapId: 'swap-old-0001', status: 'EXPIRED', canWithdraw: true });
    const prepareCancellation = vi.fn(() =>
      Promise.resolve({ ...PREPARATION, action: 'WITHDRAW' as const }),
    );
    const submitCancellation = vi.fn(() => Promise.resolve(swap({ status: 'WITHDRAWING' })));

    const user = desk({
      swaps: {
        activity: (query) =>
          Promise.resolve(
            query?.cursor === undefined
              ? { items: newest, nextCursor: 'cursor-page-2' }
              : { items: [oldest], nextCursor: null },
          ),
        prepareCancellation,
        submitCancellation,
      },
    });

    // Nothing reclaimable is on the newest page.
    expect(await screen.findAllByText('Settled')).toHaveLength(20);
    expect(screen.queryByRole('button', { name: 'Reclaim' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Older' }));

    await user.click(await screen.findByRole('button', { name: 'Reclaim' }));
    await waitFor(() => expect(prepareCancellation).toHaveBeenCalledWith(oldest.swapId));
    expect(submitCancellation).toHaveBeenCalledWith(oldest.swapId, {
      preparationId: PREPARATION.preparationId,
      signature: SIGNATURE,
    });
  });
});
