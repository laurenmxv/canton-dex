import type { RunSettlementInput, SettlementSelection } from './api/types';

/**
 * One operator's outstanding manual batch on one pool: the idempotency key it
 * was sent with, and the exact selection it asked for.
 *
 * A `POST` that commits and loses its reply leaves an outcome nobody knows.
 * Repeating it with the same key resolves that: the venue answers with the
 * batch it already made instead of settling the next requests in the queue.
 * The venue also holds the key to the selection it first came with, so the two
 * are kept and sent together: the same key with a newer preview would be a
 * different request. They have to outlive the pool selection and the page,
 * which is why they are kept in browser storage rather than in a component.
 *
 * It is not policy. An intent says only which run is unanswered; the venue
 * remains the authority on what that run did.
 */

const PREFIX = 'dex.settlement-intent';

/** What a manual run sends, and what its retry must send again unchanged. */
export type RunIntent = Required<RunSettlementInput>;

/** Thrown when a new run could not be made recoverable across a reload. */
export class RunKeyUnavailable extends Error {
  constructor() {
    super(
      'This browser will not store the key that identifies a manual batch. Without it a reload ' +
        'could not tell a retry from a second batch, so nothing was sent. Allow site storage, ' +
        'then try again.',
    );
    this.name = 'RunKeyUnavailable';
  }
}

/** One operator's outstanding run on one pool, and nobody else's. */
function nameFor(accountId: string, poolId: string): string {
  return `${PREFIX}.${accountId}.${poolId}`;
}

function readStored(name: string): string | undefined {
  try {
    return window.localStorage?.getItem(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** True only once the value can be read back, which is the guarantee that matters. */
function writeStored(name: string, value: string): boolean {
  try {
    window.localStorage?.setItem(name, value);
    return window.localStorage?.getItem(name) === value;
  } catch {
    return false;
  }
}

/** The run still waiting for an answer, where one is stored and readable. */
export function outstandingRunIntent(accountId: string, poolId: string): RunIntent | undefined {
  const stored = readStored(nameFor(accountId, poolId));
  if (stored === undefined) return undefined;
  try {
    const intent = JSON.parse(stored) as Partial<RunIntent> | null;
    return typeof intent?.idempotencyKey === 'string' && intent.selection
      ? { idempotencyKey: intent.idempotencyKey, selection: intent.selection }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A new intent for `selection`, under a fresh key.
 *
 * It is handed out only once it is stored, because a run dispatched under a
 * key a reload could not find would be retried as a second batch. It never
 * replaces an unanswered one, whose key would then be lost.
 */
export function recordRunIntent(
  accountId: string,
  poolId: string,
  selection: SettlementSelection,
): RunIntent {
  if (outstandingRunIntent(accountId, poolId)) {
    throw new Error('The last manual run on this pool has no answer yet. Retry it first.');
  }
  const intent: RunIntent = { idempotencyKey: crypto.randomUUID(), selection };
  if (!writeStored(nameFor(accountId, poolId), JSON.stringify(intent))) throw new RunKeyUnavailable();
  return intent;
}

/**
 * Called once the venue has answered for that key, whatever it answered. An
 * intent stored under another key since then stays.
 */
export function resolveRunIntent(accountId: string, poolId: string, idempotencyKey: string): void {
  if (outstandingRunIntent(accountId, poolId)?.idempotencyKey !== idempotencyKey) return;
  try {
    window.localStorage?.removeItem(nameFor(accountId, poolId));
  } catch {
    // Nothing more to do: the next read finds whatever is still there.
  }
}
