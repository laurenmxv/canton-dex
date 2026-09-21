import { useId } from 'react';
import {
  Banner,
  CardContent,
  DataTable,
} from '@openzeppelin/ui-components';
import { NUMERIC } from '../../ui/table';
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
import { StatusBadge } from '../../ui/Badge';
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
  const queueTitle = useId();
  const blockedId = monitoring?.blockedSwapId ?? null;

  return (
    <Card>
      <CardHeader
        titleId={queueTitle}
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
            <span className="text-muted-foreground text-xs">
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
        <CardContent className="p-5">
          <Banner
            variant="warning"
            title={
              blockedId
                ? 'The head of this queue cannot settle'
                : 'This pool cannot dispatch a batch'
            }
           size="compact" dismissible={false}>
            {monitoring.blockedReason}
          </Banner>
        </CardContent>
      ) : null}

      <AsyncSection
        result={queue}
        label="Loading the queue"
        rows={3}
        empty={<EmptyState title="Nothing outstanding" />}
      >
        {(requests) => (
          <DataTable
            aria-labelledby={queueTitle}
            columns={[
              {
                id: 'order',
                header: 'Order',
                cellClassName: 'tabular-nums',
                cell: (request) =>
                  request.arrivalSequence === null ? '—' : request.arrivalSequence,
              },
              {
                id: 'request',
                header: 'Request',
                cellClassName: 'font-mono text-xs',
                cell: (request) => shortContract(request.swapId),
              },
              {
                ...NUMERIC,
                id: 'amount-in',
                header: 'Amount in',
                cell: (request) =>
                  `${formatDecimal(request.amountIn)} ${request.inputInstrument.id}`,
              },
              {
                ...NUMERIC,
                id: 'min-out',
                header: 'Minimum out',
                cell: (request) =>
                  `${formatDecimal(request.minOut)} ${request.outputInstrument.id}`,
              },
              {
                id: 'status',
                header: 'Status',
                cell: (request) => (
                  <StatusBadge
                    tone={
                      request.swapId === blockedId ? 'warning' : swapStatusTones[request.status]
                    }
                    label={swapStatusLabels[request.status]}
                  />
                ),
              },
              {
                id: 'waiting',
                header: 'Waiting',
                cell: (request) =>
                  request.submittedAt === null ? '—' : formatAge(request.submittedAt, now),
              },
              {
                id: 'deadline',
                header: 'Deadline',
                cell: (request) => formatCountdown(request.settlementDeadline, now),
              },
            ]}
            rows={requests}
            getRowKey={(request) => request.swapId}
            className="border-0"
          />
        )}
      </AsyncSection>
    </Card>
  );
}
