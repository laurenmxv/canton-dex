import type { FastifyBaseLogger } from 'fastify';
import type { CommandJournal, PreparedCommand } from '../operations/commands.js';
import { jsonText } from '../platform/json.js';
import { parseStoredCommands, type Ledger, type StoredCommands, type Transaction } from './ledger.js';

/** A durable preparation failure excludes every attempt, including concurrent replays. */
export class PreparationFailed extends Error {}

const NOT_PREPARED = 'The operator command could not be prepared; no transaction was sent';

/**
 * Persists an operator command, or its construction failure, before any submission. Every retry
 * sends the stored command with its original deduplication offset.
 */
export class OperatorCommands {
  constructor(
    private readonly ledger: Pick<Ledger, 'submitStored'>,
    private readonly store: CommandJournal,
    private readonly log: Pick<FastifyBaseLogger, 'warn'>,
  ) {}

  async submit(id: string, kind: string, build: () => Promise<StoredCommands>): Promise<Transaction> {
    const prepared =
      (await this.store.find(id, kind)) ?? (await this.store.storeOnce(id, kind, await this.prepare(id, build)));
    if ('error' in prepared) throw new PreparationFailed(prepared.error);
    return this.ledger.submitStored(parseStoredCommands(prepared.payload));
  }

  private async prepare(id: string, build: () => Promise<StoredCommands>): Promise<PreparedCommand> {
    try {
      const command = await build();
      if (command.commandId !== id) throw new Error('Operator command identity differs from its durable request');
      return { payload: jsonText(command) };
    } catch (error) {
      this.log.warn({ err: error, command: id }, 'Operator command could not be prepared');
      return { error: NOT_PREPARED };
    }
  }
}
