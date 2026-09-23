import {
  Banner,
  CardContent,
  Input,
  Label,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { useEffect, useRef, useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAction, useAsync } from '../../app/useAsync';
import type {
  PoolDetail,
  PoolProposalRecord,
  PoolProposalStatus,
  PoolProposalTerms,
  PoolTerms,
} from '../../lib/api/types';
import {
  formatDateTime,
  formatFeeBps,
  poolProposalStatusLabels,
  poolProposalStatusTones,
  pairSymbols,
} from '../../lib/labels';
import { formatExact } from '../../lib/decimal';
import { Mono } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { CopyField } from '../../ui/CopyField';
import { Disclosure } from '../../ui/Disclosure';
import { NoticeBoard } from '../../ui/NoticeBoard';
import { AsyncSection, EmptyState, ErrorState } from '../../ui/States';
import { PageHeader } from '../../ui/PageHeader';
import { TokenPair } from '../../ui/TokenLogo';
import { PoolProposalForm } from './PoolProposalForm';
import { usePoolNotices } from './poolNotices';

/** Statuses the venue or the dvo is still moving, which is what keeps polling. */
const SETTLING: ReadonlySet<PoolProposalStatus> = new Set([
  'SUBMITTING',
  'PENDING',
  'UNRESOLVED',
]);

type Filter = 'open' | 'created' | 'all';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'created', label: 'Created' },
  { id: 'all', label: 'All' },
];

function matchesFilter(proposal: PoolProposalRecord, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'created') return proposal.status === 'CREATED';
  return SETTLING.has(proposal.status);
}

function pairOf(terms: PoolProposalTerms): string {
  return `${terms.baseInstrumentId.id} / ${terms.quoteInstrumentId.id}`;
}

function matchesSearch(haystack: string[], search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

export function VenuePools() {
  const client = useDexClient();
  const proposals = useAsync((signal) => client.admin.listPoolProposals({ signal }), [client], {
    pollWhile: () => true,
  });
  const pools = useAsync((signal) => client.admin.listPools({ signal }), [client]);
  const updates = usePoolNotices(proposals.data);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('open');

  // A proposal the dvo accepted names a pool. Where the catalogue does not have
  // it yet, read it again: one read per set of accepted pools, so a catalogue
  // that stays behind is not asked over and over.
  const acceptedKey = (proposals.data ?? [])
    .filter((proposal) => proposal.status === 'CREATED' && proposal.poolId !== null)
    .map((proposal) => proposal.poolId)
    .join(',');
  const asked = useRef<string | null>(null);
  const reloadPools = pools.reload;
  const knownPools = pools.data;
  useEffect(() => {
    if (!knownPools || acceptedKey === asked.current) return;
    asked.current = acceptedKey;
    const known = new Set(knownPools.map((pool) => pool.poolId));
    const missing = acceptedKey.split(',').filter((poolId) => poolId !== '' && !known.has(poolId));
    if (missing.length > 0) reloadPools();
  }, [acceptedKey, knownPools, reloadPools]);

  if (proposals.error && !proposals.data) {
    return (
      <div className="flex flex-col gap-6 fade-in">
        <PageHeader title="Pools" />
        <Card padded>
          <ErrorState error={proposals.error} onRetry={proposals.reload} />
        </Card>
      </div>
    );
  }

  const open = (proposals.data ?? []).filter((proposal) => SETTLING.has(proposal.status));
  const failed = (proposals.data ?? []).filter((proposal) => proposal.status === 'FAILED');

  return (
    <div className="flex flex-col gap-6 fade-in">
      <PageHeader
        title="Pools"
        actions={creating ? null : <Button onClick={() => setCreating(true)}>New pool</Button>}
      />

      <NoticeBoard notices={updates.notices} onDismiss={updates.dismiss} />

      <div className="grid grid-cols-2 gap-3 min-[721px]:grid-cols-3">
        <Stat label="Pools" value={pools.data?.length} />
        <Stat label="In progress" value={proposals.data ? open.length : undefined} />
        <Stat label="Needs attention" value={proposals.data ? failed.length : undefined} />
      </div>

      {creating ? (
        <PoolProposalForm
          onClose={() => setCreating(false)}
          onProposed={() => {
            setCreating(false);
            proposals.reload();
          }}
        />
      ) : null}

      <Card>
        <CardHeader
          title="Proposals"
          actions={
            <div className="bg-surface inline-flex gap-0.5 rounded-full border p-[0.1875rem]">
              {FILTERS.map((one) => (
                <Button
                  key={one.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={
                    filter === one.id
                      ? 'bg-card text-foreground shadow-card rounded-full px-3 py-[0.3125rem] text-[0.75rem] font-medium transition-colors'
                      : 'text-muted-foreground hover:text-foreground rounded-full px-3 py-[0.3125rem] text-[0.75rem] font-medium transition-colors'
                  }
                  aria-pressed={filter === one.id}
                  onClick={() => setFilter(one.id)}
                >
                  {one.label}
                </Button>
              ))}
            </div>
          }
        />
        <AsyncSection
          result={proposals}
          label="Loading proposals"
          rows={3}
          empty={<EmptyState title="No proposals yet" />}
        >
          {(list) => (
            <ProposalList
              proposals={list.filter((proposal) => matchesFilter(proposal, filter))}
              onChanged={proposals.reload}
            />
          )}
        </AsyncSection>
      </Card>

      <Card>
        <CardHeader
          title="Live pools"
          actions={
            <div className="[&_input]:min-w-48">
              <Label className="sr-only" htmlFor="pool-search">
                Search pools
              </Label>
              <Input
                id="pool-search"
                type="search"
                placeholder="Search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          }
        />
        <AsyncSection
          result={pools}
          label="Loading pools"
          rows={2}
          empty={<EmptyState title="No pools yet" />}
        >
          {(list) => (
            <PoolGrid
              pools={list.filter((pool) =>
                matchesSearch([pool.name, pairOf(pool.settings), pool.poolId], search),
              )}
            />
          )}
        </AsyncSection>
      </Card>
    </div>
  );
}

/** The instruments, unless the name already is them. */
function Pair({ terms, name }: { terms: PoolProposalTerms; name: string }) {
  const pair = pairOf(terms);
  if (pair === name) return null;
  return <p className="text-muted-foreground text-xs font-mono">{pair}</p>;
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div data-slot="stat" className="bg-surface flex flex-col-reverse gap-1 rounded-md border px-4.5 py-4">
      <span className="text-2xl leading-[1.1] font-semibold tracking-[-0.02em] tabular-nums">{value ?? '—'}</span>
      <span className="text-muted-foreground text-[0.6875rem] tracking-[0.05em] uppercase">{label}</span>
    </div>
  );
}

function parties(terms: PoolProposalTerms) {
  return [
    { label: 'Base admin', value: <Mono>{terms.baseInstrumentId.admin}</Mono> },
    { label: 'Quote admin', value: <Mono>{terms.quoteInstrumentId.admin}</Mono> },
    { label: 'dvo', value: <Mono>{terms.dvo}</Mono> },
  ];
}

/** What the dvo configured on acceptance. The reserves are on the card itself. */
function PoolTermsList({ terms }: { terms: PoolTerms }) {
  return (
    <DataList
      items={[
        {
          label: 'Initial ratio',
          value: `${formatExact(terms.initialRatio)} ${terms.quoteInstrumentId.id} per ${terms.baseInstrumentId.id}`,
        },
        { label: 'LP token', value: <Mono>{terms.lpTokenInstrumentId.id}</Mono> },
        ...parties(terms),
      ]}
    />
  );
}

function PoolGrid({ pools }: { pools: PoolDetail[] }) {
  if (pools.length === 0) {
    return (
      <CardContent className="p-5">
        <EmptyState title="No match" />
      </CardContent>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3 p-5">
      {pools.map((pool) => (
        <article key={pool.poolId} className="bg-card flex flex-col gap-3 rounded-md border px-4 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              {/* The marks sit beside the heading, never inside it: a name a
                  reader hears must be the pool's own. */}
              <TokenPair tokens={pairSymbols(pool.name).map((symbol) => ({ symbol }))} size="sm" />
              <div className="flex min-w-0 flex-col [&>*]:truncate">
                <h3 className="text-[0.9375rem] font-semibold">{pool.name}</h3>
                <Pair terms={pool.settings} name={pool.name} />
              </div>
            </div>
            <StatusBadge tone="success" label={formatFeeBps(pool.settings.feeBps)} />
          </div>
          {/* One figure per row: exact amounts run long and must never meet. */}
          <DataList
            variant="summary"
            items={[
              {
                label: `${pool.settings.baseInstrumentId.id} reserve`,
                value: formatExact(pool.settings.baseReserve),
              },
              {
                label: `${pool.settings.quoteInstrumentId.id} reserve`,
                value: formatExact(pool.settings.quoteReserve),
              },
              { label: 'LP supply', value: formatExact(pool.settings.lpTokenSupply) },
            ]}
          />
          <Disclosure summary="Contracts">
            <CopyField label="Pool" value={pool.poolId} />
            <CopyField label="Config" value={pool.configId} />
            <CopyField label="State" value={pool.stateId} />
            <DataList
              items={[
                { label: 'Package', value: <Mono>{pool.packageId}</Mono> },
                {
                  label: 'Created',
                  value: pool.createdAt ? formatDateTime(pool.createdAt) : 'Not recorded',
                },
              ]}
            />
            <PoolTermsList terms={pool.settings} />
          </Disclosure>
        </article>
      ))}
    </div>
  );
}

function ProposalList({
  proposals,
  onChanged,
}: {
  proposals: PoolProposalRecord[];
  onChanged: () => void;
}) {
  if (proposals.length === 0) {
    return (
      <CardContent className="p-5">
        <EmptyState title="Nothing here" />
      </CardContent>
    );
  }
  return (
    <CardContent className="p-5 flex flex-col gap-2">
      {proposals.map((proposal) => (
        <ProposalRow key={proposal.proposalId} proposal={proposal} onChanged={onChanged} />
      ))}
    </CardContent>
  );
}

function ProposalRow({
  proposal,
  onChanged,
}: {
  proposal: PoolProposalRecord;
  onChanged: () => void;
}) {
  const client = useDexClient();
  const withdraw = useAction(() => client.admin.withdrawPoolProposal(proposal.proposalId));

  return (
    <div data-slot="proposal-row" className="flex flex-col gap-2 rounded-md border px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-[0.9375rem] font-semibold">{proposal.name}</span>
          <Pair terms={proposal.settings} name={proposal.name} />
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge
            tone={poolProposalStatusTones[proposal.status]}
            dot={proposal.status === 'SUBMITTING' || proposal.status === 'UNRESOLVED'} label={poolProposalStatusLabels[proposal.status]} />
          {proposal.status === 'PENDING' ? (
            <Button
              size="sm"
              variant="secondary"
              loading={withdraw.pending}
              disabled={withdraw.pending}
              onClick={async () => {
                if (await withdraw.perform()) onChanged();
              }}
            >
              Withdraw
            </Button>
          ) : null}
        </div>
      </div>

      {proposal.error ? (
        <Banner variant={proposal.status === 'FAILED' ? 'error' : 'warning'} size="compact" dismissible={false}>
          {proposal.error}
        </Banner>
      ) : null}
      {withdraw.error ? <Banner variant="error" size="compact" dismissible={false}>{withdraw.error.message}</Banner> : null}

      <Disclosure summary="Details">
        <DataList
          items={[
            { label: 'Fee', value: formatFeeBps(proposal.settings.feeBps) },
            { label: 'Proposed', value: formatDateTime(proposal.createdAt) },
            { label: 'Updated', value: formatDateTime(proposal.updatedAt) },
            { label: 'By', value: <Mono>{proposal.proposedBy}</Mono> },
            { label: 'Factory', value: <Mono>{proposal.factoryId}</Mono> },
          ]}
        />
        <CopyField label="Proposal ID" value={proposal.proposalId} />
        {proposal.proposalCid ? (
          <CopyField label="Proposal contract" value={proposal.proposalCid} />
        ) : null}
        {proposal.poolId ? <CopyField label="Pool" value={proposal.poolId} /> : null}
        {proposal.updateId ? <CopyField label="Ledger update" value={proposal.updateId} /> : null}
        <DataList items={parties(proposal.settings)} />
      </Disclosure>
    </div>
  );
}
