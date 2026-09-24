import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DexProvider, type Session } from '../app/runtime';
import { OperatorSettlement } from '../features/settlement/OperatorSettlement';
import {
  DomainError,
  type DepositRequest,
  type PoolDetail,
  type RequestType,
  type RunSettlementInput,
  type Settlement,
  type SettlementHistory,
  type SettlementHistoryQuery,
  type SettlementMonitoring,
  type SettlementPolicy,
  type SettlementPreview,
  type SettlementQueueFilter,
  type SettlementRequest,
  type SettlementRequestRef,
  type Swap,
  type UpdateSettlementPolicy,
  type WithdrawalRequest,
} from '../lib/api/types';
import { testClient } from './clients';
import { pick } from './listbox';
import {
  BTC,
  deposit,
  monitoring,
  OPERATOR,
  POLICIES,
  POOL,
  POOL_ID,
  preview,
  previewStep,
  projected,
  settlement,
  swap,
  TRADER_PARTY,
  USDC,
  withdrawal,
} from './venue-fixtures';

/** A swap as the queue carries it, tagged with its kind and its hold. */
function queued(request: Swap, deferred = false): SettlementRequest {
  return { type: 'swap', request, deferred };
}

function queuedDeposit(request: DepositRequest, deferred = false): SettlementRequest {
  return { type: 'deposit', request, deferred };
}

function queuedWithdrawal(request: WithdrawalRequest, deferred = false): SettlementRequest {
  return { type: 'withdraw', request, deferred };
}

/** One page of history holding exactly these batches. */
function page(...items: Settlement[]): Promise<SettlementHistory> {
  return Promise.resolve({ items, nextCursor: null });
}

/** A queue with nothing to settle, observed where monitoring says the pool and that queue are. */
function nothingToSettle(type: RequestType = 'swap'): SettlementPreview {
  const empty = preview({ steps: [] });
  return { ...empty, selection: { ...empty.selection, type, policyVersion: POLICIES[type].version } };
}

/** One request previewed alone: a batch of one, wherever that request waits in its queue. */
function alonePreview(request: SettlementRequestRef): SettlementPreview {
  return preview({ steps: [previewStep({ request })] });
}

/** The runnable swap batch, as the venue previews it under one version of the swap queue's policy. */
function previewAt(policyVersion: number): SettlementPreview {
  const shown = preview();
  return { ...shown, selection: { ...shown.selection, policyVersion } };
}

/** An observation with one queue's settings replaced, the way a save of that queue leaves them. */
function withPolicy(changed: SettlementPolicy, observed = monitoring()): SettlementMonitoring {
  return {
    ...observed,
    policies: observed.policies.map((policy) => (policy.type === changed.type ? changed : policy)),
  };
}

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
  ...POLICIES.swap,
  poolId: OTHER_ID,
  automaticEnabled: true,
  batchSize: 7,
  version: 9,
};

/** A proportional deposit the preview projects to settle, which is what the deposit queue runs. */
const DEPOSIT_STEP = previewStep({
  request: { type: 'deposit', requestId: 'deposit-0001' },
  fill: {
    type: 'deposit',
    requestId: 'deposit-0001',
    actualBaseIn: '0.05',
    actualQuoteIn: '3000',
    actualBaseRefund: '0',
    actualQuoteRefund: '0',
    actualLpOut: '12.2474486745',
  },
  after: projected('5.05', '303000'),
  outputs: [
    {
      instrument: POOL.settings.lpTokenInstrumentId,
      amount: '12.2474486745',
      minimum: '12.1862114311',
      headroomBps: '50',
    },
  ],
});
const PROPORTIONAL_DEPOSIT = deposit({ terms: { ...deposit().terms, mode: 'PROPORTIONAL' } });

const FIRST_WITHDRAWAL = withdrawal();
const SECOND_WITHDRAWAL = withdrawal({
  requestId: 'withdraw-0002',
  quoteId: 'quote-withdraw-0002',
  arrivalSequence: 4,
  terms: {
    ...FIRST_WITHDRAWAL.terms,
    lpAmount: '40',
    expectedBaseOut: '0.1632993162',
    expectedQuoteOut: '9797.9589711327',
    minBaseOut: '0.1624828196',
    minQuoteOut: '9748.9691762770',
  },
  allocationCids: ['00alloc0024', '00alloc0025', '00alloc0026'],
  updateId: '1220update32',
});

const WITHDRAWAL_BATCH = settlement({
  requests: [
    { type: 'withdraw', requestId: FIRST_WITHDRAWAL.requestId },
    { type: 'withdraw', requestId: SECOND_WITHDRAWAL.requestId },
  ],
  fills: [
    {
      type: 'withdraw',
      requestId: FIRST_WITHDRAWAL.requestId,
      actualLpBurned: '100',
      actualBaseOut: '0.408',
      actualQuoteOut: '24480',
    },
    {
      type: 'withdraw',
      requestId: SECOND_WITHDRAWAL.requestId,
      actualLpBurned: '40',
      actualBaseOut: '0.1632',
      actualQuoteOut: '9792',
    },
  ],
  after: {
    stateId: '00state0002',
    baseReserve: '4.4288',
    quoteReserve: '265728',
    spotPrice: '60000',
    invariant: '1176856.1664',
  },
});

const FIRST_OUTCOME = { burned: '100.00 LP', paid: '0.408 BTC + 24,480.00 USDC' };
const SECOND_OUTCOME = { burned: '40.00 LP', paid: '0.1632 BTC + 9,792.00 USDC' };

/** Three queued swaps, and the preview that stops at the second. */
const SECOND_SWAP = swap({ swapId: 'swap-0002', arrivalSequence: 2 });
const THIRD_SWAP = swap({ swapId: 'swap-0003', arrivalSequence: 3 });
const AFTER_FIRST = projected('5.05', '297049.876544');
const BLOCKED_STEP = previewStep({
  request: { type: 'swap', requestId: 'swap-0002' },
  status: 'BLOCKED',
  fill: null,
  before: AFTER_FIRST,
  after: null,
  outputs: [{ instrument: USDC, amount: '2890.1', minimum: '2926.470588', headroomBps: '-125.8' }],
  errorCode: 'MIN_OUT_NOT_MET',
  error: 'Output is below the signed minimum at the projected reserves',
});
const UNCHECKED_STEP = previewStep({
  request: { type: 'swap', requestId: 'swap-0003' },
  status: 'NOT_EVALUATED',
  fill: null,
  before: AFTER_FIRST,
  after: null,
  outputs: [],
});
const STOPPED = preview({ steps: [previewStep(), BLOCKED_STEP, UNCHECKED_STEP] });

/** Where the venue keeps this operator's unanswered run on the first pool. */
const INTENT_NAME = `dex.settlement-intent.${OPERATOR.accountId}.${POOL_ID}`;

type Parts = Parameters<typeof testClient>[0];
type Run = (poolId: string, input: RunSettlementInput) => Promise<Settlement>;

/** A queue whose next batch is one swap the venue would start now. */
const RUNNABLE: NonNullable<Parts['settlements']> = {
  requests: () => Promise.resolve([queued(swap())]),
  preview: () => Promise.resolve(preview()),
};

function dashboard(parts: Parts = {}, pools: PoolDetail[] = [POOL]) {
  const client = testClient({
    me: () => Promise.resolve(OPERATOR),
    ...parts,
    admin: { listPools: () => Promise.resolve(pools), ...parts.admin },
    settlements: {
      policy: (_poolId, type) => Promise.resolve(POLICIES[type]),
      monitoring: () => Promise.resolve(monitoring()),
      requests: () => Promise.resolve([]),
      list: () => Promise.resolve([]),
      history: () => page(),
      preview: (_poolId, type) => Promise.resolve(nothingToSettle(type)),
      previewRequest: (_poolId, request) => Promise.resolve(alonePreview(request)),
      setDeferred: () => Promise.resolve(),
      // A key nobody has run yet: the venue has no batch under it.
      get: () => Promise.reject(new DomainError('Settlement not found', 'NOT_FOUND')),
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

const RUN_BATCH = 'Run batch';
const BATCH_SIZE = 'Batch size';
const BATCH_SIZE_EXACT = 'Batch size, exact';
const AUTOMATIC = 'Automatic settlement';
const SAVE = 'Save settings';
const CHANGED_ELSEWHERE = 'These settings changed elsewhere';

/** The queue on screen's settings trigger, which names its saved mode and batch size. */
function settingsButton(summary?: string, timeout?: number): Promise<HTMLElement> {
  return screen.findByRole('button', { name: summary ? `Settings: ${summary}` : /^Settings/ }, { timeout });
}

/** Each queue's settings open over its own panel; each pool and queue opens them anew. */
async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await settingsButton());
}

/** Types a batch size into the open settings and saves it. */
async function saveBatchSize(user: ReturnType<typeof userEvent.setup>, size: string) {
  const exact = await screen.findByLabelText(BATCH_SIZE_EXACT);
  await user.clear(exact);
  await user.type(exact, size);
  await user.click(screen.getByRole('button', { name: SAVE }));
}

function cardOf(element: HTMLElement): HTMLElement {
  return element.closest<HTMLElement>('[data-slot="card"]')!;
}

function batchHistory(): Promise<HTMLElement> {
  return screen.findByRole('heading', { name: 'Batch history' }).then(cardOf);
}

/** Opens the listed batch's detail, which is a dialog of its own. */
async function openBatch(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const history = await batchHistory();
  await user.click(await within(history).findByRole('button', { name: /^Details for batch/ }));
  return screen.findByRole('dialog');
}

/** The workspace's Run batch, once the venue's preview allows it. */
async function runButton(): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name: RUN_BATCH });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

/** The requests of the previewed batch, in order. */
async function batchSteps(): Promise<HTMLElement[]> {
  const list = await screen.findByRole('list', { name: /requests in the next batch/ });
  return within(list).getAllByRole('listitem');
}

function chart(): HTMLElement {
  return screen.getByRole('group', { name: /^Reserve trajectory/ });
}

function marker(step: number): HTMLElement {
  return within(chart()).getByRole('button', { name: new RegExp(`^Step ${step},`) });
}

/** Where a marker is drawn, which is where its step leaves the pool. */
function position(element: HTMLElement): [string | null, string | null] {
  const dot = element.querySelector('circle')!;
  return [dot.getAttribute('cx'), dot.getAttribute('cy')];
}

async function showFamily(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(await screen.findByRole('button', { name }));
}

async function queueCard(title: string): Promise<HTMLElement> {
  return cardOf(await screen.findByRole('heading', { name: title }));
}

/** Opens one queued request's detail, which is a dialog of its own. */
async function openRequest(user: ReturnType<typeof userEvent.setup>, requestId: string): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: `Details for request ${requestId}` }));
  return screen.findByRole('dialog');
}

function rowTexts(card: HTMLElement): string[] {
  return within(card)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.textContent ?? '');
}

describe('what the dashboard reads', () => {
  it('asks for the whole outstanding queue, not the ready part alone', async () => {
    const requests = vi.fn((_poolId: string, _status?: SettlementQueueFilter) =>
      Promise.resolve([queued(swap())]),
    );
    dashboard({ settlements: { requests } });

    await screen.findByText('Swap queue');
    await waitFor(() => expect(requests).toHaveBeenCalled());
    // Left to itself the route answers with READY only, which would show a
    // shorter queue than the pool actually has.
    expect(requests.mock.calls[0]?.[1]).toBe('active');
  });

  it('scopes every read to the chosen pool', async () => {
    const policy = vi.fn((poolId: string, _type: RequestType) =>
      Promise.resolve(poolId === POOL_ID ? POLICIES.swap : OTHER_POLICY),
    );
    const requests = vi.fn((_poolId: string) => Promise.resolve([]));
    const previewed = vi.fn((_poolId: string, type: RequestType) => Promise.resolve(nothingToSettle(type)));
    const history = vi.fn((_poolId: string) => page());

    const user = dashboard(
      { settlements: { policy, requests, preview: previewed, history } },
      [POOL, OTHER],
    );
    await screen.findByRole('button', { name: /^Swaps/ });

    await pick(user, 'Pool', OTHER.name);

    await waitFor(() => expect(policy).toHaveBeenLastCalledWith(OTHER_ID, 'swap', expect.anything()));
    await waitFor(() => expect(previewed.mock.calls.at(-1)?.[0]).toBe(OTHER_ID));

    // The screen polls while it is open, so what matters is not how many reads
    // it made but that every one names a pool the reader chose, starting on the
    // first and ending on the second.
    function expectChosenPools(calls: readonly (readonly unknown[])[]) {
      const asked = calls.map((call) => call[0]);
      expect(new Set(asked)).toEqual(new Set([POOL_ID, OTHER_ID]));
      expect(asked.at(0)).toBe(POOL_ID);
      expect(asked.at(-1)).toBe(OTHER_ID);
    }
    expectChosenPools(requests.mock.calls);
    expectChosenPools(previewed.mock.calls);
    expectChosenPools(history.mock.calls);
  });

  it('shows the settings the venue saved for this pool, not the previous pool’s', async () => {
    const user = dashboard(
      {
        settlements: {
          policy: (poolId) => Promise.resolve(poolId === POOL_ID ? POLICIES.swap : OTHER_POLICY),
        },
      },
      [POOL, OTHER],
    );

    await openSettings(user);
    expect(await screen.findByLabelText(BATCH_SIZE_EXACT)).toHaveValue(5);
    expect(screen.getByLabelText(AUTOMATIC)).not.toBeChecked();

    await pick(user, 'Pool', OTHER.name);
    await openSettings(user);

    await waitFor(() => expect(screen.getByLabelText(BATCH_SIZE_EXACT)).toHaveValue(7));
    expect(screen.getByLabelText(AUTOMATIC)).toBeChecked();
  });

  it('shows no settings at all while the newly chosen pool’s are still being read', async () => {
    const user = dashboard(
      {
        settlements: {
          policy: (poolId) =>
            poolId === POOL_ID ? Promise.resolve(POLICIES.swap) : new Promise(() => {}),
        },
      },
      [POOL, OTHER],
    );

    await openSettings(user);
    expect(await screen.findByLabelText(BATCH_SIZE_EXACT)).toHaveValue(5);

    await pick(user, 'Pool', OTHER.name);
    await openSettings(user);

    // The previous pool's batch size must not sit under the new pool's name while
    // the venue is still answering for it.
    await waitFor(() =>
      expect(screen.queryByLabelText(BATCH_SIZE_EXACT)).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Loading this queue's settings…")).toBeInTheDocument();
  });
});

describe('saving one queue’s settings', () => {
  it('sends the queue and the version it read, so a stale form cannot restore an old setting', async () => {
    const updatePolicy = vi.fn(() =>
      Promise.resolve({ ...POLICIES.swap, automaticEnabled: true, batchSize: 3, version: 5 }),
    );
    const user = dashboard({ settlements: { updatePolicy } });

    await openSettings(user);
    await user.click(await screen.findByLabelText(AUTOMATIC));
    await saveBatchSize(user, '3');

    await waitFor(() =>
      expect(updatePolicy).toHaveBeenCalledWith(POOL_ID, 'swap', {
        automaticEnabled: true,
        batchSize: 3,
        expectedVersion: POLICIES.swap.version,
      }),
    );
  });

  it('keeps the slider and the exact field on one value', async () => {
    const user = dashboard();

    await openSettings(user);
    const slider = await screen.findByLabelText(BATCH_SIZE);
    const exact = screen.getByLabelText(BATCH_SIZE_EXACT);
    expect(slider).toHaveValue('5');

    await user.clear(exact);
    await user.type(exact, '8');

    expect(slider).toHaveValue('8');
  });

  it('never carries a batch size above the maximum the venue published', async () => {
    const user = dashboard();

    await openSettings(user);
    const exact = await screen.findByLabelText(BATCH_SIZE_EXACT);
    await user.clear(exact);
    await user.type(exact, '11');
    await user.tab();

    expect(exact).toHaveValue(10);
    expect(screen.getByLabelText(BATCH_SIZE)).toHaveValue('10');
  });

  it('says a conflicting save changed nothing, rather than showing it as saved', async () => {
    const user = dashboard({
      settlements: {
        updatePolicy: () =>
          Promise.reject(new DomainError('Settings changed elsewhere', 'CONFLICT')),
      },
    });

    await openSettings(user);
    await saveBatchSize(user, '2');

    expect(await screen.findByText(CHANGED_ELSEWHERE)).toBeInTheDocument();
    expect(await settingsButton('Manual · 5 per batch')).toBeInTheDocument();
  });

  it('holds the queue’s manual run until a pending save is acknowledged, even with the settings closed', async () => {
    let policyVersion = POLICIES.swap.version;
    let acknowledge = () => {};
    const updatePolicy = vi.fn(
      () =>
        new Promise<SettlementPolicy>((resolve) => {
          acknowledge = () => {
            policyVersion += 1;
            resolve({ ...POLICIES.swap, batchSize: 1, version: policyVersion });
          };
        }),
    );
    const user = dashboard({
      settlements: { ...RUNNABLE, preview: () => Promise.resolve(previewAt(policyVersion)), updatePolicy },
    });

    const run = await runButton();
    await openSettings(user);
    await saveBatchSize(user, '1');

    // A batch dispatched now would run under the batch size being replaced.
    expect(run).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText(BATCH_SIZE_EXACT)).not.toBeInTheDocument();
    expect(run).toBeDisabled();

    await act(async () => acknowledge());
    await waitFor(() => expect(run).toBeEnabled());
    expect(updatePolicy).toHaveBeenCalledTimes(1);
  });

  it('holds the run from the save’s own answer until a preview at that version lands, however late monitoring is', async () => {
    let observe = () => Promise.resolve(monitoring());
    let review = () => Promise.resolve(previewAt(POLICIES.swap.version));
    let release = (_shown: SettlementPreview) => {};
    const user = dashboard({
      settlements: {
        ...RUNNABLE,
        preview: () => review(),
        monitoring: () => observe(),
        updatePolicy: () => Promise.resolve({ ...POLICIES.swap, batchSize: 3, version: 5 }),
      },
    });

    const run = await runButton();
    // From here monitoring answers nothing, and the next preview waits to be released.
    observe = () => new Promise<SettlementMonitoring>(() => {});
    review = () =>
      new Promise<SettlementPreview>((resolve) => {
        release = resolve;
      });
    await openSettings(user);
    await saveBatchSize(user, '3');

    // Version 5 is committed, so the version 4 batch on screen cannot run.
    expect(await settingsButton('Manual · 3 per batch')).toBeInTheDocument();
    await waitFor(() => expect(run).toHaveAccessibleDescription('Refreshing the preview'));
    expect(run).toBeDisabled();

    await act(async () => release(previewAt(5)));
    await waitFor(() => expect(run).toBeEnabled());
  });

  it('follows another operator’s newer settings from monitoring, though this screen read an older version', async () => {
    let observed = monitoring();
    const updatePolicy = vi.fn((_poolId: string, _type: RequestType, input: UpdateSettlementPolicy) =>
      Promise.resolve({ ...POLICIES.swap, ...input, version: 6 }),
    );
    const user = dashboard({
      settlements: { ...RUNNABLE, monitoring: () => Promise.resolve(observed), updatePolicy },
    });

    const run = await runButton();
    await openSettings(user);
    expect(await screen.findByLabelText(BATCH_SIZE_EXACT)).toHaveValue(5);

    observed = withPolicy({ ...POLICIES.swap, automaticEnabled: true, batchSize: 7, version: 5 });

    // The trigger, the open form, the overview and the preview all move to version 5.
    expect(await settingsButton('Automatic · 7 per batch', 10_000)).toBeInTheDocument();
    expect(screen.getByLabelText(BATCH_SIZE_EXACT)).toHaveValue(7);
    expect(screen.getByLabelText(AUTOMATIC)).toBeChecked();
    expect(screen.getByRole('button', { name: /^Swaps/ })).toHaveTextContent('Automatic');
    await waitFor(() => expect(run).toHaveAccessibleDescription('Refreshing the preview'));

    await saveBatchSize(user, '8');
    await waitFor(() =>
      expect(updatePolicy).toHaveBeenCalledWith(POOL_ID, 'swap', {
        automaticEnabled: true,
        batchSize: 8,
        expectedVersion: 5,
      }),
    );
  });

  it('offers no save until something has actually changed', async () => {
    await openSettings(dashboard());

    expect(await screen.findByRole('button', { name: SAVE })).toBeDisabled();
  });
});

describe('each queue on its own settings', () => {
  it('keeps a newer direct read across queue switches while monitoring is behind', async () => {
    const latest = { ...POLICIES.swap, automaticEnabled: true, batchSize: 2, version: 5 };
    const policy = vi.fn((_poolId: string, type: RequestType) =>
      Promise.resolve(type === 'swap' ? latest : POLICIES[type]),
    );
    const user = dashboard({ settlements: { policy } });
    const summary = 'Automatic · 2 per batch';

    expect(await settingsButton(summary)).toBeInTheDocument();
    await showFamily(user, /^Add liquidity/);
    expect(screen.getByRole('button', { name: /^Swaps/ })).toHaveTextContent('Automatic');

    policy.mockImplementation(() => new Promise<SettlementPolicy>(() => {}));
    await showFamily(user, /^Swaps/);
    expect(await settingsButton(summary)).toBeInTheDocument();
  });

  it('reads, shows and saves every queue’s own mode, batch size and version', async () => {
    const policy = vi.fn((_poolId: string, type: RequestType) => Promise.resolve(POLICIES[type]));
    const updatePolicy = vi.fn((_poolId: string, type: RequestType, input: UpdateSettlementPolicy) =>
      Promise.resolve({ ...POLICIES[type], ...input, version: POLICIES[type].version + 1 }),
    );
    const user = dashboard({ settlements: { policy, updatePolicy } });

    // Every queue's saved mode at a glance, from monitoring's own entry for it.
    const deposits = await screen.findByRole('button', { name: /^Add liquidity/ });
    await waitFor(() => expect(deposits).toHaveTextContent('Automatic'));
    expect(screen.getByRole('button', { name: /^Swaps/ })).toHaveTextContent('Manual');
    expect(screen.getByRole('button', { name: /^Withdraw liquidity/ })).toHaveTextContent('Manual');
    expect(await settingsButton('Manual · 5 per batch')).toBeInTheDocument();

    await user.click(deposits);
    await openSettings(user);
    expect(await screen.findByLabelText(BATCH_SIZE_EXACT)).toHaveValue(3);
    expect(screen.getByLabelText(AUTOMATIC)).toBeChecked();
    await saveBatchSize(user, '4');

    await waitFor(() =>
      expect(updatePolicy).toHaveBeenCalledWith(POOL_ID, 'deposit', {
        automaticEnabled: true,
        batchSize: 4,
        expectedVersion: POLICIES.deposit.version,
      }),
    );
    expect(policy).toHaveBeenCalledWith(POOL_ID, 'deposit', expect.anything());

    await user.keyboard('{Escape}');
    await showFamily(user, /^Withdraw liquidity/);
    expect(await settingsButton('Manual · 8 per batch')).toBeInTheDocument();
  });

  it('keeps a save, its answer and its refusal on the queue it was made for', async () => {
    let refuse = () => {};
    const updatePolicy = vi.fn(
      () =>
        new Promise<SettlementPolicy>((_resolve, reject) => {
          refuse = () => reject(new DomainError('Settings changed elsewhere', 'CONFLICT'));
        }),
    );
    const user = dashboard({ settlements: { updatePolicy } });

    await openSettings(user);
    await saveBatchSize(user, '2');
    expect(screen.getByRole('button', { name: SAVE })).toBeDisabled();
    await user.keyboard('{Escape}');

    // The swap save is still waiting, and none of it belongs to the deposit queue.
    await showFamily(user, /^Add liquidity/);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: RUN_BATCH })).toHaveAccessibleDescription('Nothing to settle'),
    );
    await openSettings(user);
    const exact = await screen.findByLabelText(BATCH_SIZE_EXACT);
    expect(exact).toBeEnabled();
    await user.clear(exact);
    await user.type(exact, '6');

    await act(async () => refuse());

    // The refusal lands on the swap queue, and the deposit draft stays as typed.
    expect(screen.queryByText(CHANGED_ELSEWHERE)).not.toBeInTheDocument();
    expect(exact).toHaveValue(6);
    expect(screen.getByRole('button', { name: SAVE })).toBeEnabled();

    await user.keyboard('{Escape}');
    await showFamily(user, /^Swaps/);
    await openSettings(user);
    expect(await screen.findByText(CHANGED_ELSEWHERE)).toBeInTheDocument();
    expect(updatePolicy).toHaveBeenCalledTimes(1);
  });

  it('shows the saved queue’s new settings once it answers, even after the operator moved on', async () => {
    let acknowledge = () => {};
    const updatePolicy = vi.fn(
      (_poolId: string, _type: RequestType, input: UpdateSettlementPolicy) =>
        new Promise<SettlementPolicy>((resolve) => {
          acknowledge = () => resolve({ ...POLICIES.swap, ...input, version: POLICIES.swap.version + 1 });
        }),
    );
    const user = dashboard({ settlements: { updatePolicy } });

    await openSettings(user);
    await saveBatchSize(user, '2');
    await user.keyboard('{Escape}');
    await showFamily(user, /^Add liquidity/);
    await settingsButton('Automatic · 3 per batch');

    await act(async () => acknowledge());

    // The answer is the swap queue's, so the deposit queue on screen keeps its own.
    expect(await settingsButton('Automatic · 3 per batch')).toBeInTheDocument();
    // This screen's read and monitoring still report the old swap version; the answer is newer.
    await showFamily(user, /^Swaps/);
    expect(await settingsButton('Manual · 2 per batch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Swaps/ })).toHaveTextContent('Manual');
  });
});

describe('the next batch, before it runs', () => {
  it('checks each request in order, stops at the first blocker and evaluates nothing after it', async () => {
    dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap()), queued(SECOND_SWAP), queued(THIRD_SWAP)]),
        preview: () => Promise.resolve(STOPPED),
      },
    });

    const [first, second, third] = await batchSteps();
    expect(within(first!).getByText('Projected')).toBeInTheDocument();
    // The projected payout, the signed minimum and the venue's own headroom.
    expect(first).toHaveTextContent('2,950.123456 USDC');
    expect(first).toHaveTextContent('min 2,926.470588 USDC');
    expect(first).toHaveTextContent('80.1 bps');
    expect(within(second!).getByText('Blocked')).toBeInTheDocument();
    expect(second).toHaveTextContent('Output is below the signed minimum at the projected reserves');
    expect(within(third!).getByText('Not evaluated')).toBeInTheDocument();

    // A failed request moves nothing, and nothing after it is drawn at all.
    expect(position(marker(2))).toEqual(position(marker(1)));
    expect(within(chart()).queryByRole('button', { name: /^Step 3,/ })).not.toBeInTheDocument();
    // The batch as a whole cannot run, so the key ends where the blocker would start.
    const key = screen.getByRole('region', { name: 'Projected prefix' });
    expect(within(key).getByText('Before blocker')).toBeInTheDocument();
    expect(within(key).queryByText('After the batch')).not.toBeInTheDocument();

    const run = screen.getByRole('button', { name: RUN_BATCH });
    await waitFor(() => expect(run).toHaveAccessibleDescription('Step 2 is blocked'));
    expect(run).toBeDisabled();
  });

  it('marks an output at or under ten basis points of headroom as a thin margin', async () => {
    dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap()), queued(SECOND_SWAP)]),
        preview: () =>
          Promise.resolve(
            preview({
              steps: [
                // The usual quote slippage leaves this much room, which is no warning.
                previewStep({
                  outputs: [{ instrument: USDC, amount: '2941.17647', minimum: '2926.470588', headroomBps: '50' }],
                }),
                previewStep({
                  request: { type: 'swap', requestId: 'swap-0002' },
                  outputs: [{ instrument: USDC, amount: '2929.4', minimum: '2926.470588', headroomBps: '10' }],
                }),
              ],
            }),
          ),
      },
    });

    const [usual, thin] = await batchSteps();
    expect(within(usual!).getByText('Projected')).toBeInTheDocument();
    expect(within(thin!).getByText('Thin margin')).toBeInTheDocument();
    expect(thin).toHaveTextContent('10 bps');
    // A thin margin is a warning, not a refusal: the venue would still run it.
    await runButton();
  });

  it('draws the constant-product guide for swaps and none for liquidity', async () => {
    const user = dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap()), queuedDeposit(PROPORTIONAL_DEPOSIT)]),
        preview: (_poolId, type) =>
          Promise.resolve(type === 'swap' ? preview() : preview({ steps: [DEPOSIT_STEP] })),
      },
    });

    await batchSteps();
    expect(chart().querySelector('[data-slot="swap-curve"]')).not.toBeNull();

    await showFamily(user, /^Add liquidity/);
    const [step] = await batchSteps();
    // An LP output reads as LP, as it does in the queue.
    expect(step).toHaveTextContent('12.2474486745 LP');
    expect(chart().querySelector('[data-slot="swap-curve"]')).toBeNull();
  });

  it('shows a queue with nothing to settle as the observed state alone, with no move', async () => {
    dashboard();

    const run = await screen.findByRole('button', { name: RUN_BATCH });
    await waitFor(() => expect(run).toHaveAccessibleDescription('Nothing to settle'));
    expect(run).toBeDisabled();
    expect(within(chart()).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('No projected move', { selector: 'figcaption span' })).toBeInTheDocument();
  });

  it('draws nothing it cannot scale, such as an empty pool no step would fill', async () => {
    const empty = monitoring({
      pool: {
        ...monitoring().pool,
        reserves: { stateId: '00state0001', baseReserve: '0', quoteReserve: '0', spotPrice: null, invariant: '0' },
        lpTokenSupply: '0',
        health: 'EMPTY',
      },
    });
    dashboard({
      settlements: {
        monitoring: () => Promise.resolve(empty),
        preview: () => Promise.resolve({ ...nothingToSettle(), pool: empty.pool }),
      },
    });

    expect(await screen.findByText('No reserves to chart')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('links the chart and the list for hover, focus and a pinned step, from the keyboard too', async () => {
    const user = dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap()), queued(SECOND_SWAP), queued(THIRD_SWAP)]),
        preview: () => Promise.resolve(STOPPED),
      },
    });

    const [first, second, third] = await batchSteps();
    await user.hover(second!);
    expect(marker(2)).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('heading', { name: 'Step 2 · Blocked' })).toBeInTheDocument();
    await user.unhover(second!);

    await user.hover(marker(1));
    expect(first).toHaveAttribute('data-active', 'true');
    await user.unhover(marker(1));

    // One tab stop for the chart; the arrows walk the steps and Enter pins one.
    await user.click(marker(1));
    expect(within(first!).getAllByRole('button')[0]).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{ArrowRight}');
    expect(marker(2)).toHaveFocus();
    expect(second).toHaveAttribute('data-active', 'true');
    await user.keyboard('{Enter}');
    expect(within(second!).getAllByRole('button')[0]).toHaveAttribute('aria-pressed', 'true');
    expect(within(first!).getAllByRole('button')[0]).toHaveAttribute('aria-pressed', 'false');
    expect(marker(2)).toHaveAttribute('aria-pressed', 'true');

    // An unchecked step has no marker and no projected state, and the chart keeps its tab stop.
    await user.click(within(third!).getAllByRole('button')[0]!);
    expect(within(screen.getByRole('region', { name: 'Step 3' })).queryByText('Before')).not.toBeInTheDocument();
    expect(marker(1)).toHaveAttribute('tabindex', '0');
    expect(marker(2)).toHaveAttribute('tabindex', '-1');
  });

  it('reads the preview again once the pool moves on, and holds the run until it has', async () => {
    let version = monitoring().pool.version;
    const later = '00state0002:00config0001';
    const previewed = vi.fn(() => {
      const current = preview();
      return Promise.resolve({
        ...current,
        pool: { ...current.pool, version },
        selection: { ...current.selection, stateVersion: version },
      });
    });
    dashboard({
      settlements: {
        requests: RUNNABLE.requests,
        preview: previewed,
        monitoring: () => Promise.resolve(monitoring({ pool: { ...monitoring().pool, version } })),
      },
    });

    await runButton();
    const reads = previewed.mock.calls.length;
    version = later;

    await waitFor(() => expect(previewed.mock.calls.length).toBeGreaterThan(reads), { timeout: 10_000 });
    await runButton();
  });

  it('reads the preview again for its own queue’s new settings, and never for another queue’s', async () => {
    let observed = monitoring();
    let swapVersion = POLICIES.swap.version;
    const observe = vi.fn(() => Promise.resolve(observed));
    const previewed = vi.fn(() => Promise.resolve(previewAt(swapVersion)));
    dashboard({ settlements: { requests: RUNNABLE.requests, preview: previewed, monitoring: observe } });

    const run = await runButton();
    const reads = previewed.mock.calls.length;

    // Another operator switches the deposit queue to manual: the swap batch stays reviewed and runnable.
    observed = withPolicy({ ...POLICIES.deposit, automaticEnabled: false, version: POLICIES.deposit.version + 1 });
    const deposits = screen.getByRole('button', { name: /^Add liquidity/ });
    await waitFor(() => expect(deposits).toHaveTextContent('Manual'), { timeout: 10_000 });
    const polls = observe.mock.calls.length;
    await waitFor(() => expect(observe.mock.calls.length).toBeGreaterThan(polls), { timeout: 10_000 });
    expect(previewed).toHaveBeenCalledTimes(reads);
    expect(run).toBeEnabled();

    // The swap queue's own settings move on, so its preview is read again before it can run.
    swapVersion += 1;
    observed = withPolicy({ ...POLICIES.swap, batchSize: 3, version: swapVersion }, observed);
    await waitFor(() => expect(previewed.mock.calls.length).toBeGreaterThan(reads), { timeout: 10_000 });
    await runButton();
  });

  it('holds the run on a preview it could not read again, and keeps that preview in view', async () => {
    let reachable = true;
    const user = dashboard({
      settlements: {
        ...RUNNABLE,
        preview: () =>
          reachable ? Promise.resolve(preview()) : Promise.reject(new Error('The venue could not be reached.')),
      },
    });

    const run = await runButton();
    reachable = false;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(run).toHaveAccessibleDescription('Could not refresh the preview'));
    expect(run).toBeDisabled();
    expect(await batchSteps()).toHaveLength(1);

    reachable = true;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await runButton();
  });

  it('holds every queue’s run while the pool has a batch in flight, and a run past a deadline', async () => {
    const user = dashboard({
      settlements: {
        ...RUNNABLE,
        monitoring: () =>
          Promise.resolve(monitoring({ activeSettlement: settlement({ settlementId: 'settle-live', status: 'SUBMITTING' }) })),
      },
    });

    const run = await screen.findByRole('button', { name: RUN_BATCH });
    await waitFor(() => expect(run).toHaveAccessibleDescription('A batch is in flight'));
    expect(run).toBeDisabled();
    expect(screen.getByText(/Batch in flight/)).toHaveTextContent('settle-live');
    // The pool runs one batch at a time, whichever queue it came from.
    await showFamily(user, /^Add liquidity/);
    const deposits = within(await queueCard('Add liquidity queue')).getByRole('button', { name: RUN_BATCH });
    await waitFor(() => expect(deposits).toHaveAccessibleDescription('A batch is in flight'));
    expect(deposits).toBeDisabled();
    cleanup();

    dashboard({
      settlements: {
        ...RUNNABLE,
        requests: () =>
          Promise.resolve([queued(swap({ settlementDeadline: new Date(Date.now() - 1000).toISOString() }))]),
      },
    });

    const expired = await screen.findByRole('button', { name: RUN_BATCH });
    await waitFor(() => expect(expired).toHaveAccessibleDescription('A deadline has elapsed'));
    expect(expired).toBeDisabled();
  });
});

describe('running the previewed batch', () => {
  it('sends exactly the previewed selection under one key, and nothing more on a double click', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let recent: Settlement[] = [];
    const list = vi.fn(() => Promise.resolve(recent));
    const run = vi.fn(async (_poolId: string, _input: RunSettlementInput) => {
      await held;
      // The venue's worker takes the batch on as soon as it exists.
      recent = [settlement({ status: 'CONFIRMED', updatedAt: '2026-09-19T12:01:09Z' })];
      return settlement({ status: 'PREPARING' });
    });
    const user = dashboard({ settlements: { ...RUNNABLE, run, list } });

    const button = await runButton();
    await user.click(button);
    await user.click(button);
    await act(async () => release());

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const [poolId, input] = run.mock.calls[0]!;
    expect(poolId).toBe(POOL_ID);
    expect(input.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(input.selection).toEqual(preview().selection);
    // Answered, so nothing is left outstanding for a reload to find.
    await waitFor(() => expect(window.localStorage.getItem(INTENT_NAME)).toBeNull());
    // The last run follows its batch as the venue moves it on, not the answer it came with.
    await waitFor(() => expect(screen.getByText(/Last run/)).toHaveTextContent('Confirmed'));

    // Newer batches push it out of the bounded list, and it keeps the state it reached. A
    // second read after the change means the first one is already on screen.
    recent = [settlement({ settlementId: 'settle-0002' })];
    const reads = list.mock.calls.length;
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(reads + 1), { timeout: 10_000 });
    expect(screen.getByText(/Last run/)).toHaveTextContent('Confirmed');
  });

  it('repeats the same key and the same selection after an unknown outcome', async () => {
    const run = vi
      .fn<Run>()
      .mockRejectedValueOnce(new Error('The venue could not be reached.'))
      // Refused before the venue looked the key up, so the first send may still have made a batch.
      .mockRejectedValueOnce(new DomainError('Operator access required', 'FORBIDDEN'))
      .mockResolvedValue(settlement({ status: 'SUBMITTING' }));
    const user = dashboard({ settlements: { ...RUNNABLE, run } });

    await user.click(await runButton());
    await screen.findByText('Batch status unknown');
    // No new run starts on any queue of the pool while this one has no answer.
    expect(screen.getByRole('button', { name: RUN_BATCH })).toHaveAccessibleDescription(
      'The last run is unresolved',
    );
    await showFamily(user, /^Add liquidity/);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: RUN_BATCH })).toHaveAccessibleDescription(
        'The last run is unresolved',
      ),
    );
    expect(screen.getByText('Batch status unknown')).toBeInTheDocument();
    await showFamily(user, /^Swaps/);
    await user.click(await screen.findByRole('button', { name: 'Retry this run' }));

    expect(await screen.findByText(/Operator access required/)).toBeInTheDocument();
    expect(screen.getByText('Batch status unknown')).toBeInTheDocument();
    expect(window.localStorage.getItem(INTENT_NAME)).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry this run' }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(run.mock.calls[1]![1]).toEqual(run.mock.calls[0]![1]);
    expect(run.mock.calls[2]![1]).toEqual(run.mock.calls[0]![1]);
  });

  it('treats a stale selection the venue refused as answered, and previews again', async () => {
    const previewed = vi.fn(() => Promise.resolve(preview()));
    const run = vi
      .fn<Run>()
      .mockRejectedValueOnce(new DomainError('Queue changed. Refresh the preview.', 'CONFLICT', 'QUEUE_CHANGED'))
      .mockResolvedValue(settlement({ status: 'SUBMITTING' }));
    const user = dashboard({ settlements: { ...RUNNABLE, preview: previewed, run } });

    await user.click(await runButton());

    expect(await screen.findByText('Queue changed. Refresh the preview.')).toBeInTheDocument();
    expect(screen.queryByText('Batch status unknown')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INTENT_NAME)).toBeNull();
    await waitFor(() => expect(previewed.mock.calls.length).toBeGreaterThan(1));

    // The refused key made nothing, so the next run is a new intent.
    await user.click(await runButton());
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]![1].idempotencyKey).not.toBe(run.mock.calls[0]![1].idempotencyKey);
  });

  it('keeps the unanswered key with its own selection across a newer preview and a policy save', async () => {
    let shown = preview();
    const run = vi
      .fn<Run>()
      .mockRejectedValueOnce(new Error('The venue could not be reached.'))
      .mockResolvedValue(settlement({ status: 'SUBMITTING' }));
    const user = dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap()), queued(SECOND_SWAP)]),
        preview: () => Promise.resolve(shown),
        run,
        updatePolicy: () => Promise.resolve({ ...POLICIES.swap, batchSize: 3, version: 5 }),
      },
    });

    await user.click(await runButton());
    await screen.findByText('Batch status unknown');

    // The queue moves on and its policy is saved, which reads a new preview.
    shown = preview({ steps: [previewStep({ request: { type: 'swap', requestId: 'swap-0002' } })] });
    await openSettings(user);
    await saveBatchSize(user, '3');
    const steps = await screen.findByRole('list', { name: /requests in the next batch/ });
    await within(steps).findByText('swap-0002');

    await user.click(screen.getByRole('button', { name: 'Retry this run' }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]![1]).toEqual(run.mock.calls[0]![1]);
    expect(run.mock.calls[1]![1].selection?.requests).toEqual([{ type: 'swap', requestId: 'swap-0001' }]);
  });

  it('keeps the key across a pool switch and a fresh page, and resends the same intent', async () => {
    const run = vi.fn<Run>().mockRejectedValue(new Error('The venue could not be reached.'));
    const user = dashboard({ settlements: { ...RUNNABLE, run } }, [POOL, OTHER]);

    await user.click(await runButton());
    await screen.findByText('Batch status unknown');

    await pick(user, 'Pool', OTHER.name);
    await pick(user, 'Pool', POOL.name);
    await user.click(await screen.findByRole('button', { name: 'Retry this run' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    // A whole new page, as after a reload: the intent is still the venue's to
    // resolve, so it is read back rather than replaced.
    cleanup();
    const second = dashboard({ settlements: { ...RUNNABLE, run } }, [POOL, OTHER]);
    expect(await screen.findByText('Batch status unknown')).toBeInTheDocument();
    await second.click(screen.getByRole('button', { name: 'Retry this run' }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    const inputs = run.mock.calls.map((call) => call[1]);
    expect(new Set(inputs.map((input) => input.idempotencyKey)).size).toBe(1);
    expect(inputs[2]).toEqual(inputs[0]);
  });

  it('settles an unanswered run from the batch its key made, before offering a new one', async () => {
    const intent = { idempotencyKey: '11111111-0000-4000-8000-000000000042', selection: preview().selection };
    window.localStorage.setItem(INTENT_NAME, JSON.stringify(intent));
    const get = vi.fn((settlementId: string) =>
      Promise.resolve(settlement({ settlementId, status: 'SUBMITTING' })),
    );
    const run = vi.fn<Run>();
    dashboard({ settlements: { ...RUNNABLE, get, run } });

    await waitFor(() => expect(get).toHaveBeenCalledWith(intent.idempotencyKey, expect.anything()));
    await waitFor(() => expect(window.localStorage.getItem(INTENT_NAME)).toBeNull());
    expect(screen.queryByText('Batch status unknown')).not.toBeInTheDocument();
    await runButton();
    expect(run).not.toHaveBeenCalled();
  });

  it('sends nothing when the key cannot be made to survive a reload', async () => {
    const run = vi.fn<Run>();
    const user = dashboard({ settlements: { ...RUNNABLE, run } });
    const button = await runButton();
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('QuotaExceededError');
      });

    try {
      await user.click(button);

      expect(await screen.findByText(/will not store the key/)).toBeInTheDocument();
      expect(run).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it('never runs the previous pool’s preview on the pool now chosen', async () => {
    const run = vi.fn<Run>((poolId) => Promise.resolve(settlement({ poolId, status: 'SUBMITTING' })));
    const otherStep = previewStep({ request: { type: 'swap', requestId: 'swap-eth-0001' } });
    const user = dashboard(
      {
        settlements: {
          requests: (poolId) =>
            Promise.resolve([queued(poolId === POOL_ID ? swap() : swap({ swapId: 'swap-eth-0001' }))]),
          preview: (poolId) => {
            if (poolId === POOL_ID) return Promise.resolve(preview());
            const other = preview({ steps: [otherStep] });
            return Promise.resolve({ ...other, pool: { ...other.pool, poolId: OTHER_ID } });
          },
          run,
        },
      },
      [POOL, OTHER],
    );

    await user.click(within((await batchSteps())[0]!).getAllByRole('button')[0]!);
    await pick(user, 'Pool', OTHER.name);
    await within((await batchSteps())[0]!).findByText('swap-eth-0001');
    await user.click(await runButton());

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]![0]).toBe(OTHER_ID);
    expect(run.mock.calls[0]![1].selection?.requests).toEqual([otherStep.request]);
  });

  it('runs only the queue on screen, from its own panel, and never the queue shown before it', async () => {
    let release = (_shown: SettlementPreview) => {};
    const deposits = new Promise<SettlementPreview>((resolve) => {
      release = resolve;
    });
    const run = vi.fn<Run>(() => Promise.resolve(settlement({ status: 'SUBMITTING' })));
    const user = dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap()), queuedDeposit(PROPORTIONAL_DEPOSIT)]),
        preview: (_poolId, type) => (type === 'swap' ? Promise.resolve(preview()) : deposits),
        run,
      },
    });

    await runButton();
    await showFamily(user, /^Add liquidity/);
    // The swap batch reviewed a moment ago is not this queue's, so nothing runs before its own preview.
    const button = within(await queueCard('Add liquidity queue')).getByRole('button', { name: RUN_BATCH });
    await waitFor(() => expect(button).toHaveAccessibleDescription('Loading the preview'));
    expect(button).toBeDisabled();

    await act(async () => release(preview({ steps: [DEPOSIT_STEP] })));
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveAccessibleDescription('1 in the next batch');
    await user.click(button);

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const selection = run.mock.calls[0]![1].selection;
    expect(selection?.type).toBe('deposit');
    expect(selection?.requests).toEqual([DEPOSIT_STEP.request]);
    expect(selection?.policyVersion).toBe(POLICIES.deposit.version);
  });
});

describe('running one request alone', () => {
  const RUN_REQUEST = 'Run request';

  it.each([
    {
      type: 'swap',
      family: /^Swaps/,
      queue: [queued(swap({ status: 'BLOCKED' })), queued(SECOND_SWAP)],
      requestId: SECOND_SWAP.swapId,
    },
    {
      type: 'deposit',
      family: /^Add liquidity/,
      queue: [
        queuedDeposit(deposit({ status: 'BLOCKED' })),
        queuedDeposit(deposit({ requestId: 'deposit-0002', arrivalSequence: 9 })),
      ],
      requestId: 'deposit-0002',
    },
    {
      type: 'withdraw',
      family: /^Withdraw liquidity/,
      queue: [queuedWithdrawal(withdrawal({ status: 'BLOCKED' })), queuedWithdrawal(SECOND_WITHDRAWAL)],
      requestId: SECOND_WITHDRAWAL.requestId,
    },
  ] as const)('runs a $type request alone from its detail, past a blocked head, exactly as previewed', async ({
    type,
    family,
    queue,
    requestId,
  }) => {
    const previewRequest = vi.fn((_poolId: string, request: SettlementRequestRef) =>
      Promise.resolve(alonePreview(request)),
    );
    const run = vi.fn<Run>((_poolId, input) =>
      Promise.resolve(settlement({ status: 'SUBMITTING', requests: input.selection!.requests })),
    );
    const user = dashboard({ settlements: { requests: () => Promise.resolve([...queue]), previewRequest, run } });

    await showFamily(user, family);
    const dialog = await openRequest(user, requestId);
    // Opening the detail previews the request alone, and sends nothing.
    const button = within(dialog).getByRole('button', { name: RUN_REQUEST });
    await waitFor(() => expect(button).toBeEnabled());
    expect(previewRequest).toHaveBeenCalledWith(POOL_ID, { type, requestId }, expect.anything());
    expect(within(dialog).getByText('Projected')).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();

    await user.click(button);

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]![1].selection).toEqual({
      type,
      retryOf: null,
      stateVersion: monitoring().pool.version,
      policyVersion: POLICIES[type].version,
      requests: [{ type, requestId }],
    });
    // Sent is not settled: only a confirmed batch is.
    expect(within(dialog).getByText('Not settled yet.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: RUN_REQUEST })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Batch in flight/)).toBeInTheDocument();
  });

  it('shows a confirmed response immediately while the queue and batch list are still behind', async () => {
    const run = vi.fn<Run>((_poolId, input) => Promise.resolve(settlement({
      requests: input.selection!.requests,
      fills: [{ type: 'swap', requestId: SECOND_SWAP.swapId, amountOut: '42', outputInstrument: USDC }],
    })));
    const user = dashboard({
      settlements: { requests: () => Promise.resolve([queued(swap()), queued(SECOND_SWAP)]), run },
    });
    const dialog = await openRequest(user, SECOND_SWAP.swapId);
    const button = within(dialog).getByRole('button', { name: RUN_REQUEST });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    expect(await within(dialog).findByText('Settled')).toBeInTheDocument();
    expect(within(dialog).queryByText('Not settled yet.')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: RUN_REQUEST })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    const other = await openRequest(user, 'swap-0001');
    expect(within(other).getByText('Not settled yet.')).toBeInTheDocument();
    await waitFor(() => expect(within(other).getByRole('button', { name: RUN_REQUEST })).toBeEnabled());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('holds a deferred request until it returns to its queue, and offers no run for an expired one', async () => {
    const previewRequest = vi.fn((_poolId: string, request: SettlementRequestRef) =>
      Promise.resolve(alonePreview(request)),
    );
    const lapsed = swap({
      swapId: 'swap-0003',
      arrivalSequence: 3,
      settlementDeadline: new Date(Date.now() - 60_000).toISOString(),
    });
    const user = dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap()), queued(SECOND_SWAP, true), queued(lapsed)]),
        previewRequest,
      },
    });

    const held = within(await openRequest(user, SECOND_SWAP.swapId)).getByRole('button', { name: RUN_REQUEST });
    expect(held).toBeDisabled();
    expect(held).toHaveAccessibleDescription('Return to queue first');
    await user.keyboard('{Escape}');

    const expired = await openRequest(user, lapsed.swapId);
    expect(within(expired).queryByRole('button', { name: RUN_REQUEST })).not.toBeInTheDocument();
    // Neither was previewed: the venue would refuse both.
    expect(previewRequest).not.toHaveBeenCalled();
  });

  it('never runs a preview of a request or a pool the operator has moved past', async () => {
    let answerFirst = (_shown: SettlementPreview) => {};
    const previewRequest = vi.fn((poolId: string, request: SettlementRequestRef) =>
      request.requestId === 'swap-0001'
        ? new Promise<SettlementPreview>((resolve) => {
            answerFirst = resolve;
          })
        : Promise.resolve({ ...alonePreview(request), pool: { ...monitoring().pool, poolId } }),
    );
    const run = vi.fn<Run>((poolId) => Promise.resolve(settlement({ poolId, status: 'SUBMITTING' })));
    const user = dashboard(
      {
        settlements: {
          requests: (poolId) =>
            Promise.resolve(
              poolId === POOL_ID ? [queued(swap()), queued(SECOND_SWAP)] : [queued(swap({ swapId: 'swap-eth-0001' }))],
            ),
          previewRequest,
          run,
        },
      },
      [POOL, OTHER],
    );

    // The first request's preview is still on its way when the operator moves to the second.
    let dialog = await openRequest(user, 'swap-0001');
    expect(within(dialog).getByRole('button', { name: RUN_REQUEST })).toHaveAccessibleDescription(
      'Loading the preview',
    );
    await user.keyboard('{Escape}');
    dialog = await openRequest(user, SECOND_SWAP.swapId);
    await act(async () => answerFirst(alonePreview({ type: 'swap', requestId: 'swap-0001' })));
    const second = within(dialog).getByRole('button', { name: RUN_REQUEST });
    await waitFor(() => expect(second).toBeEnabled());
    await user.click(second);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]![1].selection?.requests).toEqual([{ type: 'swap', requestId: SECOND_SWAP.swapId }]);

    // Another pool starts from its own request's preview.
    await user.keyboard('{Escape}');
    await pick(user, 'Pool', OTHER.name);
    dialog = await openRequest(user, 'swap-eth-0001');
    const other = within(dialog).getByRole('button', { name: RUN_REQUEST });
    await waitFor(() => expect(other).toBeEnabled());
    await user.click(other);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]![0]).toBe(OTHER_ID);
    expect(run.mock.calls[1]![1].selection?.requests).toEqual([{ type: 'swap', requestId: 'swap-eth-0001' }]);
  });

  it('keeps an unanswered run of one request under its key and selection, and retries it from the detail', async () => {
    const run = vi
      .fn<Run>()
      .mockRejectedValueOnce(new Error('The venue could not be reached.'))
      .mockResolvedValue(settlement({ status: 'SUBMITTING' }));
    const user = dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap({ status: 'BLOCKED' })), queued(SECOND_SWAP)]),
        run,
      },
    });

    const dialog = await openRequest(user, SECOND_SWAP.swapId);
    const button = within(dialog).getByRole('button', { name: RUN_REQUEST });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    // The outcome is unknown, so no new run starts, and the same one can go again from here.
    expect(await within(dialog).findByText('Batch status unknown')).toBeInTheDocument();
    expect(button).toHaveAccessibleDescription('The last run is unresolved');
    expect(window.localStorage.getItem(INTENT_NAME)).not.toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Retry this run' }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]![1]).toEqual(run.mock.calls[0]![1]);
    expect(run.mock.calls[0]![1].selection?.requests).toEqual([{ type: 'swap', requestId: SECOND_SWAP.swapId }]);
  });
});

describe('holding a request back', () => {
  it('defers the blocker, refreshes every read, and runs what is left as the preview now shows it', async () => {
    let deferred = false;
    const setDeferred = vi.fn((_poolId: string, _request: SettlementRequestRef, next: boolean) => {
      deferred = next;
      return Promise.resolve();
    });
    const previewed = vi.fn(() =>
      Promise.resolve(deferred ? preview({ steps: [previewStep(), previewStep({ request: { type: 'swap', requestId: 'swap-0003' } })] }) : STOPPED),
    );
    const run = vi.fn<Run>(() => Promise.resolve(settlement({ status: 'SUBMITTING' })));
    const user = dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap()), queued(SECOND_SWAP, deferred), queued(THIRD_SWAP)]),
        preview: previewed,
        setDeferred,
        run,
      },
    });

    const [, blocker] = await batchSteps();
    await user.click(within(blocker!).getByRole('button', { name: 'Defer request swap-0002' }));

    await waitFor(() =>
      expect(setDeferred).toHaveBeenCalledWith(POOL_ID, { type: 'swap', requestId: 'swap-0002' }, true),
    );
    // The hold is a scheduling choice, listed apart from the queue it left.
    const held = await queueCard('Deferred · Swaps');
    expect(within(held).getByText('swap-0002')).toBeInTheDocument();
    expect(within(await queueCard('Swap queue')).queryByText('swap-0002')).not.toBeInTheDocument();

    await user.click(await runButton());
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]![1].selection?.requests).toEqual([
      { type: 'swap', requestId: 'swap-0001' },
      { type: 'swap', requestId: 'swap-0003' },
    ]);
  });

  it('returns a deferred request to its queue, and counts it apart from the ready ones', async () => {
    const setDeferred = vi.fn(() => Promise.resolve());
    const user = dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap()), queued(SECOND_SWAP, true)]),
        setDeferred,
      },
    });

    const swaps = await screen.findByRole('button', { name: /^Swaps/ });
    await waitFor(() => expect(swaps).toHaveTextContent('1 ready'));
    expect(swaps).toHaveTextContent('Deferred 1');

    const held = await queueCard('Deferred · Swaps');
    await user.click(within(held).getByRole('button', { name: 'Return to queue: request swap-0002' }));

    await waitFor(() =>
      expect(setDeferred).toHaveBeenCalledWith(POOL_ID, { type: 'swap', requestId: 'swap-0002' }, false),
    );
  });

  it('keeps an expired deferred request visibly expired, with no way back into a batch', async () => {
    const lapsed = swap({
      swapId: 'swap-0002',
      arrivalSequence: 2,
      settlementDeadline: new Date(Date.now() - 60_000).toISOString(),
    });
    dashboard({ settlements: { requests: () => Promise.resolve([queued(lapsed, true)]) } });

    const held = await queueCard('Deferred · Swaps');
    expect(within(held).getByText('Elapsed')).toBeInTheDocument();
    expect(within(held).getByRole('button', { name: 'Return to queue: request swap-0002' })).toBeDisabled();
  });

  it('changes no hold while the pool has a batch in flight', async () => {
    dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap()), queued(SECOND_SWAP, true)]),
        monitoring: () => Promise.resolve(monitoring({ activeSettlement: settlement({ status: 'SUBMITTING' }) })),
      },
    });

    const queue = await queueCard('Swap queue');
    await waitFor(() =>
      expect(within(queue).getByRole('button', { name: 'Defer request swap-0001' })).toBeDisabled(),
    );
    const held = await queueCard('Deferred · Swaps');
    expect(within(held).getByRole('button', { name: 'Return to queue: request swap-0002' })).toBeDisabled();
  });
});

describe('reviewing a retry', () => {
  const REJECTED = settlement({
    settlementId: 'settle-old',
    status: 'REJECTED',
    requests: [
      { type: 'swap', requestId: 'swap-0001' },
      { type: 'swap', requestId: 'swap-0002' },
    ],
    fills: [],
    after: null,
    errorCode: 'MIN_OUT_NOT_MET',
    error: 'Output below the signed minimum',
  });

  it('previews what the attempt still has eligible, and runs it as a new batch that names it', async () => {
    const previewed = vi.fn((_poolId: string, type: RequestType, retryOf?: string) => {
      const shown = retryOf ? preview() : nothingToSettle(type);
      return Promise.resolve({ ...shown, selection: { ...shown.selection, retryOf: retryOf ?? null } });
    });
    const run = vi.fn<Run>(() =>
      Promise.resolve(settlement({ settlementId: 'settle-new', status: 'SUBMITTING', retryOf: 'settle-old' })),
    );
    const user = dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap())]),
        preview: previewed,
        history: () => page(REJECTED),
        run,
      },
    });

    const history = await batchHistory();
    await user.click(await within(history).findByRole('button', { name: 'Review retry of batch settle-old' }));

    await waitFor(() => expect(previewed).toHaveBeenLastCalledWith(POOL_ID, 'swap', 'settle-old', expect.anything()));
    const workspace = screen.getByRole('region', { name: /next batch/ });
    await waitFor(() => expect(workspace).toHaveFocus());
    expect(workspace).toHaveTextContent('Retry of settle-old');
    // Reviewing runs nothing: the operator runs it.
    expect(run).not.toHaveBeenCalled();

    await user.click(await runButton());
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]![1].selection?.retryOf).toBe('settle-old');
    // The new batch is the retry, so the workspace is back on the queue.
    await waitFor(() => expect(previewed).toHaveBeenLastCalledWith(POOL_ID, 'swap', undefined, expect.anything()));
  });

  it('offers a retry for rejected and cancelled attempts only', async () => {
    dashboard({
      settlements: {
        history: () =>
          page(
            settlement({ settlementId: 'settle-a', status: 'PREPARING' }),
            settlement({ settlementId: 'settle-b', status: 'SUBMITTING' }),
            settlement({ settlementId: 'settle-c', status: 'UNRESOLVED' }),
            settlement({ settlementId: 'settle-d' }),
            settlement({ settlementId: 'settle-e', status: 'CANCELLED' }),
            settlement({ settlementId: 'settle-f', status: 'REJECTED', retryOf: 'settle-e' }),
          ),
      },
    });

    const history = await batchHistory();
    const offered = await within(history).findAllByRole('button', { name: /^Review retry of batch/ });
    expect(offered.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Review retry of batch settle-e',
      'Review retry of batch settle-f',
    ]);
    // A retry names the attempt it followed, which stays as it was.
    expect(within(history).getByText('settle-e', { selector: '.font-mono' })).toBeInTheDocument();
  });
});

describe('the batch history', () => {
  it('pages back through older batches and forward again', async () => {
    const newest = settlement({ settlementId: 'settle-new' });
    const oldest = settlement({ settlementId: 'settle-old', status: 'CANCELLED' });
    const history = vi.fn((_poolId: string, query?: SettlementHistoryQuery) =>
      Promise.resolve<SettlementHistory>(
        query?.before === 'cursor-2' ? { items: [oldest], nextCursor: null } : { items: [newest], nextCursor: 'cursor-2' },
      ),
    );
    const user = dashboard({ settlements: { history } });

    const card = await batchHistory();
    await within(card).findByRole('button', { name: 'Details for batch settle-new' });
    await user.click(within(card).getByRole('button', { name: 'Older' }));

    await within(card).findByRole('button', { name: 'Details for batch settle-old' });
    expect(history).toHaveBeenLastCalledWith(POOL_ID, expect.objectContaining({ before: 'cursor-2', limit: 25 }), expect.anything());
    expect(within(card).getByRole('button', { name: 'Older' })).toBeDisabled();

    await user.click(within(card).getByRole('button', { name: 'Newer' }));
    await within(card).findByRole('button', { name: 'Details for batch settle-new' });
  });

  it('asks the venue for the queue and status it filters on, from the newest page', async () => {
    const history = vi.fn((_poolId: string, _query?: SettlementHistoryQuery) => page());
    const user = dashboard({ settlements: { history } });

    await batchHistory();
    await pick(user, 'Batch status', 'Rejected');
    await pick(user, 'Batch queue', 'Withdraw liquidity');

    await waitFor(() =>
      expect(history).toHaveBeenLastCalledWith(
        POOL_ID,
        { type: 'withdraw', status: 'REJECTED', before: undefined, limit: 25 },
        expect.anything(),
      ),
    );
    expect(await screen.findByText('No batch matches')).toBeInTheDocument();
  });

  it('keeps the identifiers and the fills in a detail the reader opens, and returns focus', async () => {
    const user = dashboard({ settlements: { history: () => page(settlement()) } });

    const history = await batchHistory();
    // The row says what happened; the contract identifiers wait for the reader.
    expect(await within(history).findByText('Confirmed')).toBeInTheDocument();
    expect(within(history).getByText('1 swap')).toBeInTheDocument();
    expect(within(history).queryByText('settle-0001')).not.toBeInTheDocument();

    const details = within(history).getByRole('button', { name: 'Details for batch settle-0001' });
    await user.click(details);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Batch').nextElementSibling).toHaveTextContent('settle-0001');
    expect(within(dialog).getByText(/2,941.17647 USDC/)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(details).toHaveFocus();
  });

  it('says an unconfirmed batch filled nothing, rather than showing it as empty', async () => {
    const user = dashboard({
      settlements: {
        history: () => page(settlement({ status: 'UNRESOLVED', fills: [], updateId: null })),
      },
    });

    expect(await within(await batchHistory()).findByText('Confirming')).toBeInTheDocument();
    const dialog = await openBatch(user);

    expect(within(dialog).getByText('No fill')).toBeInTheDocument();
    expect(within(dialog).getByText('Not confirmed')).toBeInTheDocument();
  });

  it('shows the reserve change a confirmed batch made, signed both ways', async () => {
    const user = dashboard({ settlements: { history: () => page(settlement()) } });

    const dialog = await openBatch(user);

    expect(within(dialog).getByText('+0.05')).toBeInTheDocument();
    expect(within(dialog).getByText('-2,941.17647')).toBeInTheDocument();
    // The invariant is a product of reserves, shown to every digit reported.
    expect(within(dialog).getByText('1,500,000.00 → 1,500,147.0588265 · rose')).toBeInTheDocument();
  });
});

describe('an operator watching an idle pool', () => {
  it('discovers work nobody on this screen created', async () => {
    let queue: SettlementRequest[] = [];
    let batches: Settlement[] = [];
    let counts = monitoring({ readyCount: 0, pendingCount: 0 });

    dashboard({
      settlements: {
        requests: () => Promise.resolve(queue),
        history: () => page(...batches),
        monitoring: () => Promise.resolve(counts),
      },
    });

    expect(await screen.findByText('Nothing queued')).toBeInTheDocument();

    // A trader signs a request, and the venue's own worker settles it. Neither
    // happens on this screen, and neither should need a reload to appear.
    queue = [queued(swap({ status: 'READY' }))];
    counts = monitoring({ readyCount: 1, pendingCount: 0 });

    expect(
      await screen.findByText('Queued for settlement', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Swaps/ })).toHaveTextContent('1 ready'));

    queue = [];
    batches = [settlement()];
    counts = monitoring({ readyCount: 0, pendingCount: 0 });

    expect(await within(await batchHistory()).findByText('Confirmed', {}, { timeout: 10_000 })).toBeInTheDocument();
  });
});

describe('what the counts mean', () => {
  it('never shows a queue of requests as nothing outstanding', async () => {
    dashboard({
      settlements: {
        requests: () =>
          Promise.resolve([queued(swap()), queued(swap({ swapId: 'swap-0002' }))]),
        // The venue counts only the requests whose own command is in flight,
        // which is none of these.
        monitoring: () => Promise.resolve(monitoring({ readyCount: 2, pendingCount: 0 })),
      },
    });

    const swaps = await screen.findByRole('button', { name: /^Swaps/ });
    await waitFor(() => expect(swaps).toHaveTextContent('2 ready'));
    expect(swaps).toHaveTextContent('In flight 0');
    expect(await screen.findByText('2 queued')).toBeInTheDocument();
  });
});

describe('a batch that has not been confirmed', () => {
  it('shows its fills as a projection rather than as money paid', async () => {
    const user = dashboard({
      settlements: {
        history: () => page(settlement({ status: 'SUBMITTING', after: null })),
      },
    });

    const dialog = await openBatch(user);

    expect(within(dialog).getByText('Projected, not paid')).toBeInTheDocument();
    // A reserve change is a confirmed fact, so an unconfirmed batch claims none.
    expect(within(dialog).queryByText(/change/)).not.toBeInTheDocument();
  });

  it('shows a confirmed batch as paid', async () => {
    const user = dashboard({ settlements: { history: () => page(settlement()) } });

    const dialog = await openBatch(user);

    expect(within(dialog).getByText('Paid out')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Nothing has been paid/)).not.toBeInTheDocument();
  });
});

describe('the mode an operator reads', () => {
  const AUTOMATIC_SWAPS = { ...POLICIES.swap, automaticEnabled: true };

  it('describes the saved settings, not the switch being edited', async () => {
    const user = dashboard({
      settlements: {
        policy: (_poolId, type) => Promise.resolve(type === 'swap' ? AUTOMATIC_SWAPS : POLICIES[type]),
        monitoring: () => Promise.resolve(withPolicy(AUTOMATIC_SWAPS)),
      },
    });

    const swaps = await screen.findByRole('button', { name: /^Swaps/ });
    await waitFor(() => expect(swaps).toHaveTextContent('Automatic'));
    await openSettings(user);
    await user.click(await screen.findByLabelText(AUTOMATIC));

    // Unticking a box changes nothing at the venue until it is saved.
    expect(screen.getByLabelText(AUTOMATIC)).not.toBeChecked();
    expect(await settingsButton('Automatic · 5 per batch')).toBeInTheDocument();
    expect(swaps).toHaveTextContent('Automatic');
  });

  it('keeps describing the saved settings after a save is refused', async () => {
    const user = dashboard({
      settlements: {
        policy: () => Promise.resolve(AUTOMATIC_SWAPS),
        monitoring: () => Promise.resolve(withPolicy(AUTOMATIC_SWAPS)),
        updatePolicy: () =>
          Promise.reject(new DomainError('Settings changed elsewhere', 'CONFLICT')),
      },
    });

    await openSettings(user);
    await user.click(await screen.findByLabelText(AUTOMATIC));
    await user.click(screen.getByRole('button', { name: SAVE }));

    expect(await screen.findByText(CHANGED_ELSEWHERE)).toBeInTheDocument();
    expect(await settingsButton('Automatic · 5 per batch')).toBeInTheDocument();
  });

  it('keeps the settings closed in the queue’s own panel, with the mode in view', async () => {
    dashboard();

    const queue = await queueCard('Swap queue');
    const trigger = within(queue).getByRole('button', { name: /^Settings/ });
    await waitFor(() => expect(trigger).toHaveAccessibleName('Settings: Manual · 5 per batch'));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText(BATCH_SIZE_EXACT)).not.toBeInTheDocument();
  });

  it('says what each queue’s batch size means, and claims no wait for liquidity', async () => {
    const user = dashboard();
    const note = () => screen.getByText(/^1 to 10\./);

    await openSettings(user);
    await waitFor(() => expect(note()).toHaveTextContent('1 to 10. Automatic batches wait for a full batch.'));
    await user.keyboard('{Escape}');

    await showFamily(user, /^Add liquidity/);
    await openSettings(user);
    await waitFor(() => expect(note()).toHaveTextContent('1 to 10. Initial deposits settle one at a time.'));
    await user.keyboard('{Escape}');

    await showFamily(user, /^Withdraw liquidity/);
    await openSettings(user);
    await waitFor(() => expect(note()).toHaveTextContent(/^1 to 10\.$/));
  });
});

describe('what the pool state says', () => {
  it('names the blocked head instead of quietly leaving it out', async () => {
    const blocked = swap({ status: 'BLOCKED' });
    dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(blocked)]),
        monitoring: () =>
          Promise.resolve(
            monitoring({
              blockedRequest: { type: 'swap', requestId: blocked.swapId },
              blockedReason: 'Output is below the signed minimum at the current reserves.',
              readyCount: 0,
            }),
          ),
      },
    });

    expect(await screen.findByText('The head of this queue cannot settle')).toBeInTheDocument();
    expect(
      screen.getByText(/Output is below the signed minimum at the current reserves\./),
    ).toBeInTheDocument();
  });

  it('reports a setting that stops dispatch, which names no request at all', async () => {
    dashboard({
      settlements: {
        monitoring: () =>
          Promise.resolve(
            monitoring({
              blockedRequest: null,
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

  it('reads an empty pool as awaiting its first deposit, with no price to divide', async () => {
    dashboard({
      settlements: {
        monitoring: () =>
          Promise.resolve(
            monitoring({
              pool: {
                ...monitoring().pool,
                reserves: {
                  stateId: '00state0001',
                  baseReserve: '0',
                  quoteReserve: '0',
                  spotPrice: null,
                  invariant: '0',
                },
                lpTokenSupply: '0',
                health: 'EMPTY',
              },
            }),
          ),
      },
    });

    // The card is found once the observation is on it, not while it waits for one.
    const state = cardOf(await screen.findByText('None until the first deposit'));
    expect(within(state).getByRole('heading', { name: 'Pool state' })).toBeInTheDocument();
    expect(within(state).getByText('Awaiting initial liquidity')).toBeInTheDocument();
    expect(within(state).getByText('60,000.00 USDC per BTC')).toBeInTheDocument();
    expect(state.textContent).not.toMatch(/NaN|Infinity/);
  });
});

describe('what a payout is denominated in', () => {
  it('names the instrument the venue recorded for each fill', async () => {
    const user = dashboard({
      settlements: {
        history: () =>
          page(
            settlement({
              requests: [
                { type: 'swap', requestId: 'swap-0001' },
                { type: 'swap', requestId: 'swap-0002' },
              ],
              fills: [
                { type: 'swap', requestId: 'swap-0001', amountOut: '2941.176470', outputInstrument: USDC },
                { type: 'swap', requestId: 'swap-0002', amountOut: '0.048', outputInstrument: BTC },
              ],
            }),
          ),
      },
    });

    const dialog = await openBatch(user);

    // Either side of the pair can be the output, so the fill's own instrument
    // is what says which.
    expect(within(dialog).getByText(/2,941.17647 USDC/)).toBeInTheDocument();
    expect(within(dialog).getByText(/0.048 BTC/)).toBeInTheDocument();
  });

  it('keeps naming an unconfirmed batch’s amounts a projection', async () => {
    const user = dashboard({
      settlements: {
        history: () =>
          page(
            settlement({
              status: 'SUBMITTING',
              after: null,
              fills: [
                { type: 'swap', requestId: 'swap-0001', amountOut: '2941.176470', outputInstrument: USDC },
              ],
            }),
          ),
      },
    });

    const dialog = await openBatch(user);

    expect(within(dialog).getByText('Projected, not paid')).toBeInTheDocument();
    expect(within(dialog).getByText(/2,941.17647 USDC/)).toBeInTheDocument();
  });
});

describe('one queue per request family', () => {
  it('shows each family’s queue in its own arrival order, with its own bounds', async () => {
    const user = dashboard({
      settlements: {
        requests: () =>
          Promise.resolve([
            queuedDeposit(deposit({ requestId: 'deposit-0002', arrivalSequence: 9 })),
            queued(swap({ outputInstrument: BTC, minOut: '0.00000003' })),
            queuedDeposit(deposit({ arrivalSequence: 4 })),
            queuedWithdrawal(withdrawal()),
          ]),
      },
    });

    // A minimum is shown to its last digit, never rounded to zero.
    const swaps = await queueCard('Swap queue');
    await waitFor(() => expect(rowTexts(swaps)).toHaveLength(1));
    expect(rowTexts(swaps)[0]).toContain('0.00000003 BTC');

    await showFamily(user, /^Add liquidity/);
    const [first, second] = rowTexts(await queueCard('Add liquidity queue'));
    expect(first).toMatch(/^4/);
    expect(second).toMatch(/^9/);
    // A deposit offers two maximums and is guaranteed an LP floor.
    expect(first).toContain('0.05 BTC + 3,000.00 USDC');
    expect(first).toContain('12.1862114311 LP');

    await showFamily(user, /^Withdraw liquidity/);
    // A withdrawal offers LP and is guaranteed a floor on each side.
    const [withdrawRow] = rowTexts(await queueCard('Withdraw liquidity queue'));
    expect(withdrawRow).toContain('100.00 LP');
    expect(withdrawRow).toContain('0.406207049 BTC + 24,372.4229406926 USDC');
  });

  it('holds only the blocked family, and names why', async () => {
    const blocked = deposit({ status: 'BLOCKED', error: 'Ratio outside signed bounds' });
    const user = dashboard({
      settlements: {
        requests: () => Promise.resolve([queued(swap()), queuedDeposit(blocked)]),
        monitoring: () =>
          Promise.resolve(
            monitoring({
              blockedRequest: { type: 'deposit', requestId: blocked.requestId },
              blockedReason: 'The deposit ratio is outside its signed bounds.',
            }),
          ),
      },
    });

    const swaps = await queueCard('Swap queue');
    expect(await within(swaps).findByText('Queued for settlement')).toBeInTheDocument();
    expect(within(swaps).queryByText('The head of this queue cannot settle')).not.toBeInTheDocument();

    await showFamily(user, /^Add liquidity/);
    const deposits = await queueCard('Add liquidity queue');
    expect(within(deposits).getByText('The head of this queue cannot settle')).toBeInTheDocument();
    expect(within(deposits).getByText('Blocked in the queue')).toBeInTheDocument();
    expect(within(deposits).getByText('Ratio outside signed bounds')).toBeInTheDocument();
  });

  it('counts each family from its own requests, and opens one workspace at a time', async () => {
    const user = dashboard({
      settlements: {
        requests: () =>
          Promise.resolve([
            queued(swap()),
            queued(swap({ swapId: 'swap-0002', status: 'SUBMITTING', arrivalSequence: 2 })),
            queuedDeposit(deposit({ status: 'BLOCKED' })),
          ]),
      },
    });

    const swaps = await screen.findByRole('button', { name: /^Swaps/ });
    await waitFor(() => expect(swaps).toHaveTextContent('1 ready'));
    expect(swaps).toHaveTextContent('In flight 1');
    expect(swaps).toHaveAttribute('aria-pressed', 'true');
    const deposits = screen.getByRole('button', { name: /^Add liquidity/ });
    expect(deposits).toHaveTextContent('Attention 1');

    await user.click(deposits);
    expect(deposits).toHaveAttribute('aria-pressed', 'true');
    expect(swaps).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('heading', { name: 'Swap queue' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add liquidity queue' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add liquidity · next batch' })).toBeInTheDocument();
  });

  it('narrows by attention and by identifier, keeping the queue in order', async () => {
    const user = dashboard({
      settlements: {
        requests: () =>
          Promise.resolve([
            queued(swap({ swapId: 'swap-0003', arrivalSequence: 3, trader: 'other::1220bb' })),
            queued(swap()),
            queued(swap({ swapId: 'swap-0002', arrivalSequence: 2, status: 'BLOCKED' })),
          ]),
      },
    });

    const swaps = await queueCard('Swap queue');
    await waitFor(() => expect(rowTexts(swaps).map((text) => text[0])).toEqual(['1', '2', '3']));

    await user.click(screen.getByRole('button', { name: 'Needs attention' }));
    expect(rowTexts(swaps)).toHaveLength(1);
    expect(within(swaps).getByText('1 of 3 shown')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.type(screen.getByLabelText('Search requests'), 'other::');
    expect(rowTexts(swaps)).toHaveLength(1);
    expect(rowTexts(swaps)[0]).toMatch(/^3/);

    await user.clear(screen.getByLabelText('Search requests'));
    await user.type(screen.getByLabelText('Search requests'), 'nothing-like-this');
    expect(within(swaps).getByText('No request matches')).toBeInTheDocument();
  });

  it('shows empty queues, and a failed first read with a way back', async () => {
    let fail = true;
    dashboard({
      settlements: {
        requests: () =>
          fail ? Promise.reject(new Error('The venue could not be reached.')) : Promise.resolve([]),
      },
    });

    const queue = await queueCard('Swap queue');
    expect(await within(queue).findByText('The venue could not be reached.')).toBeInTheDocument();
    fail = false;
    await userEvent.click(within(queue).getByRole('button', { name: 'Try again' }));
    expect(await within(queue).findByText('Nothing queued')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Withdraw liquidity/ })).toHaveTextContent('Empty');
  });

  it('shows what each deposit in a confirmed batch minted, took and refunded', async () => {
    const user = dashboard({
      settlements: {
        history: () =>
          page(
            settlement({
              requests: [
                { type: 'deposit', requestId: 'deposit-0001' },
                { type: 'deposit', requestId: 'deposit-0002' },
              ],
              fills: [
                {
                  type: 'deposit',
                  requestId: 'deposit-0001',
                  actualBaseIn: '0.05',
                  actualQuoteIn: '2990',
                  actualBaseRefund: '0',
                  actualQuoteRefund: '10',
                  actualLpOut: '12.2270',
                },
                {
                  type: 'deposit',
                  requestId: 'deposit-0002',
                  actualBaseIn: '0.02',
                  actualQuoteIn: '1200',
                  actualBaseRefund: '0.01',
                  actualQuoteRefund: '0',
                  actualLpOut: '4.8989',
                },
              ],
            }),
          ),
      },
    });

    expect(await within(await batchHistory()).findByText('2 deposits')).toBeInTheDocument();
    const dialog = await openBatch(user);

    const first = within(dialog).getByText(/12.227 LP for/).closest('td')!;
    expect(first.textContent).toContain('for 0.05 BTC + 2,990.00 USDC');
    expect(first.textContent).toContain('refunded 0.00 BTC + 10.00 USDC');
    const second = within(dialog).getByText(/4.8989 LP for/).closest('td')!;
    expect(second.textContent).toContain('for 0.02 BTC + 1,200.00 USDC');
    expect(second.textContent).toContain('refunded 0.01 BTC + 0.00 USDC');
    expect(within(dialog).getAllByText('Deposit')).toHaveLength(2);
  });

  it('shows what each withdrawal in a confirmed batch burned and paid out', async () => {
    const user = dashboard({ settlements: { history: () => page(WITHDRAWAL_BATCH) } });

    expect(await within(await batchHistory()).findByText('2 withdrawals')).toBeInTheDocument();
    const dialog = await openBatch(user);

    const [first, second] = rowTexts(dialog);
    expect(first).toContain(FIRST_WITHDRAWAL.requestId);
    expect(first).toContain(`${FIRST_OUTCOME.paid} for ${FIRST_OUTCOME.burned}`);
    expect(second).toContain(SECOND_WITHDRAWAL.requestId);
    expect(second).toContain(`${SECOND_OUTCOME.paid} for ${SECOND_OUTCOME.burned}`);
    expect(within(dialog).getAllByText('Withdrawal')).toHaveLength(2);
  });
});

describe('a queued request in full', () => {
  /** The `CopyField` a label names inside the open dialog. */
  function copied(dialog: HTMLElement, label: string): string | null | undefined {
    const field = within(dialog)
      .getAllByText(label)
      .map((node) => node.closest('[data-slot="copy-field"]'))
      .find((node) => node !== null);
    return field?.querySelector('pre')?.textContent;
  }

  /** The value a `DataList` label carries inside the open dialog. */
  function valueOf(dialog: HTMLElement, label: string): string | null {
    return within(dialog).getByText(label).nextElementSibling!.textContent;
  }

  async function openEvidence(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
    await user.click(
      within(dialog).getByRole('button', { name: 'Identifiers, instruments and ledger evidence' }),
    );
  }

  it('leads a deposit with its bounds and result, and keeps full identities one step away', async () => {
    const user = dashboard({
      settlements: { requests: () => Promise.resolve([queuedDeposit(deposit())]) },
    });

    await showFamily(user, /^Add liquidity/);
    const dialog = await openRequest(user, 'deposit-0001');

    expect(within(dialog).getByRole('heading', { name: 'Deposit deposit-0001' })).toBeInTheDocument();
    // An arrival counter, not a rank in the queue.
    expect(within(dialog).getByText('Arrival #2')).toBeInTheDocument();
    expect(valueOf(dialog, 'Mode')).toBe('Initial, at the configured ratio');
    expect(valueOf(dialog, 'Maximum in')).toBe('0.05 BTC + 3,000.00 USDC');
    expect(valueOf(dialog, 'Minimum LP')).toBe('12.1862114311 LP');
    expect(valueOf(dialog, 'Locked minimum LP')).toBe('0.0000001 LP');
    expect(valueOf(dialog, 'Expected refund')).toBe('0.00 BTC + 0.00 USDC');
    expect(within(dialog).getByText('Not settled yet.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Request ID')).not.toBeInTheDocument();

    await openEvidence(user, dialog);
    expect(copied(dialog, 'Request ID')).toBe('deposit-0001');
    expect(copied(dialog, 'Trader')).toBe(TRADER_PARTY);
    expect(copied(dialog, 'Allocation 3')).toBe('00alloc0013');
    // The LP amounts say "LP"; its full identity and administrator are here.
    expect(within(dialog).getByText('LP-BTC-USDC')).toBeInTheDocument();
    expect(within(dialog).getAllByText('dvo::1220dvo').length).toBeGreaterThan(0);
  });

  it('marks a deferred request as held, apart from its status', async () => {
    const user = dashboard({
      settlements: { requests: () => Promise.resolve([queued(swap({ status: 'BLOCKED' }), true)]) },
    });

    const dialog = await openRequest(user, 'swap-0001');

    expect(within(dialog).getByText('Blocked in the queue')).toBeInTheDocument();
    expect(within(dialog).getByText('Deferred')).toBeInTheDocument();
  });

  it('shows a withdrawal’s burn and both payout floors, and a swap’s minimum and actual output', async () => {
    const user = dashboard({
      settlements: {
        requests: () =>
          Promise.resolve([
            queuedWithdrawal(withdrawal()),
            queued(swap({ status: 'SETTLING', amountOut: '2950.123456' })),
          ]),
      },
    });

    await showFamily(user, /^Withdraw liquidity/);
    const withdraw = await openRequest(user, 'withdraw-0001');
    expect(valueOf(withdraw, 'LP to burn')).toBe('100.00 LP');
    expect(valueOf(withdraw, 'Minimum out')).toBe('0.406207049 BTC + 24,372.4229406926 USDC');
    await user.keyboard('{Escape}');

    await showFamily(user, /^Swaps/);
    const swapDetail = await openRequest(user, 'swap-0001');
    expect(valueOf(swapDetail, 'Minimum out')).toBe('2,926.470588 USDC');
    expect(valueOf(swapDetail, 'Paid out')).toBe('2,950.123456 USDC');
  });

  it('treats a newer confirmed batch as the outcome, over a stale row and an older attempt', async () => {
    // The last queue read is BLOCKED, with an error, naming an attempt that was rejected.
    const earlier = settlement({
      settlementId: 'settle-old',
      status: 'REJECTED',
      requests: [{ type: 'deposit', requestId: 'deposit-0001' }],
      fills: [],
      after: null,
    });
    let queueFails = false;
    let batches: Settlement[] = [earlier];
    const user = dashboard({
      settlements: {
        requests: () =>
          queueFails
            ? Promise.reject(new Error('The venue could not be reached.'))
            : Promise.resolve([
                queuedDeposit(
                  deposit({
                    status: 'BLOCKED',
                    settlementId: 'settle-old',
                    error: 'Ratio outside signed bounds',
                  }),
                ),
              ]),
        list: () => Promise.resolve(batches),
      },
    });

    await showFamily(user, /^Add liquidity/);
    const dialog = await openRequest(user, 'deposit-0001');
    expect(within(dialog).getByText('Ratio outside signed bounds')).toBeInTheDocument();

    // The queue stops answering, so the row stays BLOCKED, while a newer batch confirms it.
    queueFails = true;
    batches = [
      settlement({
        requests: [
          { type: 'deposit', requestId: 'deposit-0000' },
          { type: 'deposit', requestId: 'deposit-0001' },
        ],
        fills: [
          // Same id, other family: never this request's fill.
          { type: 'swap', requestId: 'deposit-0001', amountOut: '1', outputInstrument: USDC },
          // Same family and batch, another deposit: never this request's fill either.
          {
            type: 'deposit',
            requestId: 'deposit-0000',
            actualBaseIn: '0.02',
            actualQuoteIn: '1200',
            actualBaseRefund: '0.01',
            actualQuoteRefund: '0',
            actualLpOut: '4.8989',
          },
          {
            type: 'deposit',
            requestId: 'deposit-0001',
            actualBaseIn: '0.05',
            actualQuoteIn: '2990',
            actualBaseRefund: '0',
            actualQuoteRefund: '10',
            actualLpOut: '12.2270',
          },
        ],
      }),
      earlier,
    ];

    expect(await within(dialog).findByText('Settled', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(valueOf(dialog, 'LP minted')).toBe('12.227 LP');
    expect(within(dialog).queryByText('Blocked in the queue')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Ratio outside signed bounds')).not.toBeInTheDocument();
    expect(valueOf(dialog, 'Refunded')).toBe('0.00 BTC + 10.00 USDC');
    expect(within(dialog).queryByText('Not settled yet.')).not.toBeInTheDocument();

    await openEvidence(user, dialog);
    expect(copied(dialog, 'Settlement')).toBe('settle-0001');
    expect(copied(dialog, 'Batch ledger update')).toBe('1220update21');
  });

  it('matches each withdrawal to its own burn and payout in the batch they share', async () => {
    const user = dashboard({
      settlements: {
        requests: () =>
          Promise.resolve([queuedWithdrawal(FIRST_WITHDRAWAL), queuedWithdrawal(SECOND_WITHDRAWAL)]),
        list: () => Promise.resolve([WITHDRAWAL_BATCH]),
      },
    });

    async function readOutcome(requestId: string) {
      const dialog = await openRequest(user, requestId);
      await within(dialog).findByText('Settled');
      const read = { burned: valueOf(dialog, 'LP burned'), paid: valueOf(dialog, 'Paid out') };
      await user.keyboard('{Escape}');
      return read;
    }

    await showFamily(user, /^Withdraw liquidity/);
    // The later request goes first: the first withdrawal fill in the batch is not its own.
    expect(await readOutcome(SECOND_WITHDRAWAL.requestId)).toEqual(SECOND_OUTCOME);
    expect(await readOutcome(FIRST_WITHDRAWAL.requestId)).toEqual(FIRST_OUTCOME);
  });

  it('says an outcome was not observed when a request vanishes without a batch', async () => {
    let queue: SettlementRequest[] = [queuedWithdrawal(withdrawal())];
    const user = dashboard({ settlements: { requests: () => Promise.resolve(queue) } });

    await showFamily(user, /^Withdraw liquidity/);
    const dialog = await openRequest(user, 'withdraw-0001');
    queue = [];

    expect(
      await within(dialog).findByText(/Outcome not observed\. Last known status: Queued for settlement/, {}, {
        timeout: 10_000,
      }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('Not settled yet.')).not.toBeInTheDocument();
  });

  it('returns keyboard focus to the Details button that opened it', async () => {
    const user = dashboard({ settlements: { requests: () => Promise.resolve([queued(swap())]) } });

    const details = await screen.findByRole('button', { name: 'Details for request swap-0001' });
    details.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(details).toHaveFocus();
  });

  it('returns focus to the search field when the request left the queue', async () => {
    let queue: SettlementRequest[] = [queued(swap())];
    const user = dashboard({ settlements: { requests: () => Promise.resolve(queue) } });

    const dialog = await openRequest(user, 'swap-0001');
    queue = [];
    await within(dialog).findByText('No longer in the active queue', {}, { timeout: 10_000 });

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.getByLabelText('Search requests')).toHaveFocus());
  });

  it('drops the open request, the filters and the preview when the operator changes pool', async () => {
    const user = dashboard(
      {
        settlements: {
          requests: (poolId) =>
            Promise.resolve(
              poolId === POOL_ID ? [queued(swap())] : [queued(swap({ swapId: 'swap-eth-0001' }))],
            ),
        },
      },
      [POOL, OTHER],
    );

    await user.type(await screen.findByLabelText('Search requests'), 'swap-0001');
    await pick(user, 'Pool', OTHER.name);

    expect(await screen.findByLabelText('Search requests')).toHaveValue('');
    expect(await screen.findByRole('button', { name: 'Details for request swap-eth-0001' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Details for request swap-0001' })).not.toBeInTheDocument();
  });
});
