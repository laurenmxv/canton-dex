import { useEffect, useRef, useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAction, useAsync } from '../../app/useAsync';
import type {
  PoolDetail,
  PoolProposalRecord,
  PoolProposalStatus,
  PoolTerms,
} from '../../lib/api/types';
import {
  formatDateTime,
  formatFeeBps,
  poolProposalStatusLabels,
  poolProposalStatusTones,
  pairSymbols,
  trimDecimal,
} from '../../lib/labels';
import { Badge, Callout } from '../../ui/Badge';
import { Button } from '../../ui/Button';
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

function pairOf(terms: PoolTerms): string {
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
      <div className="stack-lg fade-in">
        <PageHeader
          title="Pools"
          description="The venue catalogue, and the proposals waiting on the dvo."
        />
        <Card padded>
          <ErrorState error={proposals.error} onRetry={proposals.reload} />
        </Card>
      </div>
    );
  }

  const open = (proposals.data ?? []).filter((proposal) => SETTLING.has(proposal.status));
  const failed = (proposals.data ?? []).filter((proposal) => proposal.status === 'FAILED');

  return (
    <div className="stack-lg fade-in">
      <PageHeader
        title="Pools"
        description="The venue catalogue, and the proposals waiting on the dvo."
        actions={creating ? null : <Button onClick={() => setCreating(true)}>New pool</Button>}
      />

      <NoticeBoard notices={updates.notices} onDismiss={updates.dismiss} />

      <div className="stat-row">
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
            <div className="chip-row">
              {FILTERS.map((one) => (
                <button
                  key={one.id}
                  type="button"
                  className={`chip ${filter === one.id ? 'chip-on' : ''}`.trim()}
                  aria-pressed={filter === one.id}
                  onClick={() => setFilter(one.id)}
                >
                  {one.label}
                </button>
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
            <div className="search-field">
              <label className="sr-only" htmlFor="pool-search">
                Search pools
              </label>
              <input
                id="pool-search"
                className="control"
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
function Pair({ terms, name }: { terms: PoolTerms; name: string }) {
  const pair = pairOf(terms);
  if (pair === name) return null;
  return <p className="muted text-xs mono">{pair}</p>;
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="stat">
      <span className="stat-value">{value ?? '—'}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Terms({ terms }: { terms: PoolTerms }) {
  return (
    <DataList
      items={[
        { label: 'Base reserve', value: trimDecimal(terms.baseReserve) },
        { label: 'Quote reserve', value: trimDecimal(terms.quoteReserve) },
        { label: 'LP supply', value: trimDecimal(terms.lpTokenSupply) },
        { label: 'LP token', value: <span className="mono">{terms.lpTokenInstrumentId.id}</span> },
        { label: 'Base admin', value: <span className="mono">{terms.baseInstrumentId.admin}</span> },
        {
          label: 'Quote admin',
          value: <span className="mono">{terms.quoteInstrumentId.admin}</span>,
        },
        { label: 'dvo', value: <span className="mono">{terms.dvo}</span> },
      ]}
    />
  );
}

function PoolGrid({ pools }: { pools: PoolDetail[] }) {
  if (pools.length === 0) {
    return (
      <div className="card-pad">
        <EmptyState title="No match" />
      </div>
    );
  }
  return (
    <div className="card-pad pool-grid">
      {pools.map((pool) => (
        <article key={pool.poolId} className="pool-card">
          <div className="row-between">
            <div className="access-head">
              {/* The marks sit beside the heading, never inside it: a name a
                  reader hears must be the pool's own. */}
              <TokenPair tokens={pairSymbols(pool.name).map((symbol) => ({ symbol }))} size="sm" />
              <div className="access-name">
                <h3 className="pool-name">{pool.name}</h3>
                <Pair terms={pool.settings} name={pool.name} />
              </div>
            </div>
            <Badge tone="success">{formatFeeBps(pool.settings.feeBps)}</Badge>
          </div>
          <div className="pool-figures">
            <Figure label="Base" value={trimDecimal(pool.settings.baseReserve)} />
            <Figure label="Quote" value={trimDecimal(pool.settings.quoteReserve)} />
            <Figure label="LP supply" value={trimDecimal(pool.settings.lpTokenSupply)} />
          </div>
          <Disclosure summary="Contracts">
            <CopyField label="Pool" value={pool.poolId} />
            <CopyField label="Config" value={pool.configId} />
            <CopyField label="State" value={pool.stateId} />
            <DataList
              items={[
                { label: 'Package', value: <span className="mono">{pool.packageId}</span> },
                {
                  label: 'Created',
                  value: pool.createdAt ? formatDateTime(pool.createdAt) : 'Not recorded',
                },
              ]}
            />
            <Terms terms={pool.settings} />
          </Disclosure>
        </article>
      ))}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="pool-figure">
      <span className="pool-figure-label">{label}</span>
      <span className="pool-figure-value">{value}</span>
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
      <div className="card-pad">
        <EmptyState title="Nothing here" />
      </div>
    );
  }
  return (
    <div className="card-pad stack-sm">
      {proposals.map((proposal) => (
        <ProposalRow key={proposal.proposalId} proposal={proposal} onChanged={onChanged} />
      ))}
    </div>
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
    <div className="proposal-row">
      <div className="row-between">
        <div>
          <span className="proposal-name">{proposal.name}</span>
          <Pair terms={proposal.settings} name={proposal.name} />
        </div>
        <div className="row">
          <Badge
            tone={poolProposalStatusTones[proposal.status]}
            dot={proposal.status === 'SUBMITTING' || proposal.status === 'UNRESOLVED'}
          >
            {poolProposalStatusLabels[proposal.status]}
          </Badge>
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
        <Callout tone={proposal.status === 'FAILED' ? 'danger' : 'warning'}>
          {proposal.error}
        </Callout>
      ) : null}
      {withdraw.error ? <Callout tone="danger">{withdraw.error.message}</Callout> : null}

      <Disclosure summary="Details">
        <DataList
          items={[
            { label: 'Fee', value: formatFeeBps(proposal.settings.feeBps) },
            { label: 'Proposed', value: formatDateTime(proposal.createdAt) },
            { label: 'Updated', value: formatDateTime(proposal.updatedAt) },
            { label: 'By', value: <span className="mono">{proposal.proposedBy}</span> },
            { label: 'Factory', value: <span className="mono">{proposal.factoryId}</span> },
          ]}
        />
        <CopyField label="Proposal ID" value={proposal.proposalId} />
        {proposal.proposalCid ? (
          <CopyField label="Proposal contract" value={proposal.proposalCid} />
        ) : null}
        {proposal.poolId ? <CopyField label="Pool" value={proposal.poolId} /> : null}
        {proposal.updateId ? <CopyField label="Ledger update" value={proposal.updateId} /> : null}
        <Terms terms={proposal.settings} />
      </Disclosure>
    </div>
  );
}
