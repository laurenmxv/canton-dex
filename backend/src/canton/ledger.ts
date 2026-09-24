import { randomUUID } from 'node:crypto';
import { epochNanos } from '../platform/time.js';
import type { components } from './generated/ledger-api.js';
import type { ServiceCredentials } from './credentials.js';
import {
  array,
  boolean,
  integer,
  offset,
  optionalString,
  record,
  repeated,
  string,
  strings,
  type JsonRecord,
} from './decode.js';
import { LedgerRejected, parseLedgerJson, type LedgerHttp, type Query } from './http.js';
import { AllocationInterface, byName, byPackageId, DEX_PACKAGE_ID, sameEntity, type DamlName } from './packages.js';

type Schemas = components['schemas'];
export type Command = Schemas['Command'];
export type DisclosedContract = Required<Schemas['DisclosedContract']>;
type Filters = Schemas['Filters'];
type CumulativeFilter = Schemas['CumulativeFilter'];
/** A request whose int64 offset fields carry exact bigint values; the OpenAPI types say `number`. */
type ExactOffsets<T, K extends keyof T> = Omit<T, K> & { readonly [P in K]-?: bigint };
type DeduplicationPeriod =
  | Exclude<Schemas['DeduplicationPeriod'], { DeduplicationOffset: unknown }>
  | { DeduplicationOffset: { value: bigint } };
export type StoredCommands = Omit<Schemas['JsCommands'], 'deduplicationPeriod'> & {
  deduplicationPeriod?: DeduplicationPeriod;
};

const QUICK_TIMEOUT_MS = 10_000;
const HISTORY_TIMEOUT_MS = 20_000;
const ACS_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 60_000;
/** The first page of a JSON list; a participant with a lower list limit halves it. */
const LIST_PAGE_SIZE = 200;
const LIST_LIMIT_REACHED = 'JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED';
/** A list stream outlives the call deadline, so a stalled stream fails and never ends a page early. */
const STREAM_IDLE_MARGIN_MS = 5_000;
/** Commands without a stored offset use a 30 s deduplication duration. */
const DEDUPLICATION_SECONDS = 30;
const LEDGER_EFFECTS = 'TRANSACTION_SHAPE_LEDGER_EFFECTS';

export interface InterfaceView {
  readonly interfaceId: string;
  readonly statusCode: number;
  readonly value: unknown;
}

export interface CreatedEvent {
  readonly offset: bigint;
  readonly contractId: string;
  readonly templateId: string;
  readonly createArgument: unknown;
  /** The participant's opaque disclosure blob; empty when it was not requested. */
  readonly createdEventBlob: string;
  readonly interfaceViews: readonly InterfaceView[];
  readonly signatories: readonly string[];
  readonly observers: readonly string[];
  readonly createdAt: string;
}

export interface ExercisedEvent {
  readonly contractId: string;
  readonly templateId: string;
  /** The interface through which the choice was exercised, if any. */
  readonly interfaceId?: string | undefined;
  readonly choice: string;
  readonly consuming: boolean;
  readonly actingParties: readonly string[];
  readonly choiceArgument: unknown;
  readonly exerciseResult: unknown;
}

export type LedgerEvent =
  | { readonly created: CreatedEvent }
  | { readonly exercised: ExercisedEvent }
  | { readonly archived: { readonly contractId: string; readonly templateId: string } };

export interface Transaction {
  readonly updateId: string;
  readonly commandId: string;
  readonly offset: bigint;
  readonly synchronizerId: string;
  readonly recordTime: string;
  /** The ledger time of the transaction. */
  readonly effectiveAt: string;
  readonly events: readonly LedgerEvent[];
}

/** Complete visible history through `endOffset`, with the synchronizer's record-time watermark. */
export interface History {
  readonly transactions: readonly Transaction[];
  readonly recordTime: string | undefined;
  readonly endOffset: bigint;
}

function view(value: unknown, what: string): InterfaceView {
  const item = record(value, what);
  const status = record(item.viewStatus, `${what}.viewStatus`);
  return {
    interfaceId: string(item.interfaceId, `${what}.interfaceId`),
    statusCode: integer(status.code, `${what}.viewStatus.code`),
    value: item.viewValue,
  };
}

export function createdEvent(value: unknown, what = 'createdEvent'): CreatedEvent {
  const event = record(value, what);
  return {
    offset: offset(event.offset, `${what}.offset`),
    contractId: string(event.contractId, `${what}.contractId`),
    templateId: string(event.templateId, `${what}.templateId`),
    createArgument: event.createArgument,
    createdEventBlob: optionalString(event.createdEventBlob, `${what}.createdEventBlob`) ?? '',
    interfaceViews: repeated(event.interfaceViews, `${what}.interfaceViews`, view),
    signatories: strings(event.signatories, `${what}.signatories`),
    observers: strings(event.observers, `${what}.observers`),
    createdAt: string(event.createdAt, `${what}.createdAt`),
  };
}

function exercisedEvent(value: unknown, what: string): ExercisedEvent {
  const event = record(value, what);
  return {
    contractId: string(event.contractId, `${what}.contractId`),
    templateId: string(event.templateId, `${what}.templateId`),
    interfaceId: optionalString(event.interfaceId, `${what}.interfaceId`),
    choice: string(event.choice, `${what}.choice`),
    consuming: boolean(event.consuming, `${what}.consuming`),
    actingParties: strings(event.actingParties, `${what}.actingParties`),
    choiceArgument: event.choiceArgument,
    exerciseResult: event.exerciseResult,
  };
}

function ledgerEvent(value: unknown, what: string): LedgerEvent {
  const event = record(value, what);
  if (event.CreatedEvent !== undefined) return { created: createdEvent(event.CreatedEvent, `${what}.CreatedEvent`) };
  if (event.ExercisedEvent !== undefined) {
    return { exercised: exercisedEvent(event.ExercisedEvent, `${what}.ExercisedEvent`) };
  }
  const archived = record(event.ArchivedEvent, `${what}.ArchivedEvent`);
  return {
    archived: {
      contractId: string(archived.contractId, `${what}.contractId`),
      templateId: string(archived.templateId, `${what}.templateId`),
    },
  };
}

export function transaction(value: unknown, what = 'transaction'): Transaction {
  const item = record(value, what);
  return {
    updateId: string(item.updateId, `${what}.updateId`),
    commandId: optionalString(item.commandId, `${what}.commandId`) ?? '',
    offset: offset(item.offset, `${what}.offset`),
    synchronizerId: string(item.synchronizerId, `${what}.synchronizerId`),
    recordTime: string(item.recordTime, `${what}.recordTime`),
    effectiveAt: string(item.effectiveAt, `${what}.effectiveAt`),
    events: repeated(item.events, `${what}.events`, ledgerEvent),
  };
}

export function createdEvents(tx: Transaction): CreatedEvent[] {
  return tx.events.flatMap((event) => ('created' in event ? [event.created] : []));
}

export function exercisedEvents(tx: Transaction): ExercisedEvent[] {
  return tx.events.flatMap((event) => ('exercised' in event ? [event.exercised] : []));
}

/** The empty `ExtraArgs` of the token standard: no choice context and no metadata. */
export const EMPTY_EXTRA_ARGS = { context: { values: {} }, meta: { values: {} } };

export function create(template: DamlName, createArguments: unknown): Command {
  return { CreateCommand: { templateId: byName(template), createArguments } };
}

export function exercise(template: DamlName, contractId: string, choice: string, choiceArgument: unknown): Command {
  return { ExerciseCommand: { templateId: byName(template), contractId, choice, choiceArgument } };
}

/** The first contract of `template` that the transaction created, from any package version. */
export function created(tx: Transaction, template: DamlName): CreatedEvent {
  const event = createdEvents(tx).find((candidate) => sameEntity(candidate.templateId, template));
  if (!event) throw new Error(`Transaction did not create ${template.module}:${template.entity}`);
  return event;
}

/** The decoded view of one standard interface, whatever template implements it. */
export function interfaceView(event: CreatedEvent, name: DamlName): unknown {
  const interfaceId = byPackageId(name);
  const matches = event.interfaceViews.filter((candidate) => candidate.interfaceId === interfaceId);
  const [match] = matches;
  if (matches.length !== 1 || !match)
    throw new Error(`Expected one ${interfaceId} view on contract ${event.contractId}`);
  if (match.statusCode !== 0) {
    throw new Error(`Interface view failed for contract ${event.contractId}: status ${String(match.statusCode)}`);
  }
  if (match.value === undefined || match.value === null) {
    throw new Error(`Interface view has no value for contract ${event.contractId}`);
  }
  return match.value;
}

function templateFilter(templateId: string): CumulativeFilter {
  return { identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: true } } } };
}

function interfaceFilter(interfaceId: string): CumulativeFilter {
  return {
    identifierFilter: {
      InterfaceFilter: { value: { interfaceId, includeInterfaceView: true, includeCreatedEventBlob: true } },
    },
  };
}

/** Every event, plus the standard allocation view that settlement code reads. */
export function transactionFilter(): Filters {
  return {
    cumulative: [
      { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
      interfaceFilter(byName(AllocationInterface)),
    ],
  };
}

function transactionFormat(parties: readonly string[]): Schemas['TransactionFormat'] {
  return {
    eventFormat: {
      filtersByParty: Object.fromEntries(parties.map((party) => [party, transactionFilter()])),
      verbose: true,
    },
    transactionShape: LEDGER_EFFECTS,
  };
}

/** The offset of an update of any kind: `{ <Kind>: { value: { offset } } }`. */
function updateOffset(update: JsonRecord): bigint {
  const [kind] = Object.values(update);
  return offset(record(record(kind, 'update').value, 'update.value').offset, 'update.offset');
}

function latest(previous: string | undefined, current: string): string {
  return previous === undefined || epochNanos(current) > epochNanos(previous) ? current : previous;
}

/**
 * Stored commands from their persisted JSON text. Fields this version does not know are kept, so
 * a retry sends the original intent; the deduplication offset becomes an exact bigint.
 */
export function parseStoredCommands(text: string): StoredCommands {
  const value = parseLedgerJson(text);
  if (!isStoredCommands(value)) throw new Error('Stored commands are invalid');
  const { deduplicationPeriod: period, ...stored } = value;
  if (period === undefined) return stored;
  if (!('DeduplicationOffset' in period)) return { ...stored, deduplicationPeriod: period };
  const original = period.DeduplicationOffset;
  const exact = { ...original, value: offset(original.value, 'DeduplicationOffset.value') };
  return { ...stored, deduplicationPeriod: { DeduplicationOffset: exact } };
}

function isStoredCommands(value: unknown): value is Schemas['JsCommands'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    'commands' in value &&
    Array.isArray(value.commands) &&
    'commandId' in value &&
    typeof value.commandId === 'string' &&
    'actAs' in value &&
    Array.isArray(value.actAs) &&
    value.actAs.every((party: unknown) => typeof party === 'string')
  );
}

/**
 * One authenticated Ledger API identity. Canton enforces its party rights. A service identity
 * uses its cached credentials; `forCaller` relays a validated caller token for one call chain.
 */
export class Ledger {
  private constructor(
    private readonly http: LedgerHttp,
    private readonly bearer: () => Promise<string>,
    private readonly user: string | undefined,
  ) {}

  static service(http: LedgerHttp, credentials: ServiceCredentials): Ledger {
    return new Ledger(http, () => credentials.token(), credentials.userId);
  }

  forCaller(token: string): Ledger {
    return new Ledger(this.http, () => Promise.resolve(token), undefined);
  }

  get userId(): string {
    if (this.user === undefined) throw new Error('A caller token has no service user');
    return this.user;
  }

  async call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    timeoutMs: number,
    options: { query?: Query; body?: unknown } = {},
  ): Promise<unknown> {
    return this.http.call({ method, path, token: await this.bearer(), timeoutMs, ...options });
  }

  async primaryParty(): Promise<string> {
    const response = record(
      await this.call('GET', `/v2/users/${encodeURIComponent(this.userId)}`, QUICK_TIMEOUT_MS),
      'user',
    );
    return optionalString(record(response.user, 'user').primaryParty, 'primaryParty') ?? '';
  }

  async ledgerEnd(): Promise<bigint> {
    const response = record(await this.call('GET', '/v2/state/ledger-end', QUICK_TIMEOUT_MS), 'ledger end');
    return response.offset === undefined ? 0n : offset(response.offset, 'offset');
  }

  private async synchronizers(query: Query = {}): Promise<JsonRecord[]> {
    const response = record(
      await this.call('GET', '/v2/state/connected-synchronizers', QUICK_TIMEOUT_MS, { query }),
      'connected synchronizers',
    );
    return repeated(response.connectedSynchronizers, 'connectedSynchronizers', record);
  }

  async singleSynchronizer(): Promise<string> {
    const synchronizers = await this.synchronizers();
    const [only] = synchronizers;
    if (synchronizers.length !== 1 || !only) throw new Error('Configure exactly one development synchronizer');
    return string(only.synchronizerId, 'synchronizerId');
  }

  async connected(): Promise<boolean> {
    return (await this.synchronizers({ party: await this.primaryParty() })).length > 0;
  }

  async hasPackage(packageId: string): Promise<boolean> {
    const response = record(await this.call('GET', '/v2/packages', QUICK_TIMEOUT_MS), 'packages');
    return strings(response.packageIds, 'packageIds').includes(packageId);
  }

  /** Active contracts of a template (a package-name identifier), at a fixed offset or the ledger end. */
  async activeContracts(party: string, template: DamlName, at?: bigint): Promise<CreatedEvent[]> {
    return this.activeAt(party, templateFilter(byName(template)), at ?? (await this.ledgerEnd()));
  }

  /** Active contracts that implement a standard interface, with their interface views. */
  async activeInterfaceContracts(party: string, name: DamlName, at?: bigint): Promise<CreatedEvent[]> {
    return this.activeAt(party, interfaceFilter(byName(name)), at ?? (await this.ledgerEnd()));
  }

  /**
   * One page of a JSON list. Above its list limit the participant answers HTTP 413, never a
   * truncated list; the page size then halves and the same page is read again.
   */
  private async page(path: string, body: unknown, timeoutMs: number, size: number) {
    for (let limit = size; ; limit = Math.floor(limit / 2)) {
      try {
        const response = await this.call('POST', path, timeoutMs, {
          query: { limit, stream_idle_timeout_ms: timeoutMs + STREAM_IDLE_MARGIN_MS },
          body,
        });
        return { items: array(response, path, (item, what) => record(item, what)), size: limit };
      } catch (error) {
        if (!(error instanceof LedgerRejected && error.code === LIST_LIMIT_REACHED) || limit === 1) throw error;
      }
    }
  }

  /** The complete snapshot, page by page; each page continues after the last contract read. */
  private async activeAt(party: string, filter: CumulativeFilter, activeAtOffset: bigint): Promise<CreatedEvent[]> {
    const eventFormat = { filtersByParty: { [party]: { cumulative: [filter] } }, verbose: true };
    const contracts: CreatedEvent[] = [];
    let token: string | undefined;
    let size = LIST_PAGE_SIZE;
    for (;;) {
      const request: ExactOffsets<Schemas['GetActiveContractsRequest'], 'activeAtOffset'> = {
        activeAtOffset,
        eventFormat,
        ...(token === undefined ? {} : { streamContinuationToken: token }),
      };
      const page = await this.page('/v2/state/active-contracts', request, ACS_TIMEOUT_MS, size);
      size = page.size;
      page.items.forEach((item, index) => {
        const entry = record(item.contractEntry, `active contracts[${String(index)}].contractEntry`);
        if (entry.JsActiveContract !== undefined) {
          contracts.push(createdEvent(record(entry.JsActiveContract, 'JsActiveContract').createdEvent));
        }
      });
      const last = page.items.at(-1);
      if (page.items.length < size || !last) return contracts;
      token = string(last.streamContinuationToken, 'streamContinuationToken');
    }
  }

  async transactions(beginOffset: bigint, party: string): Promise<readonly Transaction[]> {
    return (await this.history(beginOffset, party)).transactions;
  }

  async history(beginOffset: bigint, party: string): Promise<History> {
    const end = await this.ledgerEnd();
    if (beginOffset < 0n || end < beginOffset) throw new Error('History begins outside the current ledger range');
    if (end === 0n) return { transactions: [], recordTime: undefined, endOffset: end };
    const synchronizer = await this.singleSynchronizer();
    const updateFormat = { includeTransactions: transactionFormat([party]) };
    const transactions: Transaction[] = [];
    let recordTime: string | undefined;
    // A one-offset overlap permits an end checkpoint even when the ledger offset has not
    // changed. The overlap's transaction is excluded from the returned history.
    let cursor = beginOffset === end ? end - 1n : beginOffset;
    let size = LIST_PAGE_SIZE;
    for (;;) {
      const request: ExactOffsets<Schemas['GetUpdatesRequest'], 'beginExclusive' | 'endInclusive'> = {
        beginExclusive: cursor,
        endInclusive: end,
        updateFormat,
      };
      const page = await this.page('/v2/updates', request, HISTORY_TIMEOUT_MS, size);
      size = page.size;
      const updates = page.items.map((item) => record(item.update, 'update'));
      for (const update of updates) {
        if (update.Transaction !== undefined) {
          const tx = transaction(record(update.Transaction, 'Transaction').value);
          if (tx.offset > end) throw new Error('Participant returned a transaction beyond the snapshot');
          if (tx.offset > beginOffset) transactions.push(tx);
          if (tx.synchronizerId === synchronizer) recordTime = latest(recordTime, tx.recordTime);
        } else if (update.OffsetCheckpoint !== undefined) {
          const checkpoint = record(record(update.OffsetCheckpoint, 'OffsetCheckpoint').value, 'checkpoint');
          // A later watermark cannot prove absence in a history ending before that checkpoint.
          if (offset(checkpoint.offset, 'checkpoint.offset') <= end) {
            for (const time of repeated(checkpoint.synchronizerTimes, 'synchronizerTimes', record)) {
              if (time.synchronizerId === synchronizer)
                recordTime = latest(recordTime, string(time.recordTime, 'recordTime'));
            }
          }
        }
      }
      const last = updates.at(-1);
      if (updates.length < size || !last) break;
      // The next page begins after the last offset read. A checkpoint at that same offset is then
      // skipped; a lower watermark can only delay a proof of absence.
      const next = updateOffset(last);
      if (next <= cursor) throw new Error('Participant update page did not advance');
      if (next >= end) break;
      cursor = next;
    }
    return { transactions, recordTime, endOffset: end };
  }

  async submit(
    commandId: string,
    actor: string,
    readers: readonly string[],
    commands: readonly Command[],
    disclosures: readonly DisclosedContract[] = [],
  ): Promise<Transaction> {
    return this.submitAndWait({
      commands: [...commands],
      commandId,
      userId: this.userId,
      actAs: [actor],
      readAs: [...readers],
      disclosedContracts: [...disclosures],
      deduplicationPeriod: { DeduplicationDuration: { value: { seconds: DEDUPLICATION_SECONDS, nanos: 0 } } },
      packageIdSelectionPreference: [DEX_PACKAGE_ID],
    });
  }

  /** Builds the complete command once; callers persist it before its first submission. */
  storedCommands(
    commandId: string,
    actor: string,
    readers: readonly string[],
    commands: readonly Command[],
    deduplicationOffset: bigint,
    disclosures: readonly DisclosedContract[],
  ): StoredCommands {
    if (deduplicationOffset < 0n) throw new Error('Deduplication offset must be non-negative');
    return {
      commands: [...commands],
      commandId,
      userId: this.userId,
      actAs: [actor],
      readAs: [...readers],
      disclosedContracts: [...disclosures],
      deduplicationPeriod: { DeduplicationOffset: { value: deduplicationOffset } },
      packageIdSelectionPreference: [DEX_PACKAGE_ID],
    };
  }

  /**
   * Retries the same stored intent on this participant. The deduplication offset never advances,
   * including when Canton rejects the offset as unsupported or pruned; only the submission id,
   * which identifies an attempt, is new.
   */
  async submitStored(stored: StoredCommands): Promise<Transaction> {
    const period = stored.deduplicationPeriod;
    const original = period && 'DeduplicationOffset' in period ? period.DeduplicationOffset.value : undefined;
    if (stored.userId !== this.userId) throw new Error('Stored command belongs to a different ledger user');
    if (original === undefined || original < 0n || stored.actAs.length !== 1 || stored.commands.length === 0) {
      throw new Error('Stored command requires one actor, commands, and an original offset');
    }
    return this.submitAndWait({ ...stored, submissionId: randomUUID() });
  }

  private async submitAndWait(commands: StoredCommands): Promise<Transaction> {
    const request: Omit<Schemas['JsSubmitAndWaitForTransactionRequest'], 'commands'> & { commands: StoredCommands } = {
      commands,
      transactionFormat: transactionFormat([...commands.actAs, ...(commands.readAs ?? [])]),
    };
    const response = record(
      await this.call('POST', '/v2/commands/submit-and-wait-for-transaction', SUBMIT_TIMEOUT_MS, { body: request }),
      'submission',
    );
    return transaction(response.transaction);
  }
}

/**
 * The `canton` health check: the operator reads the ledger end, its party has a connected
 * synchronizer, and the DEX package is uploaded.
 */
export async function ledgerReady(ledger: Ledger): Promise<void> {
  await ledger.ledgerEnd();
  if (!(await ledger.connected())) throw new Error('No connected synchronizer');
  if (!(await ledger.hasPackage(DEX_PACKAGE_ID))) throw new Error('Application package is missing');
}
