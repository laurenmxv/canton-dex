import { useAsync } from '../../app/useAsync';
import type { DemoApi } from '../../lib/api/demo';
import type { Instrument, Pool, SwapRequest } from '../../lib/api/types';
import { formatAmount, formatDateTime, inputSymbolOf } from '../../lib/labels';
import { Badge } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { AsyncSection, EmptyState } from '../../ui/States';

/**
 * Swap requests, which only the demo has. The venue serves no swap route, so
 * this card is never rendered against real data.
 */
export function SwapRequestsCard({ demo }: { demo: DemoApi }) {
  const requests = useAsync(() => demo.swaps.listRequests(), [demo]);
  const pools = useAsync(() => demo.pools.list(), [demo]);
  const instruments = useAsync(() => demo.pools.listInstruments(), [demo]);

  return (
    <Card>
      <CardHeader
        title="Your swap requests"
      />
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
}: {
  requests: SwapRequest[];
  pools: Pool[];
  instruments: Instrument[];
}) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Pair</th>
          <th className="table-num">Amount in</th>
          <th>Submitted</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {requests.map((request) => {
          const symbol = inputSymbolOf(request, pools, instruments);
          return (
            <tr key={request.requestId}>
              <td>{request.poolName}</td>
              <td className="table-num">
                {formatAmount(request.amountIn)}
                {symbol ? ` ${symbol}` : ''}
              </td>
              <td className="muted">{formatDateTime(request.submittedAt)}</td>
              <td>
                <Badge tone="progress" dot>
                  Awaiting settlement
                </Badge>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
