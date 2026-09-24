import { DataTable, LoadingButton as Button } from '@openzeppelin/ui-components';
import { useId } from 'react';
import type { SettlementRequestRef } from '../../lib/api/types';
import { shortContract } from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { NUMERIC } from '../../ui/table';
import { holdLabels, isWaiting, type FamilyInfo, type QueueRow } from './queueRows';
import { Deadline, DetailsButton, RequestCell } from './RequestCells';

/**
 * The requests an operator held back from one family's batches.
 *
 * A hold changes only when batches look at a request: its allocations stay
 * locked and its deadline runs on. Returning one puts it at the tail of its
 * queue. One that expired stays listed, and can neither return nor settle.
 */
export function DeferredList({
  family,
  rows,
  holding,
  holdsLocked,
  busy,
  onReturn,
  onOpen,
  now,
}: {
  family: FamilyInfo;
  rows: QueueRow[];
  holding: string | undefined;
  holdsLocked: boolean;
  busy: boolean;
  onReturn: (request: SettlementRequestRef) => void;
  onOpen: (row: QueueRow, trigger: HTMLElement) => void;
  now: number;
}) {
  const titleId = useId();
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title={`${holdLabels.deferred} · ${family.noun}`}
        titleId={titleId}
        description="Held from batches. Allocations stay locked and the original deadline applies."
      />
      <DataTable
        aria-labelledby={titleId}
        columns={[
          { id: 'request', header: 'Request', cell: (row) => <RequestCell row={row} /> },
          {
            ...NUMERIC,
            id: 'amount-in',
            header: 'Amount in',
            cellClassName: 'tabular-nums whitespace-nowrap',
            cell: (row) => row.offered,
          },
          {
            id: 'status',
            header: 'Status',
            cell: (row) => <StatusBadge tone={row.tone} label={row.label} />,
          },
          {
            id: 'due',
            header: 'Due',
            cellClassName: 'tabular-nums whitespace-nowrap text-xs',
            cell: (row) => <Deadline deadline={row.settlementDeadline} now={now} />,
          },
          {
            id: 'actions',
            header: <span className="sr-only">Actions</span>,
            cell: (row) => (
              <div className="flex items-center justify-end gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={holding === row.requestId}
                  disabled={holdsLocked || busy || !isWaiting(row, now)}
                  aria-label={`${holdLabels.back}: request ${shortContract(row.requestId)}`}
                  onClick={() => onReturn({ type: row.family, requestId: row.requestId })}
                >
                  {holdLabels.back}
                </Button>
                <DetailsButton row={row} onOpen={onOpen} />
              </div>
            ),
          },
        ]}
        rows={rows}
        getRowKey={(row) => row.requestId}
        className="border-0"
      />
    </Card>
  );
}
