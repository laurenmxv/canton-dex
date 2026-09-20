import type { AsyncResult } from '../../app/useAsync';
import type { Settlement } from '../../lib/api/types';
import { formatExact } from '../../lib/decimal';
import {
  formatDateTime,
  settlementStatusLabels,
  settlementStatusTones,
  shortContract,
} from '../../lib/labels';
import { Badge } from '../../ui/Badge';
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
  return (
    <Card>
      <CardHeader title="Recent batches" />
      <AsyncSection
        result={batches}
        label="Loading batches"
        rows={2}
        empty={
          <EmptyState title="No batches yet" />
        }
      >
        {(list) => (
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Trigger</th>
                <th className="table-num">Requests</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {list.map((batch) => (
                <tr key={batch.settlementId}>
                  <td>{formatDateTime(batch.createdAt)}</td>
                  <td>{batch.trigger === 'MANUAL' ? 'Operator' : 'Automatic'}</td>
                  <td className="table-num tabular">{batch.swapIds.length}</td>
                  <td>
                    <Badge
                      tone={settlementStatusTones[batch.status]}
                      dot={batch.status === 'SUBMITTING' || batch.status === 'PREPARING'}
                    >
                      {settlementStatusLabels[batch.status]}
                    </Badge>
                  </td>
                  <td>
                    <Disclosure summary="Show detail">
                      <BatchDetail batch={batch} baseLabel={baseLabel} quoteLabel={quoteLabel} />
                    </Disclosure>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
          { label: 'Batch', value: <span className="mono">{batch.settlementId}</span> },
          { label: 'Policy version', value: String(batch.policyVersion) },
          {
            label: 'Ledger update',
            value: batch.updateId && confirmed ? (
              <span className="mono">{shortContract(batch.updateId)}</span>
            ) : (
              'Not confirmed'
            ),
          },
          ...(delta
            ? [
                { label: `${baseLabel} change`, value: <span className="tabular">{delta.base}</span> },
                {
                  label: `${quoteLabel} change`,
                  value: <span className="tabular">{delta.quote}</span>,
                },
              ]
            : []),
          ...(batch.error
            ? [{ label: 'Reported problem', value: `${batch.errorCode ?? ''} ${batch.error}`.trim() }]
            : []),
        ]}
      />
      {batch.fills.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Request</th>
              <th className="table-num">{confirmed ? 'Paid out' : 'Projected, not paid'}</th>
            </tr>
          </thead>
          <tbody>
            {batch.fills.map((fill) => (
              <tr key={fill.swapId}>
                <td className="mono">{shortContract(fill.swapId)}</td>
                <td className="table-num tabular">
                  {formatExact(fill.amountOut)}{' '}
                  {/* Either side of a pair can be the output, so an unrecorded
                      instrument stays unknown rather than being guessed at. */}
                  {fill.outputInstrument ? (
                    fill.outputInstrument.id
                  ) : (
                    <span className="muted">token unknown</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted text-xs">No fills</p>
      )}
    </>
  );
}
