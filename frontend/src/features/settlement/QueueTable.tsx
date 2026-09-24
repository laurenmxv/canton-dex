import { useId, type ReactNode } from 'react';
import {
  Banner,
  CardContent,
  DataTable,
  Input,
  Label,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { NUMERIC } from '../../ui/table';
import type { AsyncResult } from '../../app/useAsync';
import type { SettlementMonitoring, SettlementRequest, SettlementRequestRef } from '../../lib/api/types';
import { formatAge } from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { AsyncSection, EmptyState } from '../../ui/States';
import {
  isWaiting,
  sameRequest,
  VIEWS,
  visible,
  type FamilyInfo,
  type QueueRow,
  type View,
} from './queueRows';
import { Deadline, DeferButton, DetailsButton, RequestCell } from './RequestCells';

/**
 * One family's queued requests, in its own arrival order, under the queue's
 * own controls. Filters narrow what is shown and never reorder the queue.
 * Deferred requests are listed apart.
 */
export function QueueTable({
  family,
  actions,
  queue,
  rows,
  monitoring,
  view,
  onView,
  search,
  onSearch,
  searchId,
  onOpen,
  holding,
  holdsLocked,
  busy,
  onDefer,
  now,
}: {
  family: FamilyInfo;
  /** What the operator does to this queue as a whole: its settings and its manual run. */
  actions: ReactNode;
  queue: AsyncResult<SettlementRequest[]>;
  /** The family's queued rows, deferred ones excluded, in arrival order. */
  rows: QueueRow[] | undefined;
  monitoring: SettlementMonitoring | undefined;
  view: View;
  onView: (view: View) => void;
  search: string;
  onSearch: (search: string) => void;
  /** The search field's id, which the detail dialog returns focus to when its row is gone. */
  searchId: string;
  onOpen: (row: QueueRow, trigger: HTMLElement) => void;
  /** The request whose hold is being changed. */
  holding: string | undefined;
  /** The pool has a batch in flight, and no hold can change until it ends. */
  holdsLocked: boolean;
  busy: boolean;
  onDefer: (request: SettlementRequestRef) => void;
  now: number;
}) {
  const titleId = useId();
  const blocked = monitoring?.blockedRequest ?? null;
  const reason = blocked?.type === family.type ? (monitoring?.blockedReason ?? null) : null;
  const queued = rows ?? [];
  const shown = queued.filter((row) => visible(row, view, search));
  // The head is the first request the family would settle; only it can hold the queue.
  const head = queued.find((row) => row.stage !== 'other');
  const headBlocked = head?.stage === 'blocked' ? head : undefined;
  const why = reason ?? headBlocked?.error;

  return (
    <Card>
      <CardHeader
        title={family.title}
        titleId={titleId}
        description={
          queued.length === 0
            ? 'Empty'
            : shown.length === queued.length
              ? `${queued.length} queued`
              : `${shown.length} of ${queued.length} shown`
        }
        actions={actions}
      />

      {headBlocked || reason ? (
        <CardContent className="px-5 pt-4 pb-0">
          <Banner variant="warning" title="The head of this queue cannot settle" size="compact" dismissible={false}>
            {why ?? 'The venue reports it blocked at the current reserves.'} Other queues are
            independent.
          </Banner>
        </CardContent>
      ) : null}

      <CardContent className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <div role="group" aria-label="Show" className="bg-surface flex flex-wrap gap-0.5 rounded-2xl border p-[0.1875rem]">
          {VIEWS.map((one) => (
            <Button
              key={one.id}
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={view === one.id}
              className="text-muted-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-card h-7 rounded-full px-3 text-[0.75rem] font-medium"
              onClick={() => onView(one.id)}
            >
              {one.label}
            </Button>
          ))}
        </div>
        <Label className="sr-only" htmlFor={searchId}>
          Search requests
        </Label>
        <Input
          id={searchId}
          type="search"
          placeholder="Request, quote, trader or allocation"
          className="h-8 w-72 text-xs"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
      </CardContent>

      <AsyncSection result={queue} label="Loading the queue" rows={3}>
        {() =>
          queued.length === 0 ? (
            <EmptyState title="Nothing queued" />
          ) : shown.length === 0 ? (
            <p className="text-muted-foreground px-5 py-4 text-xs">No request matches</p>
          ) : (
            <DataTable
              aria-labelledby={titleId}
              columns={[
                {
                  id: 'order',
                  header: 'Order',
                  cellClassName: 'tabular-nums text-muted-foreground',
                  cell: (row) => row.arrivalSequence ?? '—',
                },
                { id: 'request', header: 'Request', cell: (row) => <RequestCell row={row} /> },
                {
                  ...NUMERIC,
                  id: 'amount-in',
                  header: 'Amount in',
                  cellClassName: 'tabular-nums whitespace-nowrap',
                  cell: (row) => row.offered,
                },
                {
                  ...NUMERIC,
                  id: 'min-out',
                  header: 'Minimum out',
                  cellClassName: 'tabular-nums whitespace-nowrap',
                  cell: (row) => row.minimum,
                },
                {
                  id: 'status',
                  header: 'Status',
                  cell: (row) => (
                    <div className="flex flex-col gap-1">
                      <StatusBadge tone={sameRequest(row, blocked) ? 'warning' : row.tone} label={row.label} />
                      {row.error ? <span className="text-muted-foreground text-xs">{row.error}</span> : null}
                    </div>
                  ),
                },
                {
                  id: 'timing',
                  header: 'Waiting · due',
                  cellClassName: 'tabular-nums whitespace-nowrap text-xs',
                  cell: (row) => (
                    <>
                      {row.submittedAt === null ? '—' : formatAge(row.submittedAt, now)}
                      <span className="text-muted-foreground"> · </span>
                      <Deadline deadline={row.settlementDeadline} now={now} />
                    </>
                  ),
                },
                {
                  id: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  cell: (row) => (
                    <div className="flex items-center justify-end gap-1">
                      {isWaiting(row, now) ? (
                        <DeferButton
                          row={row}
                          holding={holding}
                          disabled={holdsLocked || busy}
                          onDefer={onDefer}
                        />
                      ) : null}
                      <DetailsButton row={row} onOpen={onOpen} />
                    </div>
                  ),
                },
              ]}
              rows={shown}
              getRowKey={(row) => row.requestId}
              className="border-0"
            />
          )
        }
      </AsyncSection>
    </Card>
  );
}
