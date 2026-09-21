import { useId } from 'react';
import { useAsync } from '../../app/useAsync';
import type { DemoApi } from '../../lib/api/demo';
import type { Instrument, Pool, SwapRequest } from '../../lib/api/types';
import { formatAmount, formatDateTime, inputSymbolOf } from '../../lib/labels';
import { DataTable, type DataTableColumn } from '@openzeppelin/ui-components';
import { NUMERIC } from '../../ui/table';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { AsyncSection, EmptyState } from '../../ui/States';

/**
 * Swap requests, which only the demo has. The venue serves no swap route, so
 * this card is never rendered against real data.
 */
export function SwapRequestsCard({ demo }: { demo: DemoApi }) {
  const swapRequestsTitle = useId();
  const requests = useAsync(() => demo.swaps.listRequests(), [demo]);
  const pools = useAsync(() => demo.pools.list(), [demo]);
  const instruments = useAsync(() => demo.pools.listInstruments(), [demo]);

  return (
    <Card>
      <CardHeader title="Your swap requests" titleId={swapRequestsTitle} />
      <AsyncSection
        result={requests}
        label="Loading your requests"
        rows={2}
        empty={
          <EmptyState
            title="No requests yet"
          />
        }
      >
        {(list) => (
          <RequestTable
            requests={list}
            pools={pools.data ?? []}
            instruments={instruments.data ?? []}
            titleId={swapRequestsTitle}
          />
        )}
      </AsyncSection>
    </Card>
  );
}

function RequestTable({
  requests,
  pools,
  instruments,
  titleId,
}: {
  requests: SwapRequest[];
  pools: Pool[];
  instruments: Instrument[];
  titleId: string;
}) {
  const columns: DataTableColumn<SwapRequest>[] = [
    { id: 'pair', header: 'Pair', cell: (request) => request.poolName },
    {
      ...NUMERIC,
      id: 'amount',
      header: 'Amount in',
      cell: (request) => {
        const symbol = inputSymbolOf(request, pools, instruments);
        return `${formatAmount(request.amountIn)}${symbol ? ` ${symbol}` : ''}`;
      },
    },
    {
      id: 'submitted',
      header: 'Submitted',
      cellClassName: 'text-muted-foreground',
      cell: (request) => formatDateTime(request.submittedAt),
    },
    {
      id: 'status',
      header: 'Status',
      cell: () => <StatusBadge tone="progress" dot label="Awaiting settlement" />,
    },
  ];

  return (
    <DataTable
      aria-labelledby={titleId}
      columns={columns}
      rows={requests}
      getRowKey={(request) => request.requestId}
      className="border-0"
    />
  );
}
