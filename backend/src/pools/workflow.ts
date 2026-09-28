import { randomUUID } from 'node:crypto';
import { Mutex } from 'async-mutex';
import type { FastifyBaseLogger } from 'fastify';
import { requireRole, type Account } from '../iam/accounts.js';
import { Conflict, Unavailable } from '../platform/errors.js';
import type { InstrumentCatalog } from '../tokens/model.js';
import {
  proposalTerms,
  type CreateProposal,
  type Options,
  type PoolDetail,
  type Proposal,
  type ProposalTerms,
} from './model.js';
import { PoolRejected, type PoolConfirmation, type PoolLedger, type PoolProgress } from './ports.js';

/** The pool catalog is read from the ledger again once it is older than this. */
const REFRESH_INTERVAL_MS = 10_000;

/**
 * Pool proposals from the operator to the DVO, and the ledger-backed pool catalog. A lost command
 * response becomes UNRESOLVED and is reconciled from ledger history, never submitted again.
 */
export class PoolWorkflow {
  /** Serializes proposals, withdrawals, catalog refreshes and reconciliation in this process. */
  private readonly lock = new Mutex();
  private refreshedAt = 0;

  constructor(
    private readonly store: PoolProgress,
    private readonly ledger: PoolLedger,
    private readonly catalog: InstrumentCatalog,
    private readonly log: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  ) {}

  /** What a proposal may be built from: the venue's factory, DVO and registered instruments. */
  async options(): Promise<Options> {
    try {
      const dvo = await this.store.dvo();
      return {
        factoryId: await this.ledger.factory(dvo),
        dvo,
        venueOperator: await this.ledger.operator(),
        instruments: await this.catalog.instruments(),
      };
    } catch (error) {
      this.log.warn({ err: error }, 'Pool settings could not be read');
      throw new Unavailable('Pool settings could not be read. Try again.');
    }
  }

  async create(input: CreateProposal, caller: Account): Promise<Proposal> {
    return this.lock.runExclusive(async () => {
      requireRole(caller, 'OPERATOR');
      const options = await this.options();
      const settings = this.validated(input, options);
      await this.refreshPools();
      const id = randomUUID();
      const offset = await this.ledger.offset();
      const proposal = await this.store.reserve(id, input, settings, options.factoryId, caller.id, offset);
      try {
        await this.apply(id, await this.ledger.propose(proposal, id));
      } catch (error) {
        await this.submissionFailed(id, false, error);
      }
      return this.store.get(id);
    });
  }

  async withdraw(id: string, caller: Account): Promise<Proposal> {
    return this.lock.runExclusive(async () => {
      requireRole(caller, 'OPERATOR');
      const proposal = await this.store.get(id);
      if (proposal.status === 'WITHDRAWN') return proposal;
      const commandId = randomUUID();
      if (!(await this.store.claimWithdrawal(id, commandId))) {
        throw new Conflict('Only a pending proposal can be withdrawn');
      }
      try {
        await this.apply(id, await this.ledger.withdraw(proposal, commandId));
      } catch (error) {
        await this.submissionFailed(id, true, error);
      }
      return this.store.get(id);
    });
  }

  async pools(): Promise<readonly PoolDetail[]> {
    return this.lock.runExclusive(async () => {
      await this.refreshIfStale();
      return this.store.pools(this.ledger.packageId);
    });
  }

  async pool(id: string): Promise<PoolDetail> {
    return this.lock.runExclusive(async () => {
      await this.refreshIfStale();
      return this.store.pool(id, this.ledger.packageId);
    });
  }

  /** One reconciliation pass over the proposals whose outcome is not final. */
  async reconcile(): Promise<void> {
    await this.lock.runExclusive(async () => {
      for (const pending of await this.store.pending()) {
        const id = pending.proposal.proposalId;
        try {
          for (const result of await this.ledger.recover(pending)) await this.apply(id, result);
          await this.store.reconciliationError(id, false);
        } catch (error) {
          await this.store.reconciliationError(id, true);
          this.log.warn({ err: error, proposal: id }, 'Pool proposal reconciliation failed');
        }
      }
    });
  }

  private validated(input: CreateProposal, options: Options): ProposalTerms {
    try {
      return proposalTerms(input, options);
    } catch (error) {
      // The API answers every invalid proposal with one fixed sentence; the reason is logged.
      this.log.info({ reason: error instanceof Error ? error.message : String(error) }, 'Pool proposal refused');
      throw error;
    }
  }

  private async refreshIfStale(): Promise<void> {
    if (this.refreshedAt < Date.now() - REFRESH_INTERVAL_MS) await this.refreshPools();
  }

  private async refreshPools(): Promise<void> {
    try {
      for (const pool of await this.ledger.pools(await this.store.names(), await this.store.dvo())) {
        await this.store.save(pool);
      }
      this.refreshedAt = Date.now();
    } catch (error) {
      this.log.warn({ err: error }, 'Pool refresh failed');
      throw new Unavailable('Pools could not be refreshed. Try again.');
    }
  }

  /** A definite rejection is final for a proposal and retryable for a withdrawal. */
  private async submissionFailed(id: string, withdrawal: boolean, error: unknown): Promise<void> {
    const command = withdrawal ? 'withdrawal' : 'proposal';
    if (error instanceof PoolRejected) {
      await this.store.failedSubmission(id, withdrawal);
      this.log.warn({ err: error.cause, proposal: id }, `Pool ${command} rejected`);
    } else {
      await this.store.unresolved(id);
      this.log.warn({ err: error, proposal: id }, `Pool ${command} awaits confirmation`);
    }
  }

  private async apply(id: string, confirmation: PoolConfirmation): Promise<void> {
    if (confirmation.status === 'PENDING') {
      await this.store.proposed(id, confirmation.proposalCid, confirmation.updateId);
      return;
    }
    await this.store.finish(id, confirmation.status, confirmation.updateId, confirmation.pool);
    if (confirmation.status === 'CREATED') this.refreshedAt = 0;
  }
}
