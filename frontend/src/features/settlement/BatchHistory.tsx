import { useId } from 'react';
import type { AsyncResult } from '../../app/useAsync';
import type { Settlement } from '../../lib/api/types';
import { formatExact } from '../../lib/decimal';
import {
  formatDateTime,
  settlementStatusLabels,
  settlementStatusTones,
  shortContract,
} from '../../lib/labels';
import { DataTable } from '@openzeppelin/ui-components';
import { NUMERIC } from '../../ui/table';
import { Mono } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { AsyncSection, EmptyState } from '../../ui/States';
import { reserveDelta } from './reserves';

/**
 * This pool's recent batches.
 *
 * A batch's membership is frozen when it is created, so the count is what it
 * took, not what was queued at the time. Only a confirmed batch has paid
 * anything; everything else says where it got to instead.
 */
export function BatchHistory({
  batches,
  baseLabel,
  quoteLabel,
}: {
  batches: AsyncResult<Settlement[]>;
  baseLabel: string;
  quoteLabel: string;
}) {
  const batchHistoryTitle = useId();
  return (
    <Card>
      <CardHeader title="Recent batches" titleId={batchHistoryTitle} />
      <AsyncSection
        result={batches}
        label="Loading batches"
        rows={2}
        empty={
          <EmptyState title="No batches yet" />
        }
      >
        {(list) => (
          <DataTable
            aria-labelledby={batchHistoryTitle}
            columns={[
              {
                id: 'started',
                header: 'Started',
                cell: (batch) => formatDateTime(batch.createdAt),
              },
              {
                id: 'trigger',
                header: 'Trigger',
                cell: (batch) => (batch.trigger === 'MANUAL' ? 'Operator' : 'Automatic'),
              },
              {
                ...NUMERIC,
                id: 'requests',
                header: 'Requests',
                cell: (batch) => batch.swapIds.length,
              },
              {
                id: 'status',
                header: 'Status',
                cell: (batch) => (
                  <StatusBadge
                    tone={settlementStatusTones[batch.status]}
                    dot={batch.status === 'SUBMITTING' || batch.status === 'PREPARING'}
                    label={settlementStatusLabels[batch.status]}
                  />
                ),
              },
              {
                id: 'detail',
                header: 'Detail',
                cell: (batch) => (
                  <Disclosure summary="Show detail">
                    <BatchDetail batch={batch} baseLabel={baseLabel} quoteLabel={quoteLabel} />
                  </Disclosure>
                ),
              },
            ]}
            rows={list}
            getRowKey={(batch) => batch.settlementId}
            className="border-0"
          />
        )}
      </AsyncSection>
    </Card>
  );
}

function BatchDetail({
  batch,
  baseLabel,
  quoteLabel,
}: {
  batch: Settlement;
  baseLabel: string;
  quoteLabel: string;
}) {
  // Only a confirmed batch has paid anything. The venue writes its preflight
  // projection at SUBMITTING, and membership can still shrink after that, so
  // an unconfirmed fill is an estimate that may never happen.
  const confirmed = batch.status === 'CONFIRMED';
  const delta = confirmed ? reserveDelta(batch.before, batch.after) : null;

  return (
    <>
      <DataList
        items={[
          { label: 'Batch', value: <Mono>{batch.settlementId}</Mono> },
          { label: 'Policy version', value: String(batch.policyVersion) },
          {
            label: 'Ledger update',
            value: batch.updateId && confirmed ? (
              <Mono>{shortContract(batch.updateId)}</Mono>
            ) : (
              'Not confirmed'
            ),
          },
          ...(delta
            ? [
                { label: `${baseLabel} change`, value: <span className="tabular-nums">{delta.base}</span> },
                {
                  label: `${quoteLabel} change`,
                  value: <span className="tabular-nums">{delta.quote}</span>,
                },
              ]
            : []),
          ...(batch.error
            ? [{ label: 'Reported problem', value: `${batch.errorCode ?? ''} ${batch.error}`.trim() }]
            : []),
        ]}
      />
      {batch.fills.length > 0 ? (
        <DataTable
          caption={`Fills in batch ${shortContract(batch.settlementId)}`}
          columns={[
            {
              id: 'request',
              header: 'Request',
              cellClassName: 'font-mono text-xs',
              cell: (fill) => shortContract(fill.swapId),
            },
            {
              ...NUMERIC,
              id: 'out',
              header: confirmed ? 'Paid out' : 'Projected, not paid',
              // Either side of a pair can be the output, so an unrecorded
              // instrument stays unknown rather than being guessed at.
              cell: (fill) => (
                <>
                  {formatExact(fill.amountOut)}{' '}
                  {fill.outputInstrument ? (
                    fill.outputInstrument.id
                  ) : (
                    <span className="text-muted-foreground">token unknown</span>
                  )}
                </>
              ),
            },
          ]}
          rows={batch.fills}
          getRowKey={(fill) => fill.swapId}
        />
      ) : (
        <p className="text-muted-foreground text-xs">No fills</p>
      )}
    </>
  );
}
