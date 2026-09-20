import { useState } from 'react';
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
import { Badge, Callout } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { SelectField, TextField } from '../../ui/Field';
import { AsyncSection, EmptyState } from '../../ui/States';
import { approvalCount } from './approvals';

export function OperatorPools({
  onOpenProposal,
}: {
  onOpenProposal: (proposalId: string) => void;
}) {
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
    <div className="stack-lg fade-in">
      <header className="page-head">
        <h1 className="page-title">Pools</h1>
      </header>

      <Card>
        <CardHeader
          title="Pool proposals"
          actions={
            <Button size="sm" onClick={() => setCreating((value) => !value)}>
              {creating ? 'Cancel' : 'New proposal'}
            </Button>
          }
        />
        {creating ? (
          <div className="card-pad" style={{ borderBottom: '1px solid var(--border)' }}>
            {instruments.error ? (
              <Callout tone="warning" title="Could not load instruments">
                {instruments.error.message}{' '}
                <button type="button" className="table-link" onClick={instruments.reload}>
                  Try again
                </button>
              </Callout>
            ) : instruments.data === undefined ? (
              <p className="muted text-xs">Loading instruments…</p>
            ) : (
              <ProposalForm
                instruments={instruments.data}
                onCreated={() => {
                  setCreating(false);
                  refreshAll();
                }}
              />
            )}
          </div>
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
            <table className="table">
              <thead>
                <tr>
                  <th>Pair</th>
                  <th className="table-num">Fee</th>
                  <th>Approvals</th>
                  <th>Created</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((proposal) => {
                  const { approved, required } = approvalCount(proposal);
                  return (
                    <tr key={proposal.proposalId}>
                      <td>
                        <button
                          type="button"
                          className="table-link"
                          onClick={() => onOpenProposal(proposal.proposalId)}
                        >
                          {proposal.name}
                        </button>
                      </td>
                      <td className="table-num">{proposal.settings.feeBps} bps</td>
                      <td className="tabular">
                        {approved} of {required}
                      </td>
                      <td className="muted">{formatDateTime(proposal.createdAt)}</td>
                      <td>
                        <Badge tone={proposalStatusTones[proposal.status]}>
                          {proposalStatusLabels[proposal.status]}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </AsyncSection>
      </Card>

      <Card>
        <CardHeader title="Live pools" />
        <AsyncSection
          result={pools}
          label="Loading pools"
          rows={2}
          empty={<EmptyState title="No live pools" />}
        >
          {(list) => (
            <table className="table">
              <thead>
                <tr>
                  <th>Pool</th>
                  <th>Identifier</th>
                  <th className="table-num">Fee</th>
                  <th className="table-num">Base reserve</th>
                  <th className="table-num">Quote reserve</th>
                </tr>
              </thead>
              <tbody>
                {list.map((pool) => (
                  <tr key={pool.poolId}>
                    <td>{pool.name}</td>
                    <td className="mono muted">{pool.poolId}</td>
                    <td className="table-num">{pool.feeBps} bps</td>
                    <td className="table-num">
                      {formatAmount(pool.baseReserve)} {symbol(pool.baseInstrumentId)}
                    </td>
                    <td className="table-num">
                      {formatAmount(pool.quoteReserve)} {symbol(pool.quoteInstrumentId)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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

  return (
    <div className="stack">
      <div className="grid-3">
        <SelectField
          label="Base instrument"
          value={base}
          error={touched ? errors.base : undefined}
          onChange={(event) => setBase(event.target.value)}
        >
          <option value="">Select…</option>
          {instruments.map((instrument) => (
            <option key={instrument.id} value={instrument.id}>
              {instrument.symbol}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Quote instrument"
          value={quote}
          error={touched ? errors.quote : undefined}
          onChange={(event) => setQuote(event.target.value)}
        >
          <option value="">Select…</option>
          {instruments.map((instrument) => (
            <option key={instrument.id} value={instrument.id}>
              {instrument.symbol}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Fee (bps)"
          value={feeBps}
          inputMode="numeric"
          hint={`Below ${BPS_SCALE}`}
          error={touched ? errors.feeBps : undefined}
          onChange={(event) => setFeeBps(event.target.value)}
        />
      </div>
      <div className="grid-2">
        <TextField
          label="Initial base reserve"
          value={baseReserve}
          inputMode="decimal"
          placeholder="1000000"
          error={touched ? errors.baseReserve : undefined}
          onChange={(event) => setBaseReserve(event.target.value)}
        />
        <TextField
          label="Initial quote reserve"
          value={quoteReserve}
          inputMode="decimal"
          placeholder="995000"
          error={touched ? errors.quoteReserve : undefined}
          onChange={(event) => setQuoteReserve(event.target.value)}
        />
      </div>
      <Callout tone="demo">Reserves and instruments are fixtures</Callout>
      {create.error ? <Callout tone="danger">{create.error.message}</Callout> : null}
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
