import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { DexProvider, type Session } from '../app/runtime';
import { poolNoticesBetween } from '../features/pools/poolNotices';
import type { DexClient } from '../lib/api/port';
import type {
  PoolCreationOptions,
  PoolDetail,
  PoolProposalRecord,
  PoolProposalStatus,
  PoolTerms,
  Profile,
} from '../lib/api/types';
import { DomainError } from '../lib/api/types';
import { testClient } from './clients';
import '../styles/global.css';

const OPERATOR: Profile = {
  accountId: 'acc-operator',
  displayName: 'Venue Operations',
  role: 'OPERATOR',
  partyId: null,
};

const TERMS: PoolTerms = {
  dvo: 'dvo::1220dvo',
  baseInstrumentId: { admin: 'issuer-usdc::1220usdc', id: 'USDC' },
  quoteInstrumentId: { admin: 'issuer-eurc::1220eurc', id: 'EURC' },
  baseAccount: { owner: 'dvo::1220dvo', provider: null, id: 'usdc-eurc-base' },
  quoteAccount: { owner: 'dvo::1220dvo', provider: null, id: 'usdc-eurc-quote' },
  lpTokenInstrumentId: { admin: 'dvo::1220dvo', id: 'LP-USDC-EURC' },
  feeBps: '30.0000000000',
  baseReserve: '1000000.0000000000',
  quoteReserve: '920000.0000000000',
  lpTokenSupply: '959166.3050000000',
};

const OPTIONS: PoolCreationOptions = {
  factoryId: '00factory0001',
  dvo: 'dvo::1220dvo',
  venueOperator: 'venue-operator::1220beef',
  instrumentAdmins: [
    { partyId: 'issuer-usdc::1220usdc', label: 'USDC issuer' },
    { partyId: 'issuer-eurc::1220eurc', label: 'EURC issuer' },
  ],
};

function proposal(overrides: Partial<PoolProposalRecord> = {}): PoolProposalRecord {
  return {
    proposalId: 'prop-0001',
    name: 'USDC / EURC',
    settings: TERMS,
    status: 'PENDING',
    createdAt: '2026-09-18T10:00:00Z',
    updatedAt: '2026-09-18T10:00:05Z',
    proposedBy: 'venue-operator::1220beef',
    proposalCid: '00proposal0001',
    factoryId: '00factory0001',
    poolId: null,
    updateId: null,
    error: null,
    ...overrides,
  };
}

const POOL: PoolDetail = {
  poolId: '00pool0001',
  name: 'USDC / EURC',
  settings: TERMS,
  configId: '00config0001',
  stateId: '00state0001',
  packageId: '1220package01',
  createdAt: '2026-09-18T10:04:00Z',
  updatedAt: '2026-09-18T10:04:00Z',
};

function renderPools(parts: Parameters<typeof testClient>[0] = {}) {
  const client: DexClient = testClient({
    me: () => Promise.resolve(OPERATOR),
    ...parts,
    onboarding: { mine: () => Promise.resolve(null), ...parts.onboarding },
    pools: { list: () => Promise.resolve([]), ...parts.pools },
    admin: {
      listOnboardings: () => Promise.resolve([]),
      listPoolProposals: () => Promise.resolve([]),
      listPools: () => Promise.resolve([]),
      poolCreationOptions: () => Promise.resolve(OPTIONS),
      ...parts.admin,
    },
  });
  const session: Session = { mode: 'keycloak', current: OPERATOR, loading: false };
  render(
    <DexProvider client={client} session={session}>
      <App />
    </DexProvider>,
  );
  return userEvent.setup();
}

async function openPools(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Pools' }));
  return screen.findByRole('heading', { name: 'Pools', level: 1 });
}

/** One proposal's own row, so a status never matches a filter chip or a count. */
async function row(name = 'USDC / EURC'): Promise<HTMLElement> {
  const found = await screen.findAllByText(name);
  const inRow = found.find((element) => element.closest('.proposal-row'));
  return inRow!.closest<HTMLElement>('.proposal-row')!;
}

describe('the venue pools console', () => {
  it('is where a real operator lands from the sidebar', async () => {
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () => Promise.resolve([proposal()]),
        listPools: () => Promise.resolve([POOL]),
      },
    });

    await openPools(user);

    expect(await screen.findByText('In progress')).toBeInTheDocument();
    expect(await screen.findByText('Awaiting dvo')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'USDC / EURC' })).toBeInTheDocument();
    // No control here acts for the dvo: a script accepts the proposal.
    expect(screen.queryByRole('button', { name: /Accept|Approve/ })).not.toBeInTheDocument();
  });

  it.each([
    ['SUBMITTING' as const, 'Submitting'],
    ['PENDING' as const, 'Awaiting dvo'],
    ['CREATED' as const, 'Created'],
    ['REJECTED' as const, 'Rejected by dvo'],
    ['WITHDRAWN' as const, 'Withdrawn'],
    ['UNRESOLVED' as const, 'Confirming'],
    ['FAILED' as const, 'Failed'],
  ])('shows a %s proposal as %s', async (status: PoolProposalStatus, label) => {
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () => Promise.resolve([proposal({ status })]),
        listPools: () => Promise.resolve([]),
      },
    });

    await openPools(user);
    await user.click(await screen.findByRole('button', { name: 'All' }));

    expect(within(await row()).getByText(label)).toBeInTheDocument();
  });

  it('shows the venue’s error on a failed proposal, and keeps the record', async () => {
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () =>
          Promise.resolve([
            proposal({ status: 'FAILED', error: 'DUPLICATE_KEY: pool already exists' }),
          ]),
        listPools: () => Promise.resolve([]),
      },
    });

    await openPools(user);
    await user.click(await screen.findByRole('button', { name: 'All' }));

    const failed = await row();
    expect(within(failed).getByText('Failed')).toBeInTheDocument();
    expect(within(failed).getByText('DUPLICATE_KEY: pool already exists')).toBeInTheDocument();
  });

  it('shows an error a pending proposal carries, without calling it an outcome', async () => {
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () =>
          Promise.resolve([proposal({ error: 'Withdrawal refused: already accepted' })]),
        listPools: () => Promise.resolve([]),
      },
    });

    await openPools(user);

    const pending = await row();
    expect(within(pending).getByText('Awaiting dvo')).toBeInTheDocument();
    expect(within(pending).getByText('Withdrawal refused: already accepted')).toBeInTheDocument();
  });

  it('withdraws a pending proposal, and nothing else', async () => {
    const withdrawPoolProposal = vi.fn(() =>
      Promise.resolve(proposal({ status: 'WITHDRAWN' })),
    );
    let current = [proposal(), proposal({ proposalId: 'prop-0002', status: 'CREATED' })];
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () => Promise.resolve(current),
        listPools: () => Promise.resolve([]),
        withdrawPoolProposal,
      },
    });

    await openPools(user);
    await user.click(await screen.findByRole('button', { name: 'All' }));

    const buttons = screen.getAllByRole('button', { name: 'Withdraw' });
    expect(buttons).toHaveLength(1);

    current = [proposal({ status: 'WITHDRAWN' })];
    await user.click(buttons[0]!);

    expect(withdrawPoolProposal).toHaveBeenCalledWith('prop-0001');
  });

  it('reports a refused withdrawal without losing the proposal', async () => {
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () => Promise.resolve([proposal()]),
        listPools: () => Promise.resolve([]),
        withdrawPoolProposal: () =>
          Promise.reject(new DomainError('The dvo already accepted it', 'CONFLICT')),
      },
    });

    await openPools(user);
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));

    expect(await screen.findByText('The dvo already accepted it')).toBeInTheDocument();
    expect(screen.getByText('Awaiting dvo')).toBeInTheDocument();
  });

  it('keeps the list a failed refresh already read', async () => {
    let call = 0;
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () => {
          call += 1;
          return call === 1
            ? Promise.resolve([proposal()])
            : Promise.reject(new Error('The venue is unreachable'));
        },
        listPools: () => Promise.resolve([]),
      },
    });

    await openPools(user);
    await screen.findByText('The venue is unreachable', {}, { timeout: 10_000 });

    // The proposal it already read is still there, and no count claims zero.
    expect(within(await row()).getByText('Awaiting dvo')).toBeInTheDocument();
    expect(screen.getByText('In progress').closest('.stat')!.textContent).toContain('1');
  });

  it('filters and searches what is already loaded', async () => {
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () =>
          Promise.resolve([
            proposal(),
            proposal({
              proposalId: 'prop-0002',
              name: 'TBILL / USDC',
              status: 'CREATED',
              settings: {
                ...TERMS,
                baseInstrumentId: { admin: 'issuer-tbill::1220t', id: 'TBILL' },
                quoteInstrumentId: { admin: 'issuer-usdc::1220usdc', id: 'USDC' },
              },
            }),
          ]),
        listPools: () =>
          Promise.resolve([
            POOL,
            {
              ...POOL,
              poolId: '00pool0002',
              name: 'TBILL / USDC',
              settings: {
                ...TERMS,
                baseInstrumentId: { admin: 'issuer-tbill::1220t', id: 'TBILL' },
              },
            },
          ]),
      },
    });

    await openPools(user);
    const proposals = (await screen.findByText('Proposals')).closest<HTMLElement>('section')!;
    const named = (scope: HTMLElement, name: string) => within(scope).queryAllByText(name).length;

    expect(named(proposals, 'USDC / EURC')).toBeGreaterThan(0);
    expect(named(proposals, 'TBILL / USDC')).toBe(0);

    await user.click(within(proposals).getByRole('button', { name: 'Created' }));
    expect(named(proposals, 'TBILL / USDC')).toBeGreaterThan(0);
    expect(named(proposals, 'USDC / EURC')).toBe(0);

    await user.type(screen.getByLabelText('Search pools'), 'tbill');
    const pools = screen.getByText('Live pools').closest<HTMLElement>('section')!;
    expect(within(pools).getByRole('heading', { name: 'TBILL / USDC' })).toBeInTheDocument();
    expect(within(pools).queryByRole('heading', { name: 'USDC / EURC' })).not.toBeInTheDocument();
  });

  it('offers the proposal identifier and its contract, each named for what it is', async () => {
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () => Promise.resolve([proposal()]),
        listPools: () => Promise.resolve([]),
      },
    });

    await openPools(user);
    const details = within(await row()).getByText('Details').closest<HTMLElement>('details')!;

    const identifier = within(details).getByText('Proposal ID').closest('.copy-field')!;
    expect(within(identifier as HTMLElement).getByText('prop-0001')).toBeInTheDocument();
    const contract = within(details).getByText('Proposal contract').closest('.copy-field')!;
    expect(within(contract as HTMLElement).getByText('00proposal0001')).toBeInTheDocument();
  });

  it('keeps a decided proposal out of Open, and counts it all the same', async () => {
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () =>
          Promise.resolve([
            proposal({ proposalId: 'prop-0001', status: 'FAILED', error: 'Refused' }),
            proposal({ proposalId: 'prop-0002', status: 'REJECTED' }),
            proposal({ proposalId: 'prop-0003', status: 'PENDING' }),
          ]),
        listPools: () => Promise.resolve([]),
      },
    });

    await openPools(user);
    const proposals = (await screen.findByText('Proposals')).closest<HTMLElement>('section')!;

    expect(within(proposals).getAllByText(/Awaiting dvo|Failed|Rejected by dvo/)).toHaveLength(1);
    expect(within(proposals).getByText('Awaiting dvo')).toBeInTheDocument();
    // The count still says one needs attention, whichever filter is on.
    const stats = screen.getByText('Needs attention').closest('.stat')!;
    expect(stats.textContent).toContain('1');

    await user.click(within(proposals).getByRole('button', { name: 'All' }));
    expect(within(proposals).getAllByText(/Awaiting dvo|Failed|Rejected by dvo/)).toHaveLength(3);
  });

  it('reports a failed refresh once, with one way back', async () => {
    let call = 0;
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () => {
          call += 1;
          return call === 1
            ? Promise.resolve([proposal()])
            : Promise.reject(new Error('The venue is unreachable'));
        },
        listPools: () => Promise.resolve([]),
      },
    });

    await openPools(user);
    await screen.findByText('Awaiting dvo');

    await screen.findByText('The venue is unreachable', {}, { timeout: 10_000 });
    expect(screen.getAllByText('The venue is unreachable')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
  });

  it('carries the contracts a pool is made of, under its own disclosure', async () => {
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () => Promise.resolve([]),
        listPools: () => Promise.resolve([POOL]),
      },
    });

    await openPools(user);
    const card = (await screen.findByRole('heading', { name: 'USDC / EURC' })).closest('article')!;

    expect(within(card).getByText('30 bps')).toBeInTheDocument();
    const details = within(card).getByText('Contracts').closest('details')!;
    expect(within(details).getByText('00pool0001')).toBeInTheDocument();
    expect(within(details).getByText('00config0001')).toBeInTheDocument();
    expect(within(details).getByText('00state0001')).toBeInTheDocument();
    expect(within(details).getByText('dvo::1220dvo')).toBeInTheDocument();
    // Nothing here invents a price, a volume or a value.
    expect(card.textContent).not.toMatch(/TVL|APR|APY|\$|volume/i);
  });
});

describe('proposing a pool', () => {
  async function fillPair(user: ReturnType<typeof userEvent.setup>) {
    await user.selectOptions(screen.getByLabelText('Base admin'), 'issuer-usdc::1220usdc');
    await user.type(screen.getByLabelText('Base instrument'), 'USDC');
    await user.selectOptions(screen.getByLabelText('Quote admin'), 'issuer-eurc::1220eurc');
    await user.type(screen.getByLabelText('Quote instrument'), 'EURC');
    await user.type(screen.getByLabelText('Base reserve'), '1000000');
    await user.type(screen.getByLabelText('Quote reserve'), '920000');
    await user.type(screen.getByLabelText('LP supply'), '959166.305');
  }

  it('sends what was entered, with the venue assigning the rest', async () => {
    const createPoolProposal = vi.fn(() => Promise.resolve(proposal({ status: 'SUBMITTING' })));
    const user = renderPools({ admin: { createPoolProposal } });

    await openPools(user);
    await user.click(screen.getByRole('button', { name: 'New pool' }));
    await fillPair(user);

    // The identifiers the pair implies are filled in, and stay editable.
    expect(screen.getByLabelText('Pool name')).toHaveValue('USDC / EURC');
    expect(screen.getByLabelText('LP token')).toHaveValue('LP-USDC-EURC');

    await user.click(screen.getByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Submit proposal' }));

    expect(createPoolProposal).toHaveBeenCalledWith({
      name: 'USDC / EURC',
      baseInstrumentId: { admin: 'issuer-usdc::1220usdc', id: 'USDC' },
      quoteInstrumentId: { admin: 'issuer-eurc::1220eurc', id: 'EURC' },
      baseAccountId: 'usdc-eurc-base',
      quoteAccountId: 'usdc-eurc-quote',
      lpTokenId: 'LP-USDC-EURC',
      feeBps: '30',
      baseReserve: '1000000',
      quoteReserve: '920000',
      lpTokenSupply: '959166.305',
    });
  });

  it('refuses to send what the venue would reject', async () => {
    const createPoolProposal = vi.fn(() => Promise.resolve(proposal()));
    const user = renderPools({ admin: { createPoolProposal } });

    await openPools(user);
    await user.click(screen.getByRole('button', { name: 'New pool' }));
    await user.type(screen.getByLabelText('Base reserve'), '0');
    await user.click(screen.getByRole('button', { name: 'Review' }));

    expect(await screen.findByText('Base reserve must be greater than zero')).toBeInTheDocument();
    expect(screen.getByText('Base instrument is required')).toBeInTheDocument();
    expect(createPoolProposal).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Submit proposal' })).not.toBeInTheDocument();
  });

  it('keeps what was entered when the venue reports a duplicate pair', async () => {
    const user = renderPools({
      admin: {
        createPoolProposal: () =>
          Promise.reject(new DomainError('A pool for USDC/EURC already exists', 'CONFLICT')),
      },
    });

    await openPools(user);
    await user.click(screen.getByRole('button', { name: 'New pool' }));
    await fillPair(user);
    await user.click(screen.getByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Submit proposal' }));

    expect(await screen.findByText('A pool for USDC/EURC already exists')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Base reserve')).toHaveValue('1000000');
    expect(screen.getByLabelText('Base instrument')).toHaveValue('USDC');
  });

  it('sends one proposal however often the button is clicked', async () => {
    let release!: () => void;
    const createPoolProposal = vi.fn(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return proposal();
    });
    const user = renderPools({ admin: { createPoolProposal } });

    await openPools(user);
    await user.click(screen.getByRole('button', { name: 'New pool' }));
    await fillPair(user);
    await user.click(screen.getByRole('button', { name: 'Review' }));

    const submit = screen.getByRole('button', { name: 'Submit proposal' });
    await user.click(submit);
    await user.click(submit);
    await user.click(submit);

    expect(createPoolProposal).toHaveBeenCalledTimes(1);
    // Let the one request settle, so the screen is not left mid-update.
    await act(async () => release());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Submit proposal' })).not.toBeInTheDocument(),
    );
  });

  it('reports instrument admins it could not load, and asks for no invented party', async () => {
    const user = renderPools({
      admin: {
        poolCreationOptions: () => Promise.reject(new Error('The venue is unreachable')),
      },
    });

    await openPools(user);
    await user.click(screen.getByRole('button', { name: 'New pool' }));

    expect(await screen.findByText('Could not load the instrument admins')).toBeInTheDocument();
    expect(screen.getByLabelText('Base admin')).toHaveValue('');
  });
});

describe('what the operator is told, and when', () => {
  it('announces a pool the dvo accepted while they watched, once', () => {
    const before = [proposal()];
    const after = [proposal({ status: 'CREATED', poolId: '00pool0001' })];

    const [notice] = poolNoticesBetween(before, after);
    expect(notice?.title).toBe('USDC / EURC created');
    expect(notice?.contract).toEqual({ label: 'Pool contract', value: '00pool0001' });
    // The same reading twice is not a second event.
    expect(poolNoticesBetween(after, after)).toEqual([]);
  });

  it('announces nothing on a first load, however settled the queue is', () => {
    expect(poolNoticesBetween(null, [proposal({ status: 'CREATED' })])).toEqual([]);
    // A proposal seen for the first time is not a transition either.
    expect(poolNoticesBetween([], [proposal({ status: 'FAILED' })])).toEqual([]);
  });

  it('announces a rejection and a failure with the reason the venue gave', () => {
    const rejected = poolNoticesBetween(
      [proposal()],
      [proposal({ status: 'REJECTED', error: 'The dvo declined' })],
    );
    expect(rejected[0]?.detail).toBe('The dvo declined');

    const failed = poolNoticesBetween(
      [proposal()],
      [proposal({ status: 'FAILED', error: 'CONTRACT_NOT_FOUND' })],
    );
    expect(failed[0]?.detail).toBe('CONTRACT_NOT_FOUND');
  });

  it('says nothing about a withdrawal the operator performed themselves', () => {
    expect(poolNoticesBetween([proposal()], [proposal({ status: 'WITHDRAWN' })])).toEqual([]);
  });

  it('refreshes the pools once acceptance lands, and announces it in the screen', async () => {
    const listPools = vi.fn(() => Promise.resolve<PoolDetail[]>([]));
    let queue = [proposal()];
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () => Promise.resolve(queue),
        listPools,
      },
    });

    await openPools(user);
    expect(await screen.findByText('Awaiting dvo')).toBeInTheDocument();
    const reads = listPools.mock.calls.length;

    queue = [proposal({ status: 'CREATED', poolId: '00pool0001' })];
    listPools.mockImplementation(() => Promise.resolve([POOL]));

    expect(
      await screen.findByText('USDC / EURC created', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(listPools.mock.calls.length).toBeGreaterThan(reads));

    // The announcement does not come back on the next poll.
    await act(() => new Promise((resolve) => setTimeout(resolve, 3_200)));
    expect(screen.getAllByText('USDC / EURC created')).toHaveLength(1);
  });
});

describe('keeping the catalogue in step with the queue', () => {
  it('reads the pools again for an acceptance that was already there on arrival', async () => {
    const listPools = vi.fn(() => Promise.resolve<PoolDetail[]>([]));
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        // The pool was accepted before this screen opened, so there is no
        // transition to observe and no notice to derive anything from.
        listPoolProposals: () =>
          Promise.resolve([proposal({ status: 'CREATED', poolId: '00pool0001' })]),
        listPools,
      },
    });

    await openPools(user);
    await waitFor(() => expect(listPools.mock.calls.length).toBeGreaterThan(1));
    expect(screen.queryByText('USDC / EURC created')).not.toBeInTheDocument();
  });

  it('reads them again for a second acceptance, after the first was dismissed', async () => {
    const listPools = vi.fn(() => Promise.resolve<PoolDetail[]>([]));
    let queue = [proposal(), proposal({ proposalId: 'prop-0002', name: 'TBILL / USDC' })];
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () => Promise.resolve(queue),
        listPools,
      },
    });

    await openPools(user);
    await screen.findAllByText('Awaiting dvo');

    queue = [
      proposal({ status: 'CREATED', poolId: '00pool0001' }),
      proposal({ proposalId: 'prop-0002', name: 'TBILL / USDC' }),
    ];
    await screen.findByText('USDC / EURC created', {}, { timeout: 10_000 });
    await user.click(screen.getByRole('button', { name: 'Dismiss: USDC / EURC created' }));
    const afterFirst = listPools.mock.calls.length;

    queue = [
      proposal({ status: 'CREATED', poolId: '00pool0001' }),
      proposal({
        proposalId: 'prop-0002',
        name: 'TBILL / USDC',
        status: 'CREATED',
        poolId: '00pool0002',
      }),
    ];

    await waitFor(() => expect(listPools.mock.calls.length).toBeGreaterThan(afterFirst), {
      timeout: 10_000,
    });
  });
});

describe('polling the queue', () => {
  it('keeps reading an empty queue, and shows what another session proposed', async () => {
    let queue: PoolProposalRecord[] = [];
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: () => Promise.resolve(queue),
        listPools: () => Promise.resolve([]),
      },
    });

    await openPools(user);
    expect(await screen.findByText('No proposals yet')).toBeInTheDocument();

    queue = [proposal()];

    expect(
      await screen.findByText('Awaiting dvo', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
  });

  it('keeps reading a queue where everything has been decided', async () => {
    let queue = [proposal({ status: 'WITHDRAWN' })];
    const listPoolProposals = vi.fn(() => Promise.resolve(queue));
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals,
        listPools: () => Promise.resolve([]),
      },
    });

    await openPools(user);
    // Decided proposals are not in Open, which is the filter this opens on.
    await screen.findByText('Nothing here');
    const reads = listPoolProposals.mock.calls.length;

    queue = [proposal({ status: 'WITHDRAWN' }), proposal({ proposalId: 'prop-0002' })];
    await waitFor(() => expect(listPoolProposals.mock.calls.length).toBeGreaterThan(reads), {
      timeout: 10_000,
    });
  });

  it('stops reading once the screen is gone', async () => {
    const listPoolProposals = vi.fn(() => Promise.resolve([proposal()]));
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals,
        listPools: () => Promise.resolve([]),
      },
    });

    await openPools(user);
    await screen.findByText('Awaiting dvo');
    const reads = listPoolProposals.mock.calls.length;

    cleanup();
    await act(() => new Promise((resolve) => setTimeout(resolve, 3_200)));

    expect(listPoolProposals.mock.calls.length).toBe(reads);
  });

  it('asks nothing while the tab is hidden', async () => {
    const listPoolProposals = vi.fn(() => Promise.resolve([proposal()]));
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals,
        listPools: () => Promise.resolve([]),
      },
    });

    await openPools(user);
    await screen.findByText('Awaiting dvo');
    const reads = listPoolProposals.mock.calls.length;

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 3_200)));
    expect(listPoolProposals.mock.calls.length).toBe(reads);

    await act(async () => {
      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(listPoolProposals.mock.calls.length).toBeGreaterThan(reads));
    visibility.mockRestore();
  });

  it('aborts the read in flight when the screen goes away', async () => {
    const seen: AbortSignal[] = [];
    const user = renderPools({
      admin: {
        listOnboardings: () => Promise.resolve([]),
        listPoolProposals: (options) => {
          if (options?.signal) seen.push(options.signal);
          // Never answers, so the read is still in flight at unmount.
          return new Promise(() => {});
        },
        listPools: () => Promise.resolve([]),
      },
    });

    await openPools(user);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]?.aborted).toBe(false);

    cleanup();
    expect(seen[0]?.aborted).toBe(true);
  });
});

describe('the demo keeps its own pools', () => {
  it('never reads the venue’s pool routes', async () => {
    const listPoolProposals = vi.fn(() => Promise.reject(new Error('the demo must not call this')));
    const client = testClient({
      me: () => Promise.resolve(OPERATOR),
      onboarding: { mine: () => Promise.resolve(null) },
      pools: { list: () => Promise.resolve([]) },
      admin: { listOnboardings: () => Promise.resolve([]), listPoolProposals },
    });
    const session: Session = { mode: 'demo', current: OPERATOR, loading: false };
    render(
      <DexProvider
        client={client}
        session={session}
        demo={{ pools: {}, swaps: {} } as never}
      >
        <App />
      </DexProvider>,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Pools' }));

    expect(listPoolProposals).not.toHaveBeenCalled();
  });
});
