import { sql, type Kysely, type Selectable } from 'kysely';
import { Value } from 'typebox/value';
import { isUniqueViolation, type Database, type PoolProposalsTable, type PoolsTable } from '../platform/database.js';
import { Conflict, NotFound } from '../platform/errors.js';
import { stored } from '../platform/stored.js';
import { isoInstant } from '../platform/time.js';
import {
  pairKey,
  type CreateProposal,
  type LedgerPool,
  type PendingProposal,
  type PoolDetail,
  type Proposal,
  type ProposalStatus,
  ProposalTerms,
  Terms,
} from './model.js';
import type { PoolProgress } from './ports.js';

type Executor = Kysely<Database>;
type ProposalRow = Selectable<PoolProposalsTable> & { display_name: string };

/** A proposal whose command outcome or DVO decision is not yet recorded. */
const UNDECIDED: readonly ProposalStatus[] = ['SUBMITTING', 'PENDING', 'UNRESOLVED'];
const FINAL: readonly ProposalStatus[] = ['CREATED', 'REJECTED', 'WITHDRAWN', 'FAILED'];
const REFRESH_FAILED = 'Status could not be refreshed. Retrying.';

function required<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`Stored pool settings have no ${field}`);
  return value;
}

function toProposal(row: ProposalRow): Proposal {
  return {
    proposalId: row.id,
    name: row.name,
    settings: stored('proposal settings', row.settings, (value) =>
      value === null ? null : Value.Decode(ProposalTerms, value),
    ),
    status: row.status,
    createdAt: isoInstant(row.created_at),
    updatedAt: isoInstant(row.updated_at),
    proposedBy: row.display_name,
    proposalCid: row.proposal_cid,
    factoryId: row.factory_id,
    poolId: row.pool_id,
    updateId: row.update_id,
    error: row.error,
  };
}

function toDetail(row: Selectable<PoolsTable>): PoolDetail {
  return {
    poolId: row.pool_id,
    name: row.name,
    settings: stored('pool settings', required(row.settings, 'settings'), (value) =>
      value === null ? null : Value.Decode(Terms, value),
    ),
    configId: row.config_id,
    stateId: row.state_id,
    packageId: row.package_id,
    createdAt: row.created_at === null ? null : isoInstant(row.created_at),
    updatedAt: isoInstant(row.updated_at),
  };
}

/**
 * Pool proposals, the pool catalog and the pair claims that allow one pool or pending proposal
 * per instrument pair. Every transition is a compare-and-set on the proposal status.
 */
export class PoolStore implements PoolProgress {
  constructor(private readonly db: Executor) {}

  async dvo(): Promise<string> {
    const row = await this.db
      .selectFrom('fixture_parties')
      .select('party_id')
      .where('name', '=', 'dvo')
      .executeTakeFirstOrThrow();
    return row.party_id;
  }

  private proposalQuery(db: Executor) {
    return db
      .selectFrom('pool_proposals as p')
      .innerJoin('accounts as a', 'a.id', 'p.proposed_by')
      .selectAll('p')
      .select('a.display_name');
  }

  async get(id: string, db: Executor = this.db): Promise<Proposal> {
    const row = await this.proposalQuery(db).where('p.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFound();
    return toProposal(row);
  }

  async proposals(): Promise<Proposal[]> {
    const rows = await this.proposalQuery(this.db).orderBy('p.created_at', 'desc').orderBy('p.id').execute();
    return rows.map(toProposal);
  }

  async pending(): Promise<PendingProposal[]> {
    const rows = await this.proposalQuery(this.db).where('p.status', 'in', UNDECIDED).orderBy('p.created_at').execute();
    return rows.map((row) => ({ proposal: toProposal(row), commandId: row.command_id, beginOffset: row.begin_offset }));
  }

  /** Records the proposal and claims its pair in one transaction; the proposal id is its command id. */
  async reserve(
    id: string,
    input: CreateProposal,
    settings: ProposalTerms,
    factoryId: string,
    accountId: string,
    offset: bigint,
  ): Promise<Proposal> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('pool_proposals')
          .values({
            id,
            name: input.name,
            settings: JSON.stringify(settings),
            factory_id: factoryId,
            proposed_by: accountId,
            status: 'SUBMITTING',
            command_id: id,
            begin_offset: offset,
          })
          .execute();
        await trx
          .insertInto('pool_pair_claims')
          .values({ pair_key: pairKey(settings.baseInstrumentId, settings.quoteInstrumentId), proposal_id: id })
          .execute();
        return this.get(id, trx);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new Conflict('A pool or pending proposal already exists for this pair');
      throw error;
    }
  }

  async proposed(id: string, proposalCid: string, updateId: string): Promise<void> {
    await this.db
      .updateTable('pool_proposals')
      .set({ proposal_cid: proposalCid, update_id: updateId, status: 'PENDING', error: null, updated_at: sql`now()` })
      .where('id', '=', id)
      .where('proposal_cid', 'is', null)
      .where('status', 'in', ['SUBMITTING', 'UNRESOLVED'])
      .execute();
  }

  async unresolved(id: string): Promise<void> {
    await this.db
      .updateTable('pool_proposals')
      .set({ status: 'UNRESOLVED', error: 'Confirmation pending', updated_at: sql`now()` })
      .where('id', '=', id)
      .where('status', '=', 'SUBMITTING')
      .execute();
  }

  /** A rejected proposal fails and releases its pair; a rejected withdrawal stays pending. */
  async failedSubmission(id: string, withdrawal: boolean): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable('pool_proposals')
        .set({
          status: withdrawal ? 'PENDING' : 'FAILED',
          error: withdrawal
            ? 'Withdrawal was rejected. Try again.'
            : 'Canton rejected the proposal. Create a new proposal.',
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .where('status', '=', 'SUBMITTING')
        .executeTakeFirst();
      if (result.numUpdatedRows === 1n && !withdrawal) {
        await trx.deleteFrom('pool_pair_claims').where('proposal_id', '=', id).execute();
      }
    });
  }

  async reconciliationError(id: string, failed: boolean): Promise<void> {
    if (failed) {
      await this.db
        .updateTable('pool_proposals')
        .set({ error: REFRESH_FAILED })
        .where('id', '=', id)
        .where('status', 'in', UNDECIDED)
        .where(sql<boolean>`error IS DISTINCT FROM ${REFRESH_FAILED}`)
        .execute();
    } else {
      await this.db
        .updateTable('pool_proposals')
        .set({ error: null })
        .where('id', '=', id)
        .where('error', '=', REFRESH_FAILED)
        .execute();
    }
  }

  /** Records a decision once; a created pool keeps the pair, any other outcome releases it. */
  async finish(id: string, status: ProposalStatus, updateId: string, pool: LedgerPool | null): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('pool_proposals')
        .select('status')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (FINAL.includes(current.status)) return;
      if (pool) {
        await this.save(pool, trx);
        await trx
          .updateTable('pools')
          .set({ name: pool.name, created_at: sql`COALESCE(created_at, ${pool.createdAt}::timestamptz)` })
          .where('pool_id', '=', pool.poolId)
          .execute();
      }
      await trx
        .updateTable('pool_proposals')
        .set({ status, pool_id: pool?.poolId ?? null, update_id: updateId, error: null, updated_at: sql`now()` })
        .where('id', '=', id)
        .execute();
      if (pool) {
        await trx.updateTable('pool_pair_claims').set({ pool_id: pool.poolId }).where('proposal_id', '=', id).execute();
      } else {
        await trx.deleteFrom('pool_pair_claims').where('proposal_id', '=', id).execute();
      }
    });
  }

  async claimWithdrawal(id: string, commandId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('pool_proposals')
      .set({ status: 'SUBMITTING', command_id: commandId, error: null, updated_at: sql`now()` })
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  /** Upserts a ledger pool; a stored name and creation time are kept. */
  async save(pool: LedgerPool, db: Executor = this.db): Promise<void> {
    await db
      .insertInto('pools')
      .values({
        pool_id: pool.poolId,
        config_id: pool.configId,
        state_id: pool.stateId,
        package_id: pool.packageId,
        name: pool.name,
        active: true,
        settings: JSON.stringify(pool.settings),
        created_at: pool.createdAt,
        updated_at: sql`now()`,
      })
      .onConflict((conflict) =>
        conflict.column('pool_id').doUpdateSet((excluded) => ({
          config_id: excluded.ref('excluded.config_id'),
          state_id: excluded.ref('excluded.state_id'),
          settings: excluded.ref('excluded.settings'),
          active: true,
          created_at: sql`COALESCE(pools.created_at, excluded.created_at)`,
          updated_at: excluded.ref('excluded.updated_at'),
        })),
      )
      .execute();
    await db
      .insertInto('pool_pair_claims')
      .values({
        pair_key: pairKey(pool.settings.baseInstrumentId, pool.settings.quoteInstrumentId),
        pool_id: pool.poolId,
      })
      .onConflict((conflict) => conflict.column('pair_key').doNothing())
      .execute();
  }

  async names(): Promise<Map<string, string>> {
    const rows = await this.db.selectFrom('pools').select(['pool_id', 'name']).execute();
    return new Map(rows.map((row) => [row.pool_id, row.name]));
  }

  async pools(packageId: string): Promise<PoolDetail[]> {
    const rows = await this.db
      .selectFrom('pools')
      .selectAll()
      .where('active', '=', true)
      .where('package_id', '=', packageId)
      .where('settings', 'is not', null)
      .orderBy('name')
      .orderBy('pool_id')
      .execute();
    return rows.map(toDetail);
  }

  async pool(id: string, packageId: string): Promise<PoolDetail> {
    const row = await this.db
      .selectFrom('pools')
      .selectAll()
      .where('pool_id', '=', id)
      .where('package_id', '=', packageId)
      .where('active', '=', true)
      .where('settings', 'is not', null)
      .executeTakeFirst();
    if (!row) throw new NotFound();
    return toDetail(row);
  }
}
