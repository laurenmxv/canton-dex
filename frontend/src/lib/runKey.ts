/**
 * The key identifying one operator's outstanding manual batch.
 *
 * A `POST` that commits and loses its reply leaves an outcome nobody knows.
 * Repeating it with the same key resolves that: the venue answers with the
 * batch it already made instead of settling the next requests in the queue.
 * The key therefore has to outlive the form, the pool selection and the page,
 * which is why it is kept in browser storage rather than in a component.
 *
 * It is not policy. A key says only which run is unanswered; the venue remains
 * the authority on what that run did.
 */

const PREFIX = 'dex.settlement-run';

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

/** True only once the key can be read back, which is the guarantee that matters. */
function writeStored(name: string, key: string): boolean {
  try {
    window.localStorage?.setItem(name, key);
    return window.localStorage?.getItem(name) === key;
  } catch {
    return false;
  }
}

/**
 * The key to run with: the one still outstanding, or a new one.
 *
 * A new key is handed out only once it is stored, because a run dispatched
 * under a key a reload could not find would be retried as a second batch.
 */
export function claimRunKey(accountId: string, poolId: string): string {
  const name = nameFor(accountId, poolId);
  const outstanding = readStored(name);
  if (outstanding !== undefined) return outstanding;

  const fresh = crypto.randomUUID();
  if (!writeStored(name, fresh)) throw new RunKeyUnavailable();
  return fresh;
}

/** Whether a run is outstanding, which is what makes the next press a retry. */
export function outstandingRunKey(accountId: string, poolId: string): string | undefined {
  return readStored(nameFor(accountId, poolId));
}

/** Called once the venue has answered for that key, whatever it answered. */
export function resolveRunKey(accountId: string, poolId: string): void {
  try {
    window.localStorage?.removeItem(nameFor(accountId, poolId));
  } catch {
    // Nothing more to do: the next claim reads whatever is still there.
  }
}
