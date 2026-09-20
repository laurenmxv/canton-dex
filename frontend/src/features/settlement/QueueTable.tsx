import type { AsyncResult } from '../../app/useAsync';
import type { SettlementMonitoring, SettlementRequest } from '../../lib/api/types';
import { formatDecimal } from '../../lib/decimal';
import {
  formatAge,
  formatCountdown,
  shortContract,
  swapStatusLabels,
  swapStatusTones,
} from '../../lib/labels';
import { Badge, Callout } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { AsyncSection, EmptyState } from '../../ui/States';

/**
 * Everything outstanding for this pool, oldest first.
 *
 * It asks for the whole active queue rather than the ready part alone, so a
 * request that cannot settle is visible instead of missing. The venue settles
 * the earliest eligible run and never reorders it to reach a target, so a
 * blocked request at the head holds the queue and is named here.
 */
export function QueueTable({
  queue,
  monitoring,
  now,
}: {
  queue: AsyncResult<SettlementRequest[]>;
  monitoring: SettlementMonitoring | undefined;
  now: number;
}) {
  const blockedId = monitoring?.blockedSwapId ?? null;

  return (
    <Card>
      <CardHeader
        title="Queue"
        // The venue's two counts are not the queue's length and do not add up
        // to it: `pendingCount` counts only the requests whose own command is
        // still in flight. The length comes from the queue this card loaded.
        description={
          monitoring
            ? `${monitoring.readyCount} ready · ${monitoring.pendingCount} awaiting confirmation${
                queue.data ? ` · ${queue.data.length} in this queue` : ''
              }`
            : undefined
        }
        actions={
          monitoring?.oldestSubmittedAt ? (
            <span className="muted text-xs">
              Oldest waiting {formatAge(monitoring.oldestSubmittedAt, now)}
              {monitoring.nearestDeadline
                ? ` · nearest deadline in ${formatCountdown(monitoring.nearestDeadline, now)}`
                : ''}
            </span>
          ) : null
        }
      />

      {/* The venue names a blocked request, and it also names a setting that
          stops this pool dispatching at all, which has no request behind it. */}
      {monitoring?.blockedReason ? (
        <div className="card-pad">
          <Callout
            tone="warning"
            title={
              blockedId
                ? 'The head of this queue cannot settle'
                : 'This pool cannot dispatch a batch'
            }
          >
            {monitoring.blockedReason}
          </Callout>
        </div>
      ) : null}

      <AsyncSection
        result={queue}
        label="Loading the queue"
        rows={3}
        empty={<EmptyState title="Nothing outstanding" />}
      >
        {(requests) => (
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Request</th>
                <th className="table-num">Amount in</th>
                <th className="table-num">Minimum out</th>
                <th>Status</th>
                <th>Waiting</th>
                <th>Deadline</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.swapId}>
                  <td className="tabular">
                    {request.arrivalSequence === null ? '—' : request.arrivalSequence}
                  </td>
                  <td className="mono">{shortContract(request.swapId)}</td>
                  <td className="table-num tabular">
                    {formatDecimal(request.amountIn)} {request.inputInstrument.id}
                  </td>
                  <td className="table-num tabular">
                    {formatDecimal(request.minOut)} {request.outputInstrument.id}
                  </td>
                  <td>
                    <Badge
                      tone={
                        request.swapId === blockedId ? 'warning' : swapStatusTones[request.status]
                      }
                    >
                      {swapStatusLabels[request.status]}
                    </Badge>
                  </td>
                  <td>
                    {request.submittedAt === null ? '—' : formatAge(request.submittedAt, now)}
                  </td>
                  <td>{formatCountdown(request.settlementDeadline, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncSection>
    </Card>
  );
}
