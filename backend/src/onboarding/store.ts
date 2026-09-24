import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import { bindParty, getAccount, profile, type Account } from '../iam/accounts.js';
import type { Database, OnboardingsTable } from '../platform/database.js';
import { Conflict, InvalidRequest, NotFound } from '../platform/errors.js';
import { bool, enumeration, list, long, object, stored, text } from '../platform/request.js';
import { isoInstant } from '../platform/time.js';
import {
  ACCESS_STEP_PREFIX,
  ATTESTATION_STEP,
  DECISIONS,
  DOCUMENT_CATEGORIES,
  EXTERNAL_MODE,
  onboardingStatus,
  PartyAlreadyExists,
  suggestHint,
  validatePartyHint,
  validateReview,
  type Confirmation,
  type LedgerStep,
  type Onboarding,
  type OnboardingApplication,
  type PartyPreparation,
  type PartyStatus,
  type PoolSummary,
  type ReviewDecision,
  type StepStatus,
} from './model.js';
import type { ExternalParties, OnboardingProgress } from './ports.js';
import type { PartySubmission } from './requests.js';
import { requirePublicKey, verifyTopology } from './signatures.js';

type Executor = Kysely<Database>;
type OnboardingRow = Selectable<OnboardingsTable> & { ledger_steps: string };

const PARTY_STATUSES: readonly PartyStatus[] = ['PREPARED', 'SUBMITTING', 'CONFIRMED', 'UNRESOLVED', 'CONFLICT'];
const STEP_STATUSES: readonly StepStatus[] = ['PENDING', 'SUBMITTING', 'CONFIRMED', 'UNRESOLVED'];
const REGISTERING: readonly PartyStatus[] = ['SUBMITTING', 'UNRESOLVED'];

const LEDGER_STEPS = sql<string>`COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'key',step_key,'commandId',command_id,'status',status,'contractId',contract_id,'updateId',update_id,'issuer',issuer)
  ORDER BY CASE WHEN step_key='attestation' THEN 0 ELSE 1 END,step_key)
  FROM onboarding_steps WHERE onboarding_id=o.id),'[]'::jsonb)`;

function present<T>(value: T | null, column: string): T {
  if (value === null) throw new Error(`Stored onboarding has no ${column}`);
  return value;
}

function strings(value: unknown): string[] | null {
  return list(value, (item) => present(text(item), 'list element'));
}

function application(value: unknown): OnboardingApplication | null {
  const fields = object(value);
  if (fields === null) return null;
  return {
    legalName: present(text(fields.legalName), 'legalName'),
    countryCode: present(text(fields.countryCode), 'countryCode'),
    documentReferences: strings(fields.documentReferences) ?? [],
    documents: (list(fields.documents, object) ?? []).map((document) => {
      const item = present(document, 'document');
      return {
        id: present(text(item.id), 'document id'),
        category: present(enumeration(item.category, DOCUMENT_CATEGORIES), 'document category'),
        fileName: present(text(item.fileName), 'fileName'),
        mediaType: present(text(item.mediaType), 'mediaType'),
        sizeBytes: Number(present(long(item.sizeBytes), 'sizeBytes')),
        simulated: present(bool(item.simulated), 'simulated'),
      };
    }),
  };
}

function ledgerSteps(value: unknown): LedgerStep[] | null {
  return list(value, (item) => {
    const step = present(object(item), 'ledger step');
    return {
      key: present(text(step.key), 'step key'),
      commandId: present(text(step.commandId), 'step command'),
      status: present(enumeration(step.status, STEP_STATUSES), 'step status'),
      contractId: text(step.contractId),
      updateId: text(step.updateId),
      issuer: text(step.issuer),
    };
  });
}

function toOnboarding(row: OnboardingRow): Onboarding {
  const applicationValue = stored('application', row.application, application);
  const steps = stored('ledger steps', row.ledger_steps, ledgerSteps);
  const review =
    row.review_decision === null
      ? null
      : {
          decision: present(enumeration(row.review_decision, DECISIONS), 'review decision'),
          approvedPoolIds: stored('approved pools', row.approved_pools, strings),
          reviewedBy: present(row.reviewed_by, 'reviewed_by'),
          reviewedAt: isoInstant(present(row.reviewed_at, 'reviewed_at')),
          partyHint: row.party_hint,
        };
  const party: PartyPreparation | null =
    row.preparation_id === null
      ? null
      : {
          preparationId: row.preparation_id,
          partyId: present(row.prepared_party_id, 'prepared_party_id'),
          confirmed: row.party_confirmed_at !== null,
          publicKey: present(row.public_key, 'public_key'),
          publicKeyFingerprint: present(row.public_key_fingerprint, 'public_key_fingerprint'),
          multiHash: present(row.multi_hash, 'multi_hash'),
          synchronizerId: present(row.synchronizer_id, 'synchronizer_id'),
          status: present(enumeration(row.party_status, PARTY_STATUSES), 'party_status'),
          participantId: present(row.prepared_participant_id, 'prepared_participant_id'),
          topologyTransactions:
            row.topology_transactions === null ? [] : stored('topology', row.topology_transactions, strings),
        };
  return {
    id: row.id,
    accountId: row.account_id,
    application: applicationValue,
    status: onboardingStatus(review, party, steps),
    partyMode: row.party_mode,
    createdAt: isoInstant(row.created_at),
    review,
    party,
    ledgerSteps: steps,
    suggestedPartyHint: suggestHint(applicationValue.legalName),
  };
}

function selectOnboardings(db: Executor) {
  return db.selectFrom('onboardings as o').selectAll('o').select(LEDGER_STEPS.as('ledger_steps'));
}

function external(current: Onboarding): void {
  if (current.partyMode !== EXTERNAL_MODE) throw new Conflict('Historical participant-test requests are read-only');
}

function approved(current: Onboarding): asserts current is Onboarding & { review: NonNullable<Onboarding['review']> } {
  external(current);
  if (current.review?.decision !== 'APPROVED') {
    throw new Conflict('Approval is required before external party registration');
  }
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Onboarding requests, reviews, party registration and ledger steps, with row locks and CAS. */
export class OnboardingStore implements OnboardingProgress {
  constructor(
    private readonly db: Executor,
    private readonly parties: ExternalParties,
    private readonly packageId: string,
  ) {}

  async create(caller: Account, submitted: OnboardingApplication): Promise<Onboarding> {
    if ((await profile(this.db, caller)).partyId !== null) throw new Conflict('This account already has a party');
    const id = randomUUID();
    await this.db
      .insertInto('onboardings')
      .values({ id, account_id: caller.id, application: JSON.stringify(submitted), party_mode: EXTERNAL_MODE })
      .execute();
    return this.getOwned(id, caller);
  }

  async getOwned(id: string, caller: Account): Promise<Onboarding> {
    const row = await selectOnboardings(this.db)
      .where('o.id', '=', id)
      .where('o.account_id', '=', caller.id)
      .executeTakeFirst();
    if (!row) throw new NotFound();
    return toOnboarding(row);
  }

  async mine(caller: Account): Promise<Onboarding | null> {
    const row = await selectOnboardings(this.db).where('o.account_id', '=', caller.id).executeTakeFirst();
    return row ? toOnboarding(row) : null;
  }

  async get(id: string, db: Executor = this.db): Promise<Onboarding> {
    const row = await selectOnboardings(db).where('o.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFound();
    return toOnboarding(row);
  }

  async list(): Promise<Onboarding[]> {
    const rows = await selectOnboardings(this.db).orderBy('o.created_at').orderBy('o.id').execute();
    return rows.map(toOnboarding);
  }

  /** The active pools of the current DEX package, ordered by the database collation. */
  async pools(db: Executor = this.db): Promise<PoolSummary[]> {
    return db
      .selectFrom('pools')
      .select(['pool_id as poolId', 'name'])
      .where('package_id', '=', this.packageId)
      .where('active', '=', true)
      .orderBy('name')
      .orderBy('pool_id')
      .execute();
  }

  async review(id: string, caller: Account, decision: ReviewDecision, accessToken: string): Promise<void> {
    validateReview(decision);
    const approvedPools = [...new Set(decision.approvedPoolIds)].sort();
    // The caller-token user provisioning runs under the row lock, so two reviews of one
    // onboarding never interleave; the participant call is bounded by its timeout.
    await this.db.transaction().execute(async (trx) => {
      await this.lock(trx, id);
      const current = await this.get(id, trx);
      external(current);
      if (current.review !== null) {
        if (
          current.review.decision !== decision.decision ||
          !sameList(current.review.approvedPoolIds, approvedPools) ||
          current.review.partyHint !== decision.partyHint
        ) {
          throw new Conflict('This request already has a different review');
        }
        if (decision.decision === 'APPROVED') {
          await this.parties.enableUser(caller, accessToken, await getAccount(trx, current.accountId));
        }
        return;
      }
      const available = new Set((await this.pools(trx)).map((pool) => pool.poolId));
      if (!approvedPools.every((pool) => available.has(pool))) throw new InvalidRequest('Unknown or incompatible pool');
      if (decision.decision === 'APPROVED') {
        await this.parties.enableUser(caller, accessToken, await getAccount(trx, current.accountId));
      }
      await trx
        .updateTable('onboardings')
        .set({
          review_decision: decision.decision,
          reviewed_by: caller.id,
          reviewed_at: sql<string>`now()`,
          approved_pools: JSON.stringify(approvedPools),
          party_hint: decision.partyHint,
        })
        .where('id', '=', id)
        .execute();
    });
  }

  async prepare(id: string, caller: Account, key: string, accessToken: string): Promise<Onboarding> {
    requirePublicKey(key);
    return this.db.transaction().execute(async (trx) => {
      await this.lockOwned(trx, id, caller);
      const current = await this.get(id, trx);
      approved(current);
      if (current.party !== null) {
        if (current.party.status === 'CONFLICT') throw new PartyAlreadyExists();
        if (current.party.publicKey !== key) throw new Conflict('A different key is already prepared');
        return current;
      }
      validatePartyHint(current.review.partyHint);
      const venue = await trx
        .selectFrom('venue_configuration')
        .select(['synchronizer_id', 'participant_id'])
        .where('id', '=', 1)
        .executeTakeFirstOrThrow();
      if (venue.participant_id === null) throw new Error('The venue configuration has no participant');
      const prepared = await this.parties.prepare(
        accessToken,
        present(current.review.partyHint, 'party hint'),
        key,
        venue.synchronizer_id,
        venue.participant_id,
      );
      await trx
        .updateTable('onboardings')
        .set({
          preparation_id: randomUUID(),
          prepared_party_id: prepared.partyId,
          public_key: key,
          public_key_fingerprint: prepared.fingerprint,
          multi_hash: prepared.multiHash,
          synchronizer_id: venue.synchronizer_id,
          topology_transactions: JSON.stringify(prepared.transactions),
          prepared_participant_id: prepared.participantId,
          party_status: 'PREPARED',
        })
        .where('id', '=', id)
        .execute();
      return this.get(id, trx);
    });
  }

  async claimParty(id: string, caller: Account, submission: PartySubmission): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await this.lockOwned(trx, id, caller);
      const current = await this.get(id, trx);
      approved(current);
      if (current.party?.preparationId !== submission.preparationId) {
        throw new Conflict('Preparation does not belong to this onboarding');
      }
      if (current.party.status === 'CONFLICT') throw new PartyAlreadyExists();
      if (current.party.status === 'PREPARED') validatePartyHint(current.review.partyHint);
      verifyTopology(current.party, submission.signature);
      return this.transition(trx, id, 'PREPARED', 'SUBMITTING');
    });
  }

  async topology(id: string): Promise<readonly string[]> {
    const row = await this.db
      .selectFrom('onboardings')
      .select('topology_transactions')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return stored('topology', present(row.topology_transactions, 'topology_transactions'), strings);
  }

  async confirmParty(id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.lock(trx, id);
      const current = await this.get(id, trx);
      approved(current);
      const party = present(current.party, 'party');
      if (party.confirmed) return;
      if (!REGISTERING.includes(party.status)) throw new Conflict('Party was not submitted');
      await bindParty(trx, current.accountId, party.partyId);
      await trx
        .updateTable('onboardings')
        .set({ party_confirmed_at: sql<string>`now()`, party_status: 'CONFIRMED' })
        .where('id', '=', id)
        .execute();
    });
  }

  async deniedParty(id: string): Promise<void> {
    await this.transition(this.db, id, 'SUBMITTING', 'PREPARED');
  }

  async unresolvedParty(id: string): Promise<void> {
    await this.transition(this.db, id, 'SUBMITTING', 'UNRESOLVED');
  }

  async conflictedParty(id: string): Promise<void> {
    await this.transition(this.db, id, 'SUBMITTING', 'CONFLICT');
  }

  async pending(): Promise<readonly string[]> {
    const rows = await sql<{ id: string }>`
      SELECT o.id FROM onboardings o WHERE party_mode='external' AND review_decision='APPROVED'
        AND (party_status IN ('SUBMITTING','UNRESOLVED') OR
          (party_status='CONFIRMED' AND (NOT EXISTS(SELECT 1 FROM onboarding_steps s WHERE s.onboarding_id=o.id)
           OR EXISTS(SELECT 1 FROM onboarding_steps s WHERE s.onboarding_id=o.id AND s.status<>'CONFIRMED'))))
      ORDER BY created_at LIMIT 100`.execute(this.db);
    return rows.rows.map((row) => row.id);
  }

  async initializeLedgerSteps(id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.lock(trx, id);
      const current = await this.get(id, trx);
      if (
        current.review?.decision !== 'APPROVED' ||
        current.party?.confirmed !== true ||
        current.partyMode !== EXTERNAL_MODE
      ) {
        return;
      }
      const keys = [ATTESTATION_STEP, ...current.review.approvedPoolIds.map((pool) => ACCESS_STEP_PREFIX + pool)];
      for (const key of keys) {
        await trx
          .insertInto('onboarding_steps')
          .values({ onboarding_id: id, step_key: key, command_id: randomUUID(), status: 'PENDING' })
          .onConflict((conflict) => conflict.columns(['onboarding_id', 'step_key']).doNothing())
          .execute();
      }
    });
  }

  async claim(id: string, step: LedgerStep, beginOffset: bigint): Promise<boolean> {
    const result = await this.db
      .updateTable('onboarding_steps')
      .set({ status: 'SUBMITTING', begin_offset: beginOffset })
      .where('onboarding_id', '=', id)
      .where('step_key', '=', step.key)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async beginOffset(id: string, step: LedgerStep): Promise<bigint | null> {
    const row = await this.db
      .selectFrom('onboarding_steps')
      .select('begin_offset')
      .where('onboarding_id', '=', id)
      .where('step_key', '=', step.key)
      .executeTakeFirstOrThrow();
    return row.begin_offset;
  }

  async confirmed(id: string, step: LedgerStep, result: Confirmation): Promise<void> {
    await this.db
      .updateTable('onboarding_steps')
      .set({ status: 'CONFIRMED', contract_id: result.contractId, update_id: result.updateId, issuer: result.issuer })
      .where('onboarding_id', '=', id)
      .where('step_key', '=', step.key)
      .where('status', 'in', ['SUBMITTING', 'UNRESOLVED'])
      .execute();
  }

  async unresolved(id: string, step: LedgerStep): Promise<void> {
    await this.db
      .updateTable('onboarding_steps')
      .set({ status: 'UNRESOLVED' })
      .where('onboarding_id', '=', id)
      .where('step_key', '=', step.key)
      .where('status', '=', 'SUBMITTING')
      .execute();
  }

  private async transition(db: Executor, id: string, from: PartyStatus, to: PartyStatus): Promise<boolean> {
    const result = await db
      .updateTable('onboardings')
      .set({ party_status: to })
      .where('id', '=', id)
      .where('party_status', '=', from)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  private async lock(db: Executor, id: string): Promise<void> {
    const row = await db.selectFrom('onboardings').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) throw new NotFound();
  }

  private async lockOwned(db: Executor, id: string, caller: Account): Promise<void> {
    const row = await db
      .selectFrom('onboardings')
      .select('id')
      .where('id', '=', id)
      .where('account_id', '=', caller.id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new NotFound();
  }
}
