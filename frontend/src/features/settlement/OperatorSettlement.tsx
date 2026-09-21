import { useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAsync } from '../../app/useAsync';
import { Card } from '../../ui/Card';
import { SelectControl } from '../../ui/Field';
import { EmptyState, ErrorState, Loading, RefreshFailure } from '../../ui/States';
import { PageHeader } from '../../ui/PageHeader';
import { PoolSettlement } from './PoolSettlement';

/**
 * One pool's settlement, and nothing else.
 *
 * The chosen pool is the scope of every read and every command below it: its
 * settings, its queue, its state and its batches. Nothing is shared between
 * pools, and nothing is remembered outside the venue's own database.
 */
export function OperatorSettlement() {
  const client = useDexClient();
  const [chosen, setChosen] = useState('');

  const pools = useAsync((signal) => client.admin.listPools({ signal }), [client]);
  const available = pools.data ?? [];
  // A catalogue that no longer holds the chosen pool must not leave the
  // selection, or the reads under it, pointing at nothing.
  const pool = available.find((candidate) => candidate.poolId === chosen) ?? available[0];

  if (pools.loading && pools.data === undefined) return <Loading label="Loading pools" />;
  if (pools.error && pools.data === undefined) {
    return <ErrorState error={pools.error} onRetry={pools.reload} />;
  }

  return (
    <div className="flex flex-col gap-6 fade-in">
      <PageHeader
        title="Settlement"
        description="One pool at a time: its queue, its state, and the batches it has run."
      />

      {pools.error ? <RefreshFailure error={pools.error} onRetry={pools.reload} /> : null}

      {pool ? (
        <>
          <Card padded>
            <SelectControl
              label="Pool"
              value={pool.poolId}
              onValueChange={setChosen}
              options={available.map((candidate) => ({
                value: candidate.poolId,
                label: candidate.name,
              }))}
            />
          </Card>

          {/* Keyed on the pool, so one pool's settings and queue can never be
              on screen under another pool's name. */}
          <PoolSettlement key={pool.poolId} pool={pool} />
        </>
      ) : (
        <Card>
          <EmptyState title="No pools yet" />
        </Card>
      )}
    </div>
  );
}
