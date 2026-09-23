import { useCallback, useEffect, useRef, useState } from 'react';
import { useDexClient, useSession } from '../../app/runtime';
import { useAction, useAsync } from '../../app/useAsync';
import {
  errorCode,
  venueErrorCode,
  type Settlement,
  type SettlementSelection,
} from '../../lib/api/types';
import {
  outstandingRunIntent,
  recordRunIntent,
  resolveRunIntent,
  type RunIntent,
} from '../../lib/runKey';

/**
 * The refusals that prove a run made nothing under its key. The venue raises
 * each one only after it looks the key up and finds no batch.
 */
const FINAL_REFUSALS: ReadonlySet<string> = new Set([
  'POOL_NOT_READY',
  'POOL_CHANGED',
  'POLICY_CHANGED',
  'QUEUE_CHANGED',
  'BATCH_IN_FLIGHT',
  'POLICY_LIMIT_EXCEEDED',
  'RETRY_NOT_ALLOWED',
  'QUEUE_NOT_READY',
]);

/**
 * Whether the venue answered a run and made nothing for its key, which only a
 * final refusal shows.
 *
 * A failed connection or a 5xx can come after the batch exists. A role,
 * validation or missing-resource refusal can come before the key lookup, so it
 * says nothing about an earlier send whose reply was lost. An idempotency
 * conflict means the key already made a batch.
 */
function refused(error: unknown): boolean {
  const code = venueErrorCode(error);
  return code !== undefined && FINAL_REFUSALS.has(code);
}

export interface RunIntentState {
  /** The run with no answer yet, and the exact selection it was sent with. */
  intent: RunIntent | undefined;
  /** The batch the last answered run made, in the newest state any read has shown. */
  answered: Settlement | undefined;
  pending: boolean;
  error: Error | undefined;
  /** True once a lookup found no batch under the unanswered key. */
  unseen: boolean;
  run: (selection: SettlementSelection) => void;
  retry: () => void;
}

/**
 * This operator's manual runs on one pool, safe to repeat.
 *
 * Every run is stored as its key and its selection before it is sent. A reply
 * that never arrives leaves both stored, a reload finds them, and a retry
 * sends both again unchanged. A batch under the key, or a final refusal, is
 * what clears them; until then no new run starts on this pool.
 */
export function useRunIntent(
  poolId: string,
  /**
   * The batches the screen already reads, which is where a late batch shows up
   * first, and where an answered one moves on.
   */
  recent: readonly Settlement[] | undefined,
  /** Called once a run is cleared, with the batch where it made one. */
  onAnswered: (batch: Settlement | undefined) => void,
): RunIntentState {
  const client = useDexClient();
  // An outstanding run belongs to the operator who started it, not to whoever
  // is looking at this pool now.
  const accountId = useSession().current?.accountId ?? 'anonymous';
  const [intent, setIntent] = useState(() => outstandingRunIntent(accountId, poolId));
  const [answered, setAnswered] = useState<Settlement>();
  const notify = useRef(onAnswered);
  notify.current = onAnswered;
  // Set before the first await, so a second press in the same instant sends nothing.
  const sending = useRef(false);

  const settle = useCallback(
    (spent: RunIntent, batch: Settlement | undefined) => {
      resolveRunIntent(accountId, poolId, spent.idempotencyKey);
      setIntent((current) => (current?.idempotencyKey === spent.idempotencyKey ? undefined : current));
      if (batch) setAnswered(batch);
      notify.current(batch);
    },
    [accountId, poolId],
  );

  const send = useAction(async (claim: () => RunIntent) => {
    sending.current = true;
    try {
      const next = claim();
      setIntent(next);
      try {
        const batch = await client.admin.settlements.run(poolId, next);
        // A reply for another pool cannot be this pool's answer.
        if (batch.poolId === poolId) settle(next, batch);
        return batch;
      } catch (cause) {
        if (refused(cause)) settle(next, undefined);
        throw cause;
      }
    } finally {
      sending.current = false;
    }
  });

  // What the unanswered key made, read rather than assumed. A batch under it
  // is the answer; none yet leaves the intent for a retry.
  const lookup = useAsync(
    (signal) => client.admin.settlements.get(intent!.idempotencyKey, { signal }),
    [client, intent?.idempotencyKey],
    { enabled: intent !== undefined && !send.pending },
  );
  const found =
    lookup.data ?? recent?.find((batch) => batch.settlementId === intent?.idempotencyKey);
  useEffect(() => {
    if (intent && !sending.current && found?.settlementId === intent.idempotencyKey && found.poolId === poolId) {
      settle(intent, found);
    }
  }, [intent, found, poolId, settle]);

  // The recent list is bounded, so the answered batch can leave it. Its newest
  // state stays, and an older read never replaces a newer one.
  const seen =
    answered && recent?.find((batch) => batch.poolId === poolId && batch.settlementId === answered.settlementId);
  useEffect(() => {
    if (!seen) return;
    setAnswered((current) =>
      current?.settlementId === seen.settlementId && Date.parse(seen.updatedAt) > Date.parse(current.updatedAt)
        ? seen
        : current,
    );
  }, [seen]);

  return {
    intent,
    answered,
    pending: send.pending,
    error: send.error,
    unseen: errorCode(lookup.error) === 'NOT_FOUND',
    run: (selection) => {
      if (intent || sending.current) return;
      void send.perform(() => recordRunIntent(accountId, poolId, selection));
    },
    retry: () => {
      if (intent && !sending.current) void send.perform(() => intent);
    },
  };
}
