import { useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAsync } from '../../app/useAsync';
import {
  formatDateTime,
  onboardingStatusLabels,
  onboardingStatusTones,
} from '../../lib/labels';
import { Badge } from '../../ui/Badge';
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

const COLUMNS: readonly [QueueColumn, string][] = [
  ['applicant', 'Applicant'],
  ['country', 'Country'],
  ['submitted', 'Submitted'],
  ['status', 'Status'],
];

export function OperatorOnboardingList({ onOpen }: { onOpen: (onboardingId: string) => void }) {
  const client = useDexClient();
  const [order, setOrder] = useState<QueueOrder>(DEFAULT_ORDER);
  const onboardings = useAsync((signal) => client.admin.listOnboardings({ signal }), [client], {
    // New applications arrive from other sessions, so an empty queue polls too.
    pollWhile: () => true,
  });
  const total = onboardings.data?.length;
  const pending = onboardings.data?.filter((onboarding) => onboarding.review === null).length;

  return (
    <div className="stack-lg fade-in">
      <PageHeader
        title="Onboarding requests"
        description="Review each application, then grant the pool access the ledger will carry."
      />

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
          empty={
            <EmptyState
              title="No onboarding requests yet"
            />
          }
        >
          {(requests) => (
            <table className="table">
              <thead>
                <tr>
                  {COLUMNS.map(([column, label]) => (
                    <SortableHeader
                      key={column}
                      column={column}
                      label={label}
                      order={order}
                      onSort={setOrder}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {orderQueue(requests, order).map((onboarding) => (
                  <tr key={onboarding.id}>
                    <td>
                      <button
                        type="button"
                        className="table-link"
                        onClick={() => onOpen(onboarding.id)}
                      >
                        {onboarding.application.legalName}
                      </button>
                    </td>
                    <td>{onboarding.application.countryCode}</td>
                    <td className="muted">{formatDateTime(onboarding.createdAt)}</td>
                    <td>
                      <Badge
                        tone={onboardingStatusTones[onboarding.status]}
                        dot={isWorking(onboarding)}
                      >
                        {onboardingStatusLabels[onboarding.status]}
                      </Badge>
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

/**
 * One column heading the operator can sort by.
 *
 * `aria-sort` tells assistive technology which column is ordering the table and
 * which way, and the button carries the direction a click would produce, so the
 * heading is usable without seeing the arrow.
 */
function SortableHeader({
  column,
  label,
  order,
  onSort,
}: {
  column: QueueColumn;
  label: string;
  order: QueueOrder;
  onSort: (order: QueueOrder) => void;
}) {
  const active = order.column === column;
  const next = nextOrder(order, column);
  return (
    <th aria-sort={active ? order.direction : 'none'}>
      <button
        type="button"
        className="column-sort"
        aria-label={`${label}, sort ${next.direction}`}
        onClick={() => onSort(next)}
      >
        {label}
        <span aria-hidden="true" className={active ? 'sort-arrow' : 'sort-arrow sort-arrow-idle'}>
          {active && order.direction === 'ascending' ? '↑' : '↓'}
        </span>
      </button>
    </th>
  );
}
