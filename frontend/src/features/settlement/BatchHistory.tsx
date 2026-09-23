import {
  CardContent,
  DataTable,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { useId } from 'react';
import type { RequestType, Settlement, SettlementStatus } from '../../lib/api/types';
import {
  batchSizeLabel,
  formatDateTime,
  requestTypeLabels,
  RETRY_OF,
  settlementStatusLabels,
  settlementStatusTones,
  shortContract,
} from '../../lib/labels';
import { NUMERIC } from '../../ui/table';
import { Mono } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { DetailDialog } from '../../ui/DetailDialog';
import { SelectControl } from '../../ui/Field';
import { AsyncSection, EmptyState } from '../../ui/States';
import { FillAmounts, type PoolLabels } from './FillAmounts';
import { FAMILIES, familyInfo } from './queueRows';
import { ReserveChart } from './ReserveChart';
import type { BatchHistoryRead } from './useBatchHistory';

/**
 * The attempts a retry can follow. Every other status is either still moving
 * or already settled, and retrying either could settle a request twice.
 */
const RETRYABLE: ReadonlySet<SettlementStatus> = new Set(['REJECTED', 'CANCELLED']);

/** The select's value for "no filter": a kit listbox item cannot carry an empty value. */
const ANY = 'any';

const STATUSES = Object.keys(settlementStatusLabels) as SettlementStatus[];

function queueOf(batch: Settlement): string {
  const type = batch.requests[0]?.type;
  return type ? familyInfo(type).noun : '—';
}

/**
 * Every batch this pool ran, newest first, a page at a time.
 *
 * The request count is a batch's own membership, which preflight can trim to
 * a valid prefix. Only a confirmed batch has paid anything; everything else
 * says where it got to instead. A rejected or cancelled attempt stays as it
 * was: reviewing a retry previews what is still eligible, and running it makes
 * a new batch that names the old one.
 */
export function BatchHistory({
  history,
  labels,
  currentStateId,
  reviewing,
  onReviewRetry,
  now,
}: {
  history: BatchHistoryRead;
  labels: PoolLabels;
  /** The state the venue's latest observation is at, where it has one. */
  currentStateId: string | null;
  /** The attempt whose retry the workspace is previewing now. */
  reviewing: string | null;
  onReviewRetry: (batch: Settlement) => void;
  now: number;
}) {
  const titleId = useId();
  const { page, filter, setFilter } = history;
  const filtered = filter.type !== null || filter.status !== null;

  return (
    <Card>
      <CardHeader
        title="Batch history"
        titleId={titleId}
        actions={
          <>
            <div className="w-48">
              <SelectControl
                label="Batch queue"
                hideLabel
                value={filter.type ?? ANY}
                onValueChange={(value) =>
                  setFilter({ ...filter, type: value === ANY ? null : (value as RequestType) })
                }
                options={[
                  { value: ANY, label: 'All queues' },
                  ...FAMILIES.map((family) => ({ value: family.type, label: family.noun })),
                ]}
              />
            </div>
            <div className="w-40">
              <SelectControl
                label="Batch status"
                hideLabel
                value={filter.status ?? ANY}
                onValueChange={(value) =>
                  setFilter({ ...filter, status: value === ANY ? null : (value as SettlementStatus) })
                }
                options={[
                  { value: ANY, label: 'All statuses' },
                  ...STATUSES.map((status) => ({ value: status, label: settlementStatusLabels[status] })),
                ]}
              />
            </div>
          </>
        }
      />
      <AsyncSection result={page} label="Loading batches" rows={2}>
        {(current) =>
          current.items.length === 0 ? (
            <EmptyState title={filtered ? 'No batch matches' : 'No batches yet'} />
          ) : (
            <DataTable
              aria-labelledby={titleId}
              columns={[
                {
                  id: 'started',
                  header: 'Started',
                  cell: (batch) => formatDateTime(batch.createdAt),
                },
                { id: 'queue', header: 'Queue', cell: queueOf },
                { id: 'requests', header: 'Requests', cell: batchSizeLabel },
                {
                  id: 'trigger',
                  header: 'Trigger',
                  cell: (batch) => (batch.trigger === 'MANUAL' ? 'Operator' : 'Automatic'),
                },
                {
                  id: 'status',
                  header: 'Status',
                  cell: (batch) => (
                    <div className="flex flex-col items-start gap-1">
                      <StatusBadge
                        tone={settlementStatusTones[batch.status]}
                        dot={batch.status === 'SUBMITTING' || batch.status === 'PREPARING'}
                        label={settlementStatusLabels[batch.status]}
                      />
                      {batch.retryOf ? (
                        <span className="text-muted-foreground text-xs">
                          {RETRY_OF} <Mono>{shortContract(batch.retryOf)}</Mono>
                        </span>
                      ) : null}
                    </div>
                  ),
                },
                {
                  id: 'detail',
                  header: <span className="sr-only">Detail</span>,
                  cell: (batch) => (
                    <div className="flex items-center justify-end gap-2">
                      {RETRYABLE.has(batch.status) ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={reviewing === batch.settlementId}
                          aria-label={`Review retry of batch ${shortContract(batch.settlementId)}`}
                          onClick={() => onReviewRetry(batch)}
                        >
                          Review retry
                        </Button>
                      ) : null}
                      <DetailDialog
                        title={`Batch ${shortContract(batch.settlementId)}`}
                        label={`Details for batch ${shortContract(batch.settlementId)}`}
                      >
                        <BatchDetail
                          batch={batch}
                          labels={labels}
                          currentStateId={currentStateId}
                          now={now}
                        />
                      </DetailDialog>
                    </div>
                  ),
                },
              ]}
              rows={current.items}
              getRowKey={(batch) => batch.settlementId}
              className="border-0"
            />
          )
        }
      </AsyncSection>

      {history.olderCursor || history.canShowNewer ? (
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <Button size="sm" variant="secondary" disabled={!history.canShowNewer} onClick={history.showNewer}>
              Newer
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={history.olderCursor === undefined}
              onClick={() => history.olderCursor && history.showOlder(history.olderCursor)}
            >
              Older
            </Button>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

function BatchDetail({
  batch,
  labels,
  currentStateId,
  now,
}: {
  batch: Settlement;
  labels: PoolLabels;
  currentStateId: string | null;
  now: number;
}) {
  // Only a confirmed batch has paid anything. The venue writes its preflight
  // projection at SUBMITTING, and membership can still shrink after that, so
  // an unconfirmed fill is an estimate that may never happen.
  const confirmed = batch.status === 'CONFIRMED';
  const members = batch.requests.map((request, index) => ({
    request,
    position: index + 1,
    fill: batch.fills.find((fill) => fill.type === request.type && fill.requestId === request.requestId),
  }));

  return (
    <div className="flex flex-col gap-4">
      <DataList
        items={[
          { label: 'Batch', value: <Mono>{batch.settlementId}</Mono> },
          { label: 'Queue', value: queueOf(batch) },
          { label: 'Policy version', value: String(batch.policyVersion) },
          {
            label: 'Ledger update',
            value: batch.updateId && confirmed ? <Mono>{batch.updateId}</Mono> : 'Not confirmed',
          },
          ...(batch.retryOf ? [{ label: RETRY_OF, value: <Mono>{batch.retryOf}</Mono> }] : []),
          ...(batch.error
            ? [{ label: 'Reported problem', value: `${batch.errorCode ?? ''} ${batch.error}`.trim() }]
            : []),
        ]}
      />
      <DataTable
        caption={`Requests in batch ${shortContract(batch.settlementId)}`}
        columns={[
          {
            id: 'position',
            header: '#',
            cellClassName: 'tabular-nums text-muted-foreground',
            cell: (member) => member.position,
          },
          { id: 'type', header: 'Type', cell: (member) => requestTypeLabels[member.request.type] },
          {
            id: 'request',
            header: 'Request',
            cellClassName: 'font-mono text-xs',
            cell: (member) => shortContract(member.request.requestId),
          },
          {
            ...NUMERIC,
            id: 'out',
            header: confirmed ? 'Paid out' : 'Projected, not paid',
            cell: (member) =>
              member.fill ? (
                <FillAmounts fill={member.fill} {...labels} />
              ) : (
                <span className="text-muted-foreground">No fill</span>
              ),
          },
        ]}
        rows={members}
        getRowKey={(member) => `${member.request.type}:${member.request.requestId}`}
      />
      {confirmed && batch.before && batch.after ? (
        <ReserveChart
          settlement={batch}
          before={batch.before}
          after={batch.after}
          baseLabel={labels.baseLabel}
          quoteLabel={labels.quoteLabel}
          currentStateId={currentStateId}
          now={now}
        />
      ) : null}
    </div>
  );
}
