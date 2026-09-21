import {
  Banner,
  CardContent,
  DataTable,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { NUMERIC } from '../../ui/table';
import { useId, useState } from 'react';
import { requireDemoApi } from '../../app/runtime';
import { useAction, useAsync } from '../../app/useAsync';
import type { Instrument } from '../../lib/api/types';
import { BPS_SCALE, parseAmount, toDecimal } from '../../lib/api/types';
import {
  formatAmount,
  formatDateTime,
  proposalStatusLabels,
  proposalStatusTones,
  symbolOf,
} from '../../lib/labels';
import { TextLink } from '../../ui/Link';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { SelectControl, TextControl } from '../../ui/Field';
import { AsyncSection, EmptyState } from '../../ui/States';
import { Note } from '../../ui/Note';
import { PageHeader } from '../../ui/PageHeader';
import { approvalCount } from './approvals';

export function OperatorPools({
  onOpenProposal,
}: {
  onOpenProposal: (proposalId: string) => void;
}) {
  const proposalsTitle = useId();
  const livePoolsTitle = useId();
  const demo = requireDemoApi();
  const pools = useAsync(() => demo.pools.list(), [demo]);
  const proposals = useAsync(() => demo.pools.listProposals(), [demo]);
  const instruments = useAsync(() => demo.pools.listInstruments(), [demo]);
  const [creating, setCreating] = useState(false);

  const symbol = (instrumentId: string) => symbolOf(instruments.data ?? [], instrumentId);

  function refreshAll() {
    proposals.reload();
    pools.reload();
  }

  return (
    <div className="flex flex-col gap-6 fade-in">
      <PageHeader
        title="Pools"
        description="Propose a pool, collect its approvals, and create it."
      />

      <Card>
        <CardHeader
          titleId={proposalsTitle}
          title="Pool proposals"
          actions={
            <Button size="sm" onClick={() => setCreating((value) => !value)}>
              {creating ? 'Cancel' : 'New proposal'}
            </Button>
          }
        />
        {creating ? (
          <CardContent className="p-5" style={{ borderBottom: '1px solid var(--border)' }}>
            {instruments.error ? (
              <Banner variant="warning" title="Could not load instruments" size="compact" dismissible={false}>
                {instruments.error.message}{' '}
                <TextLink onClick={instruments.reload}>Try again</TextLink>
              </Banner>
            ) : instruments.data === undefined ? (
              <p className="text-muted-foreground text-xs">Loading instruments…</p>
            ) : (
              <ProposalForm
                instruments={instruments.data}
                onCreated={() => {
                  setCreating(false);
                  refreshAll();
                }}
              />
            )}
          </CardContent>
        ) : null}

        <AsyncSection
          result={proposals}
          label="Loading proposals"
          rows={2}
          empty={
            <EmptyState
              title="No proposals yet"
            />
          }
        >
          {(list) => (
            <DataTable
              aria-labelledby={proposalsTitle}
              columns={[
                {
                  id: 'pair',
                  header: 'Pair',
                  cell: (proposal) => (
                    <TextLink onClick={() => onOpenProposal(proposal.proposalId)}>{proposal.name}</TextLink>
                  ),
                },
                {
                  ...NUMERIC,
                  id: 'fee',
                  header: 'Fee',
                  cell: (proposal) => `${proposal.settings.feeBps} bps`,
                },
                {
                  id: 'approvals',
                  header: 'Approvals',
                  cellClassName: 'tabular-nums',
                  cell: (proposal) => {
                    const { approved, required } = approvalCount(proposal);
                    return `${approved} of ${required}`;
                  },
                },
                {
                  id: 'created',
                  header: 'Created',
                  cellClassName: 'text-muted-foreground',
                  cell: (proposal) => formatDateTime(proposal.createdAt),
                },
                {
                  id: 'status',
                  header: 'Status',
                  cell: (proposal) => (
                    <StatusBadge
                      tone={proposalStatusTones[proposal.status]}
                      label={proposalStatusLabels[proposal.status]}
                    />
                  ),
                },
              ]}
              rows={list}
              getRowKey={(proposal) => proposal.proposalId}
              className="border-0"
            />
          )}
        </AsyncSection>
      </Card>

      <Card>
        <CardHeader title="Live pools" titleId={livePoolsTitle} />
        <AsyncSection
          result={pools}
          label="Loading pools"
          rows={2}
          empty={<EmptyState title="No live pools" />}
        >
          {(list) => (
            <DataTable
              aria-labelledby={livePoolsTitle}
              columns={[
                { id: 'pool', header: 'Pool', cell: (pool) => pool.name },
                {
                  id: 'identifier',
                  header: 'Identifier',
                  cellClassName: 'font-mono text-xs text-muted-foreground',
                  cell: (pool) => pool.poolId,
                },
                {
                  ...NUMERIC,
                  id: 'fee',
                  header: 'Fee',
                  cell: (pool) => `${pool.feeBps} bps`,
                },
                {
                  ...NUMERIC,
                  id: 'base-reserve',
                  header: 'Base reserve',
                  cell: (pool) =>
                    `${formatAmount(pool.baseReserve)} ${symbol(pool.baseInstrumentId)}`,
                },
                {
                  ...NUMERIC,
                  id: 'quote-reserve',
                  header: 'Quote reserve',
                  cell: (pool) =>
                    `${formatAmount(pool.quoteReserve)} ${symbol(pool.quoteInstrumentId)}`,
                },
              ]}
              rows={list}
              getRowKey={(pool) => pool.poolId}
              className="border-0"
            />
          )}
        </AsyncSection>
      </Card>
    </div>
  );
}

function ProposalForm({
  instruments,
  onCreated,
}: {
  instruments: Instrument[];
  onCreated: () => void;
}) {
  const demo = requireDemoApi();
  const [base, setBase] = useState('');
  const [quote, setQuote] = useState('');
  const [feeBps, setFeeBps] = useState('30');
  const [baseReserve, setBaseReserve] = useState('');
  const [quoteReserve, setQuoteReserve] = useState('');
  const [touched, setTouched] = useState(false);

  const fee = parseAmount(feeBps);
  const baseAmount = parseAmount(baseReserve);
  const quoteAmount = parseAmount(quoteReserve);
  const errors = {
    base: base ? undefined : 'Choose a base instrument',
    quote: !quote
      ? 'Choose a quote instrument'
      : quote === base
        ? 'Quote must differ from base'
        : undefined,
    feeBps:
      fee !== undefined && fee >= 0 && fee < BPS_SCALE
        ? undefined
        : `Enter a fee between 0 and ${BPS_SCALE - 1} bps`,
    baseReserve: baseAmount !== undefined && baseAmount > 0 ? undefined : 'Enter an amount above zero',
    quoteReserve:
      quoteAmount !== undefined && quoteAmount > 0 ? undefined : 'Enter an amount above zero',
  };
  const valid = Object.values(errors).every((error) => error === undefined);

  const create = useAction(() =>
    demo.pools.createProposal({
      name: `${symbolOf(instruments, base)} / ${symbolOf(instruments, quote)}`,
      baseInstrumentId: base,
      quoteInstrumentId: quote,
      feeBps: fee ?? 0,
      baseReserve: toDecimal(baseAmount ?? 0),
      quoteReserve: toDecimal(quoteAmount ?? 0),
    }),
  );

  const instrumentOptions = instruments.map((instrument) => ({
    value: instrument.id,
    label: instrument.symbol,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <SelectControl
          label="Base instrument"
          placeholder="Select…"
          value={base}
          error={touched ? errors.base : undefined}
          onValueChange={setBase}
          options={instrumentOptions}
        />
        <SelectControl
          label="Quote instrument"
          placeholder="Select…"
          value={quote}
          error={touched ? errors.quote : undefined}
          onValueChange={setQuote}
          options={instrumentOptions}
        />
        <TextControl
          label="Fee (bps)"
          value={feeBps}
          inputMode="numeric"
          hint={`Below ${BPS_SCALE}`}
          error={touched ? errors.feeBps : undefined}
          onChange={(event) => setFeeBps(event.target.value)}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextControl
          label="Initial base reserve"
          value={baseReserve}
          inputMode="decimal"
          placeholder="1000000"
          error={touched ? errors.baseReserve : undefined}
          onChange={(event) => setBaseReserve(event.target.value)}
        />
        <TextControl
          label="Initial quote reserve"
          value={quoteReserve}
          inputMode="decimal"
          placeholder="995000"
          error={touched ? errors.quoteReserve : undefined}
          onChange={(event) => setQuoteReserve(event.target.value)}
        />
      </div>
      <Note tone="demo">Reserves and instruments are fixtures</Note>
      {create.error ? <Banner variant="error" size="compact" dismissible={false}>{create.error.message}</Banner> : null}
      <div>
        <Button
          loading={create.pending}
          onClick={async () => {
            setTouched(true);
            if (!valid) return;
            if (await create.perform()) onCreated();
          }}
        >
          Create proposal
        </Button>
      </div>
    </div>
  );
}
