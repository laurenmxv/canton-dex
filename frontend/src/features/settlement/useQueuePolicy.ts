import { useRef, useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAsync, type AsyncResult } from '../../app/useAsync';
import type { SettlementPolicy, UpdateSettlementPolicy } from '../../lib/api/types';
import { FAMILIES, policyOf, type Family } from './queueRows';

interface QueueState {
  pending: boolean;
  error?: Error;
  confirmed?: SettlementPolicy;
}

export interface QueuePolicy {
  /** Every queue's newest confirmed settings. */
  policies: readonly SettlementPolicy[];
  /** The newest confirmed settings of the queue on screen, with the state of this screen's own read. */
  current: AsyncResult<SettlementPolicy>;
  /** A save of the queue on screen is waiting for its answer. */
  saving: boolean;
  /** Why the venue refused the last save of the queue on screen. */
  error: Error | undefined;
  save: (input: UpdateSettlementPolicy) => void;
  /** Clears the refusal and reads the queue again, as after a conflict. */
  reread: () => void;
}

/**
 * The newest settings the venue confirmed for one queue of one pool. A
 * queue's version only rises, so the highest version is the current one.
 */
function newest(
  confirmed: readonly (SettlementPolicy | undefined)[],
  poolId: string,
  type: Family,
): SettlementPolicy | undefined {
  let best: SettlementPolicy | undefined;
  for (const policy of confirmed) {
    if (policy?.poolId !== poolId || policy.type !== type) continue;
    if (best === undefined || policy.version > best.version) best = policy;
  }
  return best;
}

/**
 * Every queue's settings in one pool, and the saves made to them.
 *
 * Keep confirmed reads and saves across queue switches. The newest policy
 * governs both the settings display and preview validation, even when
 * monitoring is behind. Pending saves and errors belong to their own queue.
 */
export function useQueuePolicy(
  poolId: string,
  family: Family,
  /** Monitoring's latest observation of every queue's settings. */
  observed: readonly SettlementPolicy[] | undefined,
  onSaved: () => void,
): QueuePolicy {
  const client = useDexClient();
  const [queues, setQueues] = useState<Partial<Record<Family, QueueState>>>({});
  const notify = useRef(onSaved);
  notify.current = onSaved;

  function update(queue: Family, next: Partial<QueueState>) {
    setQueues((all) => ({
      ...all,
      [queue]: {
        pending: false,
        ...all[queue],
        ...next,
        confirmed: newest([all[queue]?.confirmed, next.confirmed], poolId, queue),
      },
    }));
  }

  const read = useAsync(
    async (signal) => {
      const confirmed = await client.admin.settlements.policy(poolId, family, { signal });
      if (!signal.aborted) update(family, { confirmed });
      return confirmed;
    },
    [client, poolId, family],
  );

  async function save(input: UpdateSettlementPolicy) {
    const queue = family;
    update(queue, { pending: true, error: undefined });
    try {
      const confirmed = await client.admin.settlements.updatePolicy(poolId, queue, input);
      update(queue, { pending: false, confirmed });
      notify.current();
    } catch (cause) {
      update(queue, { pending: false, error: cause instanceof Error ? cause : new Error(String(cause)) });
    }
  }

  const policies = FAMILIES.map(({ type }) =>
    newest([policyOf(observed, type), queues[type]?.confirmed], poolId, type),
  ).filter((policy) => policy !== undefined);
  const slot = queues[family];
  return {
    policies,
    current: { ...read, data: policyOf(policies, family) },
    saving: slot?.pending ?? false,
    error: slot?.error,
    save: (input) => void save(input),
    reread: () => {
      update(family, { error: undefined });
      read.reload();
    },
  };
}
