import { readFileSync } from 'node:fs';
import { Kysely, PostgresDialect, sql, type ColumnType, type Generated } from 'kysely';
import pg from 'pg';
import type { DatabaseConfig } from './config.js';

/** The application pool of the baseline API: eight connections and 30 s to acquire one. */
const POOL_SIZE = 8;
const ACQUIRE_TIMEOUT_MS = 30_000;
const SCHEMA_FILE = new URL('../../db/schema.sql', import.meta.url);
export const RESET_INSTRUCTION = 'Recreate the local state with make docker-reset';
/** The PostgreSQL error code of a duplicate key. */
const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === UNIQUE_VIOLATION;
}

const TIMESTAMPTZ_OID = 1184;
const INT8_OID = 20;
const NUMERIC_OID = 1700;
const JSON_OID = 114;
const JSONB_OID = 3802;

/**
 * JSON and JSONB stay text, in both directions. Stores parse it with the exact-number reader, and
 * pg would send a JS array as an SQL array.
 */
type Json = ColumnType<string, string, string>;
type Defaulted<T> = ColumnType<T, T | undefined, T>;
/** A nullable column that an insert may omit. */
type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null>;

export interface AccountsTable {
  id: string;
  issuer: string;
  subject: string;
  display_name: string;
  role: 'TRADER' | 'OPERATOR';
  party_id: string | null;
}

export interface FixturePartiesTable {
  name: string;
  party_id: string;
  ledger_user_id: string;
  ledger_client_id: string;
}

export interface PoolsTable {
  pool_id: string;
  config_id: string;
  state_id: string;
  package_id: string;
  name: string;
  active: Defaulted<boolean>;
  settings: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<string | null, string | null | undefined, string | null>;
  updated_at: Generated<string>;
}

export interface OnboardingsTable {
  id: string;
  account_id: string;
  application: Json;
  created_at: Generated<string>;
  review_decision: 'APPROVED' | 'REJECTED' | null;
  reviewed_by: string | null;
  reviewed_at: ColumnType<string | null, never, string>;
  approved_pools: ColumnType<string, string | undefined, string>;
  preparation_id: string | null;
  prepared_party_id: string | null;
  party_confirmed_at: ColumnType<string | null, never, string>;
  party_mode: Defaulted<'participant-test' | 'external'>;
  party_hint: string | null;
  public_key: string | null;
  public_key_fingerprint: string | null;
  multi_hash: string | null;
  synchronizer_id: string | null;
  topology_transactions: ColumnType<string | null, string | null | undefined, string>;
  party_status: 'PREPARED' | 'SUBMITTING' | 'CONFIRMED' | 'UNRESOLVED' | 'CONFLICT' | null;
  prepared_participant_id: string | null;
}

export interface OnboardingStepsTable {
  onboarding_id: string;
  step_key: string;
  command_id: string;
  status: 'PENDING' | 'SUBMITTING' | 'CONFIRMED' | 'UNRESOLVED';
  contract_id: string | null;
  begin_offset: bigint | null;
  update_id: string | null;
  issuer: string | null;
}

export interface VenueConfigurationTable {
  id: number;
  synchronizer_id: string;
  participant_id: string | null;
}

export interface PoolProposalsTable {
  id: string;
  name: string;
  settings: Json;
  factory_id: string;
  proposed_by: string;
  status: 'SUBMITTING' | 'PENDING' | 'CREATED' | 'REJECTED' | 'WITHDRAWN' | 'UNRESOLVED' | 'FAILED';
  command_id: string;
  begin_offset: bigint;
  proposal_cid: string | null;
  pool_id: string | null;
  update_id: string | null;
  error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface PoolPairClaimsTable {
  pair_key: string;
  proposal_id: string | null;
  pool_id: string | null;
}

export type Family = 'swap' | 'deposit' | 'withdraw';

export interface PoolQueuesTable {
  pool_id: string;
  active_settlement_id: string | null;
  last_processed_family: Family | null;
  updated_at: Generated<string>;
}

export interface PoolRequestQueuesTable {
  pool_id: string;
  family: Family;
  automatic_enabled: Defaulted<boolean>;
  batch_size: Defaulted<number>;
  policy_version: Defaulted<bigint>;
  next_sequence: Defaulted<bigint>;
  blocked_version: string | null;
  updated_at: Generated<string>;
}

export interface SettlementBatchesTable {
  id: string;
  pool_id: string;
  trigger: 'MANUAL' | 'AUTOMATIC';
  status: 'PREPARING' | 'SUBMITTING' | 'UNRESOLVED' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED';
  requests: Json;
  fills: Defaulted<string>;
  reserves_before: Nullable<string>;
  reserves_after: Nullable<string>;
  policy_version: bigint;
  command_id: string;
  retry_of: Nullable<string>;
  selection: Nullable<string>;
  begin_offset: bigint;
  state_version: string;
  update_id: Nullable<string>;
  error_code: Nullable<string>;
  error: Nullable<string>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface SwapQuotesTable {
  id: string;
  account_id: string;
  payload: Json;
  expires_at: string;
}

export interface SwapRequestsTable {
  id: string;
  account_id: string;
  quote_id: string;
  terms: Json;
  status: string;
  arrival_sequence: Nullable<bigint>;
  settlement_id: Nullable<string>;
  amount_out: Nullable<string>;
  allocation_cids: Defaulted<string>;
  update_id: Nullable<string>;
  error_code: Nullable<string>;
  error: Nullable<string>;
  created_at: Generated<string>;
  submitted_at: Nullable<string>;
  updated_at: Generated<string>;
}

export interface SwapPreparationsTable {
  id: string;
  swap_id: string;
  command_id: string;
  action: 'SUBMIT' | 'WITHDRAW';
  signing: Json;
  status: 'PREPARED' | 'SUBMITTING' | 'UNRESOLVED' | 'CONFIRMED' | 'FAILED';
  signature: Nullable<string>;
  begin_offset: Nullable<bigint>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface LiquidityQuotesTable {
  id: string;
  account_id: string;
  kind: 'DEPOSIT' | 'WITHDRAW';
  payload: Json;
  expires_at: string;
}

export interface LiquidityRequestsTable {
  id: string;
  account_id: string;
  quote_id: string;
  kind: 'DEPOSIT' | 'WITHDRAW';
  terms: Json;
  status: string;
  arrival_sequence: Nullable<bigint>;
  settlement_id: Nullable<string>;
  result: Nullable<string>;
  allocation_cids: Defaulted<string>;
  update_id: Nullable<string>;
  error_code: Nullable<string>;
  error: Nullable<string>;
  created_at: Generated<string>;
  submitted_at: Nullable<string>;
  updated_at: Generated<string>;
}

export interface LiquidityPreparationsTable {
  id: string;
  request_id: string;
  command_id: string;
  action: 'SUBMIT' | 'RECOVER';
  signing: Json;
  status: 'PREPARED' | 'SUBMITTING' | 'UNRESOLVED' | 'CONFIRMED' | 'FAILED';
  signature: Nullable<string>;
  begin_offset: Nullable<bigint>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface SettlementDeferredRequestsTable {
  pool_id: string;
  family: Family;
  request_id: string;
  deferred_at: string;
}

export interface OperatorCommandsTable {
  id: string;
  kind: string;
  payload: string | null;
  error: string | null;
}

export interface TestTokenConfigurationTable {
  id: number;
  issuer_party_id: string;
  rules_id: string;
  rules_created_event_blob: string;
  package_id: string;
  allocation_factory_id: string;
  settlement_factory_id: string;
  faucet_factory_id: string;
  synchronizer_id: string;
}

export interface TestTokenInstrumentsTable {
  symbol: string;
  instrument_id: string;
  decimals: number;
  /** NUMERIC, read and written as exact decimal text. */
  initial_claim_amount: string;
}

export interface TestTokenPoolsTable {
  pair: string;
  pool_id: string;
  delegation_id: string | null;
}

export interface DevFaucetClaimsTable {
  account_id: string;
  party_id: string;
  grant_id: string;
  grant_command_id: string;
  grant_cid: string | null;
  grant_begin_offset: bigint | null;
  grant_status: Defaulted<'PENDING' | 'SUBMITTING' | 'UNRESOLVED' | 'CONFIRMED'>;
  preparation_id: string | null;
  prepared_transaction: string | null;
  prepared_hash: string | null;
  hashing_scheme_version: number | null;
  expires_at: string | null;
  claim_begin_offset: bigint | null;
  status: Defaulted<'AVAILABLE' | 'PREPARED' | 'SUBMITTING' | 'UNRESOLVED' | 'COMPLETED'>;
  update_id: string | null;
  error_code: string | null;
  error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface TokenRegistriesTable {
  admin: string;
  allocation_factory_id: string;
  settlement_factory_id: string;
}

export interface TokenRegistryContractsTable {
  admin: string;
  contract_id: string;
  template_id: string;
  created_event_blob: string;
  synchronizer_id: string;
}

export interface TokenInstrumentsTable {
  admin: string;
  instrument_id: string;
  symbol: string;
  decimals: number;
}

/** The tables of `db/schema.sql`. */
export interface Database {
  accounts: AccountsTable;
  fixture_parties: FixturePartiesTable;
  pools: PoolsTable;
  onboardings: OnboardingsTable;
  onboarding_steps: OnboardingStepsTable;
  venue_configuration: VenueConfigurationTable;
  pool_proposals: PoolProposalsTable;
  pool_pair_claims: PoolPairClaimsTable;
  pool_queues: PoolQueuesTable;
  pool_request_queues: PoolRequestQueuesTable;
  settlement_batches: SettlementBatchesTable;
  settlement_deferred_requests: SettlementDeferredRequestsTable;
  operator_commands: OperatorCommandsTable;
  test_token_configuration: TestTokenConfigurationTable;
  test_token_instruments: TestTokenInstrumentsTable;
  test_token_pools: TestTokenPoolsTable;
  dev_faucet_claims: DevFaucetClaimsTable;
  token_registries: TokenRegistriesTable;
  token_registry_contracts: TokenRegistryContractsTable;
  token_instruments: TokenInstrumentsTable;
  swap_quotes: SwapQuotesTable;
  swap_requests: SwapRequestsTable;
  swap_preparations: SwapPreparationsTable;
  liquidity_quotes: LiquidityQuotesTable;
  liquidity_requests: LiquidityRequestsTable;
  liquidity_preparations: LiquidityPreparationsTable;
}

export type Db = Kysely<Database>;

/**
 * Timestamps stay PostgreSQL text in UTC, so the API keeps their microseconds (see
 * `isoInstant`); JavaScript dates would truncate them. BIGINT offsets and sequences are exact
 * bigints over the full int64 range, and NUMERIC stays exact text.
 */
function typeParsers(): pg.CustomTypesConfig {
  const types = new pg.TypeOverrides();
  types.setTypeParser(TIMESTAMPTZ_OID, (text) => text);
  types.setTypeParser(INT8_OID, BigInt);
  types.setTypeParser(NUMERIC_OID, (text) => text);
  types.setTypeParser(JSON_OID, (text) => text);
  types.setTypeParser(JSONB_OID, (text) => text);
  return types;
}

export function createDatabase(config: DatabaseConfig, onError: (error: Error) => void): Db {
  const pool = new pg.Pool({
    ...config,
    max: POOL_SIZE,
    connectionTimeoutMillis: ACQUIRE_TIMEOUT_MS,
    // Timestamp text is always UTC, which `isoInstant` relies on.
    options: '-c TimeZone=UTC',
    types: typeParsers(),
  });
  pool.on('error', onError);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** A health check that runs one query, as the baseline database check did. */
export async function databaseReady(db: Db): Promise<void> {
  await sql`SELECT 1`.execute(db);
}

export function schemaStatements(): string {
  return readFileSync(SCHEMA_FILE, 'utf8');
}

/** The table names that `db/schema.sql` creates. */
export function schemaTables(): string[] {
  return [...schemaStatements().matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1] ?? '');
}

/** The API validates the schema that contract-bootstrap initialized; it never creates one. */
export async function requireSchema(db: Db): Promise<void> {
  const { rows } = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`.execute(db);
  const present = new Set(rows.map((row) => row.table_name));
  const missing = schemaTables().filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new Error(
      `The application schema lacks ${missing.join(', ')}. Run contract-bootstrap first. ${RESET_INSTRUCTION}.`,
    );
  }
}
