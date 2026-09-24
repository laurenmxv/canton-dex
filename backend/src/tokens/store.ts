import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import { requireRole, type Account } from '../iam/accounts.js';
import type { PartyStatus } from '../onboarding/model.js';
import type { Db, DevFaucetClaimsTable } from '../platform/database.js';
import { numericUnits, trimmedText } from '../platform/decimal.js';
import { Conflict } from '../platform/errors.js';
import { isoInstant } from '../platform/time.js';
import { nameUuid } from '../platform/uuid.js';
import type { Claim, Confirmation, Prepared, Registry, Signer, TestToken } from './model.js';
import type { TokenProgress } from './ports.js';

const GRANT_NAMESPACE = 'local-test-faucet:';
const IN_FLIGHT = ['SUBMITTING', 'UNRESOLVED'] as const;

function present<T>(value: T | null, column: string): T {
  if (value === null) throw new Error(`Stored faucet claim has no ${column}`);
  return value;
}

function toClaim(row: Selectable<DevFaucetClaimsTable>): Claim {
  const prepared: Prepared | null =
    row.expires_at === null
      ? null
      : {
          preparedTransaction: present(row.prepared_transaction, 'prepared_transaction'),
          preparedTransactionHash: present(row.prepared_hash, 'prepared_hash'),
          hashingSchemeVersion: present(row.hashing_scheme_version, 'hashing_scheme_version'),
          expiresAt: isoInstant(row.expires_at),
        };
  return {
    accountId: row.account_id,
    grantId: row.grant_id,
    grantCommandId: row.grant_command_id,
    grantCid: row.grant_cid,
    grantBeginOffset: row.grant_begin_offset,
    grantStatus: row.grant_status,
    preparationId: row.preparation_id,
    prepared,
    claimBeginOffset: row.claim_begin_offset,
    status: row.status,
    updateId: row.update_id,
    errorCode: row.error_code,
    error: row.error,
  };
}

/** The development faucet claims, with the test-token registry that the bootstrap configured. */
export class TokenStore implements TokenProgress {
  constructor(private readonly db: Db) {}

  async registry(): Promise<Registry> {
    const row = await this.db
      .selectFrom('test_token_configuration')
      .select([
        'issuer_party_id as issuerPartyId',
        'rules_id as rulesId',
        'package_id as packageId',
        'faucet_factory_id as faucetFactoryId',
        'rules_created_event_blob as rulesCreatedEventBlob',
        'synchronizer_id as synchronizerId',
      ])
      .where('id', '=', 1)
      .executeTakeFirst();
    if (!row) throw new Conflict('Test token fixtures are not initialized');
    return row;
  }

  async tokens(): Promise<TestToken[]> {
    const rows = await this.db
      .selectFrom('test_token_instruments')
      .select(['symbol', 'instrument_id', 'decimals', 'initial_claim_amount'])
      .orderBy('symbol')
      .execute();
    return rows.map((row) => ({
      symbol: row.symbol,
      instrumentId: row.instrument_id,
      decimals: row.decimals,
      initialClaimAmount: trimmedText(numericUnits(row.initial_claim_amount)),
    }));
  }

  /** The onboarded trader, once its party and every onboarding ledger step are confirmed. */
  async signer(account: Account): Promise<Signer> {
    requireRole(account, 'TRADER');
    const { rows } = await sql<{
      subject: string;
      preparation_id: string;
      prepared_party_id: string;
      public_key: string;
      public_key_fingerprint: string;
      multi_hash: string;
      synchronizer_id: string;
      party_status: PartyStatus;
      prepared_participant_id: string;
    }>`
      SELECT a.subject,o.* FROM accounts a JOIN onboardings o ON o.account_id=a.id
      WHERE a.id=${account.id} AND a.party_id=o.prepared_party_id AND o.review_decision='APPROVED'
        AND o.party_mode='external' AND o.party_status='CONFIRMED'
        AND EXISTS (SELECT 1 FROM onboarding_steps s WHERE s.onboarding_id=o.id)
        AND NOT EXISTS (SELECT 1 FROM onboarding_steps s WHERE s.onboarding_id=o.id AND s.status<>'CONFIRMED')`.execute(
      this.db,
    );
    const [row] = rows;
    if (!row) throw new Conflict('Complete onboarding before using test tokens');
    return {
      userId: row.subject,
      party: {
        preparationId: row.preparation_id,
        partyId: row.prepared_party_id,
        confirmed: true,
        publicKey: row.public_key,
        publicKeyFingerprint: row.public_key_fingerprint,
        multiHash: row.multi_hash,
        synchronizerId: row.synchronizer_id,
        status: row.party_status,
        participantId: row.prepared_participant_id,
        topologyTransactions: [],
      },
    };
  }

  /** The account's claim; one party receives one grant identity, whichever account asks. */
  async initialize(accountId: string, partyId: string): Promise<Claim> {
    await this.db
      .insertInto('dev_faucet_claims')
      .values({
        account_id: accountId,
        party_id: partyId,
        grant_id: nameUuid(GRANT_NAMESPACE + partyId),
        grant_command_id: randomUUID(),
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    const claim = await this.get(accountId);
    if (!claim) throw new Conflict('This party already has a test token request');
    return claim;
  }

  async get(accountId: string): Promise<Claim | undefined> {
    const row = await this.db
      .selectFrom('dev_faucet_claims')
      .selectAll()
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return row ? toClaim(row) : undefined;
  }

  async claimGrant(accountId: string, offset: bigint): Promise<boolean> {
    const result = await this.db
      .updateTable('dev_faucet_claims')
      .set({
        grant_status: 'SUBMITTING',
        grant_command_id: randomUUID(),
        grant_begin_offset: offset,
        error_code: null,
        error: null,
        updated_at: sql<string>`now()`,
      })
      .where('account_id', '=', accountId)
      .where('grant_status', '=', 'PENDING')
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async confirmGrant(accountId: string, commandId: string, confirmation: Confirmation): Promise<void> {
    await this.db
      .updateTable('dev_faucet_claims')
      .set({
        grant_status: 'CONFIRMED',
        grant_cid: confirmation.contractId,
        error_code: null,
        error: null,
        updated_at: sql<string>`now()`,
      })
      .where('account_id', '=', accountId)
      .where('grant_command_id', '=', commandId)
      .where('grant_status', 'in', IN_FLIGHT)
      .execute();
  }

  async beginGrantRecovery(accountId: string, commandId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('dev_faucet_claims')
      .set({ grant_status: 'UNRESOLVED', updated_at: sql<string>`now()` })
      .where('account_id', '=', accountId)
      .where('grant_command_id', '=', commandId)
      .where('grant_status', 'in', IN_FLIGHT)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async unresolvedGrant(accountId: string, commandId: string): Promise<void> {
    await this.db
      .updateTable('dev_faucet_claims')
      .set({
        grant_status: 'UNRESOLVED',
        error_code: 'GRANT_UNRESOLVED',
        error: 'Checking whether the test token grant was created',
        updated_at: sql<string>`now()`,
      })
      .where('account_id', '=', accountId)
      .where('grant_command_id', '=', commandId)
      .where('grant_status', '=', 'SUBMITTING')
      .execute();
  }

  /** Stores a preparation once the grant exists, replacing only an expired one. */
  async savePreparation(accountId: string, preparationId: string, prepared: Prepared): Promise<boolean> {
    const result = await this.db
      .updateTable('dev_faucet_claims')
      .set({
        preparation_id: preparationId,
        prepared_transaction: prepared.preparedTransaction,
        prepared_hash: prepared.preparedTransactionHash,
        hashing_scheme_version: prepared.hashingSchemeVersion,
        expires_at: prepared.expiresAt,
        status: 'PREPARED',
        error_code: null,
        error: null,
        updated_at: sql<string>`now()`,
      })
      .where('account_id', '=', accountId)
      .where('grant_status', '=', 'CONFIRMED')
      .where((row) =>
        row.or([
          row('status', '=', 'AVAILABLE'),
          row.and([row('status', '=', 'PREPARED'), row('expires_at', '<=', sql<string>`now()`)]),
        ]),
      )
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async claimSubmission(accountId: string, preparationId: string, offset: bigint): Promise<boolean> {
    const result = await this.db
      .updateTable('dev_faucet_claims')
      .set({ status: 'SUBMITTING', claim_begin_offset: offset, updated_at: sql<string>`now()` })
      .where('account_id', '=', accountId)
      .where('preparation_id', '=', preparationId)
      .where('status', '=', 'PREPARED')
      .where('expires_at', '>', sql<string>`now()`)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async complete(accountId: string, preparationId: string, confirmation: Confirmation): Promise<void> {
    await this.db
      .updateTable('dev_faucet_claims')
      .set({
        status: 'COMPLETED',
        update_id: confirmation.updateId,
        error_code: null,
        error: null,
        updated_at: sql<string>`now()`,
      })
      .where('account_id', '=', accountId)
      .where('preparation_id', '=', preparationId)
      .where('status', 'in', IN_FLIGHT)
      .execute();
  }

  async rejected(accountId: string, preparationId: string): Promise<void> {
    await this.db
      .updateTable('dev_faucet_claims')
      .set({
        status: 'AVAILABLE',
        prepared_transaction: null,
        prepared_hash: null,
        hashing_scheme_version: null,
        expires_at: null,
        error_code: 'CLAIM_REJECTED',
        error: 'The previous claim did not commit; prepare a new signing request',
        updated_at: sql<string>`now()`,
      })
      .where('account_id', '=', accountId)
      .where('preparation_id', '=', preparationId)
      .where('status', 'in', IN_FLIGHT)
      .execute();
  }

  async rejectedGrant(accountId: string, commandId: string): Promise<void> {
    await this.resetGrant(accountId, commandId, false);
  }

  async excludeGrant(accountId: string, commandId: string): Promise<void> {
    await this.resetGrant(accountId, commandId, true);
  }

  private async resetGrant(accountId: string, commandId: string, neverSubmitted: boolean): Promise<void> {
    await this.db
      .updateTable('dev_faucet_claims')
      .set({
        grant_status: 'PENDING',
        error_code: 'GRANT_REJECTED',
        error: 'The previous grant attempt did not commit; retry the request',
        updated_at: sql<string>`now()`,
      })
      .where('account_id', '=', accountId)
      .where('grant_command_id', '=', commandId)
      .where('grant_status', 'in', neverSubmitted ? IN_FLIGHT : ['SUBMITTING'])
      .execute();
  }

  async unresolved(accountId: string, preparationId: string): Promise<void> {
    await this.db
      .updateTable('dev_faucet_claims')
      .set({
        status: 'UNRESOLVED',
        error_code: 'CLAIM_UNRESOLVED',
        error: 'Checking whether the signed test token claim committed',
        updated_at: sql<string>`now()`,
      })
      .where('account_id', '=', accountId)
      .where('preparation_id', '=', preparationId)
      .where('status', '=', 'SUBMITTING')
      .execute();
  }
}
