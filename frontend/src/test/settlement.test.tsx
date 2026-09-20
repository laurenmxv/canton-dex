import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DexProvider, type Session } from '../app/runtime';
import { OperatorSettlement } from '../features/settlement/OperatorSettlement';
import {
  DomainError,
  type PoolDetail,
  type RunSettlementInput,
  type Settlement,
  type SettlementPolicy,
  type SettlementQueueFilter,
} from '../lib/api/types';
import { testClient } from './clients';
import {
  BTC,
  monitoring,
  OPERATOR,
  POOL,
  POOL_ID,
  POLICY,
  settlement,
  swap,
  USDC,
} from './venue-fixtures';
import '../styles/global.css';

/** A second pool, so a change of scope can be told apart from a shared setting. */
const OTHER_ID = '00pool00ethusdc';
const OTHER: PoolDetail = {
  ...POOL,
  poolId: OTHER_ID,
  name: 'ETH / USDC',
  settings: {
    ...POOL.settings,
    baseInstrumentId: { admin: 'issuer::1220iss', id: 'ETH' },
  },
};
const OTHER_POLICY: SettlementPolicy = {
  ...POLICY,
  poolId: OTHER_ID,
  automaticEnabled: true,
  batchSize: 7,
  version: 9,
};

type Parts = Parameters<typeof testClient>[0];

function dashboard(parts: Parts = {}, pools: PoolDetail[] = [POOL]) {
  const client = testClient({
    me: () => Promise.resolve(OPERATOR),
    ...parts,
    admin: { listPools: () => Promise.resolve(pools), ...parts.admin },
    settlements: {
      policy: () => Promise.resolve(POLICY),
      monitoring: () => Promise.resolve(monitoring()),
      requests: () => Promise.resolve([]),
      list: () => Promise.resolve([]),
      ...parts.settlements,
    },
  });
  const session: Session = { mode: 'keycloak', current: OPERATOR, loading: false };
  render(
    <DexProvider client={client} session={session}>
      <OperatorSettlement />
    </DexProvider>,
  );
  return userEvent.setup();
}

describe('what the dashboard reads', () => {
  it('asks for the whole outstanding queue, not the ready part alone', async () => {
    const requests = vi.fn((_poolId: string, _status?: SettlementQueueFilter) =>
      Promise.resolve([swap()]),
    );
    dashboard({ settlements: { requests } });

    await screen.findByText('Queue');
    await waitFor(() => expect(requests).toHaveBeenCalled());
    // Left to itself the route answers with READY only, which would show a
    // shorter queue than the pool actually has.
    expect(requests.mock.calls[0]?.[1]).toBe('active');
  });

  it('scopes every read to the chosen pool', async () => {
    const policy = vi.fn((poolId: string) =>
      Promise.resolve(poolId === POOL_ID ? POLICY : OTHER_POLICY),
    );
    const requests = vi.fn((_poolId: string) => Promise.resolve([]));

    const user = dashboard({ settlements: { policy, requests } }, [POOL, OTHER]);
    await screen.findByText('Ready 2 / 5');

    await user.selectOptions(screen.getByLabelText('Pool'), OTHER_ID);

    await waitFor(() => expect(policy).toHaveBeenLastCalledWith(OTHER_ID, expect.anything()));
    expect(requests.mock.calls.map((call) => call[0])).toEqual([POOL_ID, OTHER_ID]);
  });

  it('shows the settings the venue saved for this pool, not the previous pool’s', async () => {
    const user = dashboard(
      {
        settlements: {
          policy: (poolId) => Promise.resolve(poolId === POOL_ID ? POLICY : OTHER_POLICY),
        },
      },
      [POOL, OTHER],
    );

    expect(await screen.findByLabelText('Batch target, exact')).toHaveValue(5);
    expect(screen.getByLabelText('Automatic settlement')).not.toBeChecked();

    await user.selectOptions(screen.getByLabelText('Pool'), OTHER_ID);

    await waitFor(() => expect(screen.getByLabelText('Batch target, exact')).toHaveValue(7));
    expect(screen.getByLabelText('Automatic settlement')).toBeChecked();
  });

  it('shows no settings at all while the newly chosen pool’s are still being read', async () => {
    const user = dashboard(
      {
        settlements: {
          policy: (poolId) =>
            poolId === POOL_ID ? Promise.resolve(POLICY) : new Promise(() => {}),
        },
      },
      [POOL, OTHER],
    );

    expect(await screen.findByLabelText('Batch target, exact')).toHaveValue(5);

    await user.selectOptions(screen.getByLabelText('Pool'), OTHER_ID);

    // The previous pool's target must not sit under the new pool's name while
    // the venue is still answering for it.
    await waitFor(() =>
      expect(screen.queryByLabelText('Batch target, exact')).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Loading this pool's settings…")).toBeInTheDocument();
  });
});

describe('saving one pool’s settings', () => {
  it('sends the version it read, so a stale form cannot restore an old setting', async () => {
    const updatePolicy = vi.fn(() =>
      Promise.resolve({ ...POLICY, automaticEnabled: true, batchSize: 3, version: 5 }),
    );
    const user = dashboard({ settlements: { updatePolicy } });

    const exact = await screen.findByLabelText('Batch target, exact');
    await user.clear(exact);
    await user.type(exact, '3');
    await user.click(screen.getByLabelText('Automatic settlement'));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(updatePolicy).toHaveBeenCalledWith(POOL_ID, {
        automaticEnabled: true,
        batchSize: 3,
        expectedVersion: POLICY.version,
      }),
    );
  });

  it('keeps the slider and the exact field on one value', async () => {
    const user = dashboard();

    const slider = await screen.findByLabelText('Batch target');
    const exact = screen.getByLabelText('Batch target, exact');
    expect(slider).toHaveValue('5');

    await user.clear(exact);
    await user.type(exact, '8');

    expect(slider).toHaveValue('8');
  });

  it('never carries a target above the maximum the venue published', async () => {
    const user = dashboard();

    const exact = await screen.findByLabelText('Batch target, exact');
    await user.clear(exact);
    await user.type(exact, '11');
    await user.tab();

    expect(exact).toHaveValue(10);
    expect(screen.getByLabelText('Batch target')).toHaveValue('10');
  });

  it('says a conflicting save changed nothing, rather than showing it as saved', async () => {
    const user = dashboard({
      settlements: {
        updatePolicy: () =>
          Promise.reject(new DomainError('Settings changed elsewhere', 'CONFLICT')),
      },
    });

    const exact = await screen.findByLabelText('Batch target, exact');
    await user.clear(exact);
    await user.type(exact, '2');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('These settings changed elsewhere')).toBeInTheDocument();
    expect(screen.getByText(/Saved version 4/)).toBeInTheDocument();
  });

  it('offers no save until something has actually changed', async () => {
    dashboard();

    expect(await screen.findByRole('button', { name: 'Save settings' })).toBeDisabled();
  });
});

describe('running a batch by hand', () => {
  it('carries one idempotency key, and does not send a second on a double click', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async (_poolId: string, _input: RunSettlementInput) => {
      await held;
      return settlement({ status: 'SUBMITTING' });
    });
    const user = dashboard({ settlements: { run } });

    const button = await screen.findByRole('button', { name: 'Run batch' });
    await user.click(button);
    await user.click(button);
    release();

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const key = run.mock.calls[0]![1].idempotencyKey;
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('repeats the same key after a failure, because the outcome is unknown', async () => {
    const run = vi
      .fn<(poolId: string, input: RunSettlementInput) => Promise<Settlement>>()
      .mockRejectedValueOnce(new Error('The venue could not be reached.'))
      .mockResolvedValue(settlement({ status: 'SUBMITTING' }));
    const user = dashboard({ settlements: { run } });

    const button = await screen.findByRole('button', { name: 'Run batch' });
    await user.click(button);
    await screen.findByText('Batch status unknown');
    await user.click(button);

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[0]![1]).toEqual(run.mock.calls[1]![1]);
  });
});

describe('what the pool state says', () => {
  it('names the blocked head instead of quietly leaving it out', async () => {
    const blocked = swap({ status: 'BLOCKED' });
    dashboard({
      settlements: {
        requests: () => Promise.resolve([blocked]),
        monitoring: () =>
          Promise.resolve(
            monitoring({
              blockedSwapId: blocked.swapId,
              blockedReason: 'Output is below the signed minimum at the current reserves.',
              readyCount: 0,
            }),
          ),
      },
    });

    expect(await screen.findByText('The head of this queue cannot settle')).toBeInTheDocument();
    expect(
      screen.getByText('Output is below the signed minimum at the current reserves.'),
    ).toBeInTheDocument();
  });

  it('reports a setting that stops dispatch, which names no request at all', async () => {
    dashboard({
      settlements: {
        monitoring: () =>
          Promise.resolve(
            monitoring({
              blockedSwapId: null,
              blockedReason:
                "Saved batch size 12 exceeds the current maximum 10. Update this pool's settlement policy before dispatching.",
            }),
          ),
      },
    });

    expect(await screen.findByText('This pool cannot dispatch a batch')).toBeInTheDocument();
    expect(screen.getByText(/exceeds the current maximum 10/)).toBeInTheDocument();
  });

  it('reports an old observation as old, rather than as the current state', async () => {
    dashboard({
      settlements: {
        monitoring: () =>
          Promise.resolve(
            monitoring({
              pool: {
                ...monitoring().pool!,
                observedAt: new Date(Date.now() - 120_000).toISOString(),
              },
            }),
          ),
      },
    });

    expect(await screen.findByText(/^Stale data · /)).toBeInTheDocument();
  });

  it('checks the reported invariant against the reserves instead of scoring them', async () => {
    dashboard({
      settlements: {
        monitoring: () =>
          Promise.resolve(
            monitoring({
              pool: {
                ...monitoring().pool!,
                reserves: {
                  stateId: '00state0001',
                  baseReserve: '5',
                  quoteReserve: '300000',
                  spotPrice: '60000',
                  invariant: '1499999',
                },
              },
            }),
          ),
      },
    });

    expect(await screen.findByText(/does not match the reserves/)).toBeInTheDocument();
  });

  it('shows the reserve change of the last confirmed batch, signed both ways', async () => {
    dashboard({ settlements: { list: () => Promise.resolve([settlement()]) } });

    expect(await screen.findByText('+0.05')).toBeInTheDocument();
    expect(screen.getByText('-2,941.17647')).toBeInTheDocument();
  });

  it('claims no reserve change for a batch the ledger has not confirmed', async () => {
    dashboard({
      settlements: {
        list: () =>
          Promise.resolve([settlement({ status: 'SUBMITTING', before: null, after: null, fills: [] })]),
      },
    });

    const state = (await screen.findByText('Pool state')).closest('section')!;
    expect(within(state).queryByText(/change, last confirmed batch/)).not.toBeInTheDocument();
  });
});

describe('the batch history', () => {
  it('keeps the identifiers and the fills behind a detail the reader opens', async () => {
    const user = dashboard({ settlements: { list: () => Promise.resolve([settlement()]) } });

    const history = (await screen.findByText('Recent batches')).closest('section')!;
    const summary = await within(history).findByText('Show detail');
    const disclosure = summary.closest('details')!;
    // The row says what happened; the contract identifiers stay closed until
    // the reader asks for them.
    expect(disclosure).not.toHaveAttribute('open');
    expect(within(history).getByText('Confirmed')).toBeInTheDocument();

    await user.click(summary);

    expect(disclosure).toHaveAttribute('open');
    expect(within(disclosure).getByText('settle-0001')).toBeInTheDocument();
    expect(within(disclosure).getByText(/2,941.17647 USDC/)).toBeInTheDocument();
  });

  it('says an unconfirmed batch filled nothing, rather than showing it as empty', async () => {
    const user = dashboard({
      settlements: {
        list: () =>
          Promise.resolve([settlement({ status: 'UNRESOLVED', fills: [], updateId: null })]),
      },
    });

    const history = (await screen.findByText('Recent batches')).closest('section')!;
    await user.click(await within(history).findByText('Show detail'));

    expect(within(history).getByText('No fills')).toBeInTheDocument();
    expect(within(history).getByText('Confirming')).toBeInTheDocument();
    expect(within(history).getByText('Not confirmed')).toBeInTheDocument();
  });
});

describe('an operator watching an idle pool', () => {
  it('discovers work nobody on this screen created', async () => {
    let queue: ReturnType<typeof swap>[] = [];
    let batches: ReturnType<typeof settlement>[] = [];
    let counts = monitoring({ readyCount: 0, pendingCount: 0 });

    dashboard({
      settlements: {
        requests: () => Promise.resolve(queue),
        list: () => Promise.resolve(batches),
        monitoring: () => Promise.resolve(counts),
      },
    });

    expect(await screen.findByText('Nothing outstanding')).toBeInTheDocument();

    // A trader signs a request, and the venue's own worker settles it. Neither
    // happens on this screen, and neither should need a reload to appear.
    queue = [swap({ status: 'READY' })];
    counts = monitoring({ readyCount: 1, pendingCount: 0 });

    expect(
      await screen.findByText('Queued for settlement', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/1 ready/, {}, { timeout: 10_000 })).toBeInTheDocument();

    queue = [];
    batches = [settlement()];
    counts = monitoring({ readyCount: 0, pendingCount: 0 });

    expect(await screen.findByText('Confirmed', {}, { timeout: 10_000 })).toBeInTheDocument();
  });
});

describe('what the counts mean', () => {
  it('never shows a queue of requests as nothing outstanding', async () => {
    dashboard({
      settlements: {
        requests: () => Promise.resolve([swap(), swap({ swapId: 'swap-0002' })]),
        // The venue counts only the requests whose own command is in flight,
        // which is none of these.
        monitoring: () => Promise.resolve(monitoring({ readyCount: 2, pendingCount: 0 })),
      },
    });

    const queue = (await screen.findByText('Queue')).closest('section')!;
    expect(await within(queue).findByText(/2 in this queue/)).toBeInTheDocument();
    expect(within(queue).getByText(/2 ready/)).toBeInTheDocument();
    expect(within(queue).getByText(/0 awaiting confirmation/)).toBeInTheDocument();
  });
});

describe('a batch that has not been confirmed', () => {
  it('shows its fills as a projection rather than as money paid', async () => {
    const user = dashboard({
      settlements: {
        list: () => Promise.resolve([settlement({ status: 'SUBMITTING', after: null })]),
      },
    });

    const history = (await screen.findByText('Recent batches')).closest('section')!;
    await user.click(await within(history).findByText('Show detail'));

    expect(within(history).getByText('Projected, not paid')).toBeInTheDocument();
    // A reserve change is a confirmed fact, so an unconfirmed batch claims none.
    expect(within(history).queryByText(/change/)).not.toBeInTheDocument();
  });

  it('shows a confirmed batch as paid', async () => {
    const user = dashboard({ settlements: { list: () => Promise.resolve([settlement()]) } });

    const history = (await screen.findByText('Recent batches')).closest('section')!;
    await user.click(await within(history).findByText('Show detail'));

    expect(within(history).getByText('Paid out')).toBeInTheDocument();
    expect(within(history).queryByText(/Nothing has been paid/)).not.toBeInTheDocument();
  });
});

describe('the mode an operator reads', () => {
  it('describes the saved policy, not the switch being edited', async () => {
    const user = dashboard({
      settlements: { policy: () => Promise.resolve({ ...POLICY, automaticEnabled: true }) },
    });

    const panel = (await screen.findByRole('heading', { name: 'Settlement', level: 2 })).closest(
      'section',
    )!;
    expect(await within(panel).findByText('Automatic')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Automatic settlement'));

    // Unticking a box changes nothing at the venue until it is saved.
    expect(within(panel).getByText('Automatic')).toBeInTheDocument();
    expect(within(panel).getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('keeps describing the saved policy after a save is refused', async () => {
    const user = dashboard({
      settlements: {
        policy: () => Promise.resolve({ ...POLICY, automaticEnabled: true }),
        updatePolicy: () =>
          Promise.reject(new DomainError('Settings changed elsewhere', 'CONFLICT')),
      },
    });

    await user.click(await screen.findByLabelText('Automatic settlement'));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('These settings changed elsewhere')).toBeInTheDocument();
    const panel = screen
      .getByRole('heading', { name: 'Settlement', level: 2 })
      .closest('section')!;
    expect(within(panel).getByText('Automatic')).toBeInTheDocument();
  });
});

describe('an unanswered manual run', () => {
  it('keeps its key across a saved policy change', async () => {
    const run = vi
      .fn<(poolId: string, input: RunSettlementInput) => Promise<Settlement>>()
      .mockRejectedValueOnce(new Error('The venue could not be reached.'))
      .mockResolvedValue(settlement({ status: 'SUBMITTING' }));
    const user = dashboard({
      settlements: {
        run,
        updatePolicy: () => Promise.resolve({ ...POLICY, batchSize: 3, version: 5 }),
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Run batch' }));
    await screen.findByText('Batch status unknown');

    // Saving replaces the form the key used to live in.
    const exact = screen.getByLabelText('Batch target, exact');
    await user.clear(exact);
    await user.type(exact, '3');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await user.click(await screen.findByRole('button', { name: 'Run batch' }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]![1]).toEqual(run.mock.calls[0]![1]);
  });

  it('keeps its key across a pool switch and a fresh page', async () => {
    const run = vi
      .fn<(poolId: string, input: RunSettlementInput) => Promise<Settlement>>()
      .mockRejectedValue(new Error('The venue could not be reached.'));
    const user = dashboard({ settlements: { run } }, [POOL, OTHER]);

    await user.click(await screen.findByRole('button', { name: 'Run batch' }));
    await screen.findByText('Batch status unknown');

    await user.selectOptions(screen.getByLabelText('Pool'), OTHER_ID);
    await user.selectOptions(await screen.findByLabelText('Pool'), POOL_ID);
    await user.click(await screen.findByRole('button', { name: 'Run batch' }));

    // A whole new page, as after a reload: the key is still the venue's to
    // resolve, so it is read back rather than replaced.
    cleanup();
    const second = dashboard({ settlements: { run } }, [POOL, OTHER]);
    expect(await screen.findByText('Batch status unknown')).toBeInTheDocument();
    await second.click(screen.getByRole('button', { name: 'Run batch' }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    const keys = run.mock.calls.map((call) => call[1].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('sends nothing when the key cannot be made to survive a reload', async () => {
    const run = vi.fn<(poolId: string, input: RunSettlementInput) => Promise<Settlement>>();
    const setItem = vi
      .spyOn(window.localStorage, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('QuotaExceededError');
      });

    try {
      const user = dashboard({ settlements: { run } });
      await user.click(await screen.findByRole('button', { name: 'Run batch' }));

      expect(await screen.findByText(/will not store the key/)).toBeInTheDocument();
      expect(run).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('what a payout is denominated in', () => {
  it('names the instrument the venue recorded for each fill', async () => {
    const user = dashboard({
      settlements: {
        list: () =>
          Promise.resolve([
            settlement({
              fills: [
                { swapId: 'swap-0001', amountOut: '2941.176470', outputInstrument: USDC },
                { swapId: 'swap-0002', amountOut: '0.048', outputInstrument: BTC },
              ],
            }),
          ]),
      },
    });

    const history = (await screen.findByText('Recent batches')).closest('section')!;
    await user.click(await within(history).findByText('Show detail'));

    // Either side of the pair can be the output, so the fill's own instrument
    // is what says which.
    expect(within(history).getByText(/2,941.17647 USDC/)).toBeInTheDocument();
    expect(within(history).getByText(/0.048 BTC/)).toBeInTheDocument();
  });

  it('says a fill stored without one is unknown, rather than guessing the pair', async () => {
    const user = dashboard({
      settlements: {
        list: () =>
          Promise.resolve([
            settlement({
              fills: [{ swapId: 'swap-0001', amountOut: '2941.176470', outputInstrument: null }],
            }),
          ]),
      },
    });

    const history = (await screen.findByText('Recent batches')).closest('section')!;
    await user.click(await within(history).findByText('Show detail'));

    const unknown = within(history).getByText('token unknown');
    // The pair is named elsewhere on the card; the payout cell itself must
    // carry no instrument at all.
    expect(unknown.closest('td')!.textContent).toBe('2,941.17647 token unknown');
  });

  it('keeps naming an unconfirmed batch’s amounts a projection', async () => {
    const user = dashboard({
      settlements: {
        list: () =>
          Promise.resolve([
            settlement({
              status: 'SUBMITTING',
              after: null,
              fills: [{ swapId: 'swap-0001', amountOut: '2941.176470', outputInstrument: USDC }],
            }),
          ]),
      },
    });

    const history = (await screen.findByText('Recent batches')).closest('section')!;
    await user.click(await within(history).findByText('Show detail'));

    expect(within(history).getByText('Projected, not paid')).toBeInTheDocument();
    expect(within(history).getByText(/2,941.17647 USDC/)).toBeInTheDocument();
  });
});
