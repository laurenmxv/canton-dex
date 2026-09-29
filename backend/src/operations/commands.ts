/**
 * Persists operator commands and coordinates SQL request queues.
 *
 * @remarks
 * The journal stores immutable submissions in PostgreSQL before dispatch. Queue helpers
 * lock and order trader request admission and status updates. SettlementStore takes the
 * shared pool lock itself and uses sequence helpers to return deferred requests to the queue tail.
 *
 * @packageDocumentation
 */
import type { Db } from '../platform/database.js';

/** The immutable outcome of building an operator command: its payload, or proof it can never be sent. */
export type PreparedCommand = { readonly payload: string } | { readonly error: string };

/** The durable journal of operator commands. */
export interface CommandJournal {
  storeOnce(id: string, kind: string, prepared: PreparedCommand): Promise<PreparedCommand>;
  find(id: string, kind: string): Promise<PreparedCommand | undefined>;
}

/** Durable operator commands, recorded before any worker may submit them. */
export class OperatorCommandStore implements CommandJournal {
  constructor(private readonly db: Db) {}

  /** Concurrent builders share the first stored outcome, including a preparation failure. */
  async storeOnce(id: string, kind: string, prepared: PreparedCommand): Promise<PreparedCommand> {
    await this.db
      .insertInto('operator_commands')
      .values({
        id,
        kind,
        payload: 'payload' in prepared ? prepared.payload : null,
        error: 'error' in prepared ? prepared.error : null,
      })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
    const stored = await this.find(id, kind);
    if (!stored) throw new Error('Stored operator command is missing');
    return stored;
  }

  async find(id: string, kind: string): Promise<PreparedCommand | undefined> {
    const row = await this.db
      .selectFrom('operator_commands')
      .select(['kind', 'payload', 'error'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return undefined;
    if (row.kind !== kind) throw new Error('Operator command id belongs to another operation kind');
    if (row.payload !== null) return { payload: row.payload };
    if (row.error !== null) return { error: row.error };
    throw new Error('Stored operator command has neither a payload nor an error');
  }
}
