import { Button, DataTable, type DataTableColumn } from '@openzeppelin/ui-components';
import { useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAsync } from '../../app/useAsync';
import type { Onboarding } from '../../lib/api/types';
import { formatDateTime, onboardingStatusLabels, onboardingStatusTones } from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { AsyncSection, EmptyState } from '../../ui/States';
import { PageHeader } from '../../ui/PageHeader';
import { isWorking } from './progress';
import {
  DEFAULT_ORDER,
  nextOrder,
  orderQueue,
  type QueueColumn,
  type QueueOrder,
} from './queueOrder';

/** Heading text back to the column it names, for the sort button's own name. */
const COLUMN_IDS: Record<string, QueueColumn | undefined> = {
  Applicant: 'applicant',
  Country: 'country',
  Submitted: 'submitted',
  Status: 'status',
};

export function OperatorOnboardingList({ onOpen }: { onOpen: (onboardingId: string) => void }) {
  const client = useDexClient();
  const [order, setOrder] = useState<QueueOrder>(DEFAULT_ORDER);
  const onboardings = useAsync((signal) => client.admin.listOnboardings({ signal }), [client], {
    // New applications arrive from other sessions, so an empty queue polls too.
    pollWhile: () => true,
  });
  const total = onboardings.data?.length;
  const pending = onboardings.data?.filter((onboarding) => onboarding.review === null).length;

  /**
   * The queue orders itself.
   *
   * The table offers the sort affordance and reports which column was asked
   * for; `queueOrder` decides what that means. It compares text the way a
   * reader reads it and breaks a tie by date and then by identifier, so two
   * identical readings never swap places between polls.
   */
  const columns: DataTableColumn<Onboarding>[] = [
    {
      id: 'applicant',
      header: 'Applicant',
      sortable: true,
      cell: (onboarding) => (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-foreground decoration-border hover:decoration-current"
          onClick={() => onOpen(onboarding.id)}
        >
          {onboarding.application.legalName}
        </Button>
      ),
    },
    {
      id: 'country',
      header: 'Country',
      sortable: true,
      cell: (onboarding) => onboarding.application.countryCode,
    },
    {
      id: 'submitted',
      header: 'Submitted',
      sortable: true,
      cellClassName: 'text-muted-foreground',
      cell: (onboarding) => formatDateTime(onboarding.createdAt),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      cell: (onboarding) => (
        <StatusBadge
          tone={onboardingStatusTones[onboarding.status]}
          dot={isWorking(onboarding)}
          label={onboardingStatusLabels[onboarding.status]}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6 fade-in">
      <PageHeader title="Onboarding requests" />

      <Card>
        <CardHeader
          title="Requests"
          description={
            total === undefined ? undefined : `${total} total, ${pending} awaiting review`
          }
        />
        <AsyncSection
          result={onboardings}
          label="Loading requests"
          empty={<EmptyState title="No onboarding requests yet" />}
        >
          {(requests) => (
            <DataTable
              caption="Onboarding requests"
              columns={columns}
              rows={orderQueue(requests, order)}
              getRowKey={(onboarding) => onboarding.id}
              sort={{
                columnId: order.column,
                direction: order.direction === 'ascending' ? 'asc' : 'desc',
              }}
              /*
               * The kit cycles a column through ascending, descending and
               * then no order at all, and reports that third press as `null`.
               * This queue only has two directions, so a press always names a
               * column and `queueOrder` decides which way it reads: a date
               * opens newest first, a name opens A to Z.
               */
              onSortChange={(next) =>
                setOrder((current) =>
                  nextOrder(current, (next?.columnId as QueueColumn) ?? current.column),
                )
              }
              // The kit names the order a column is already in. A heading here
              // is a button, and it says what pressing it would do.
              formatSortButtonName={({ columnName }) => {
                const column = COLUMN_IDS[columnName];
                if (!column) return `Sort by ${columnName}`;
                return `${columnName}, sort ${nextOrder(order, column).direction}`;
              }}
              className="border-0"
            />
          )}
        </AsyncSection>
      </Card>
    </div>
  );
}
