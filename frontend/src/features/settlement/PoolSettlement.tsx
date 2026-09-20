import { useDexClient } from '../../app/runtime';
import { useAsync } from '../../app/useAsync';
import { useNow } from '../../app/useNow';
import type { PoolDetail } from '../../lib/api/types';
import { RefreshFailure } from '../../ui/States';
import { BatchHistory } from './BatchHistory';
import { PolicyControls } from './PolicyControls';
import { PoolState } from './PoolState';
import { QueueTable } from './QueueTable';

/**
 * This pool's work arrives from elsewhere: traders sign requests and the
 * venue's worker settles batches. An idle pool is exactly when something new
 * appears, so these reads never stop while an operator is watching. The
 * reading hook bounds them, pausing on a hidden tab and backing off on
 * failure.
 */
const WATCH = () => true;

/**
 * Everything one pool's settlement is made of. The parent keys it on the pool,
 * so one pool's answer can never land under another's name.
 */
export function PoolSettlement({ pool }: { pool: PoolDetail }) {
  const client = useDexClient();
  const poolId = pool.poolId;

  const policy = useAsync(
    (signal) => client.admin.settlements.policy(poolId, { signal }),
    [client, poolId],
  );
  const monitoring = useAsync(
    (signal) => client.admin.settlements.monitoring(poolId, { signal }),
    [client, poolId],
    { pollWhile: WATCH },
  );
  const queue = useAsync(
    // The route defaults to the ready requests alone; an operator needs the
    // blocked and in-flight ones too, or the queue reads as shorter than it is.
    (signal) => client.admin.settlements.requests(poolId, 'active', { signal }),
    [client, poolId],
    { pollWhile: WATCH },
  );
  const batches = useAsync(
    (signal) => client.admin.settlements.list(poolId, { signal }),
    [client, poolId],
    { pollWhile: WATCH },
  );

  const now = useNow(true);

  function reload() {
    monitoring.reload();
    queue.reload();
    batches.reload();
  }

  return (
    <>
      <PolicyControls
        poolId={poolId}
        policy={policy}
        monitoring={monitoring.data}
        onChanged={reload}
      />

      {monitoring.error && monitoring.data !== undefined ? (
        <RefreshFailure error={monitoring.error} onRetry={monitoring.reload} />
      ) : null}

      <QueueTable queue={queue} monitoring={monitoring.data} now={now} />

      <PoolState
        pool={pool}
        monitoring={monitoring.data}
        lastConfirmed={batches.data?.find((batch) => batch.status === 'CONFIRMED')}
        now={now}
      />

      <BatchHistory
        batches={batches}
        baseLabel={pool.settings.baseInstrumentId.id}
        quoteLabel={pool.settings.quoteInstrumentId.id}
      />
    </>
  );
}
