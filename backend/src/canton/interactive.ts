import { BinaryReader, WireType } from '@bufbuild/protobuf/wire';
import type { PartyPreparation } from '../onboarding/model.js';
import { algorithm, verify as verifySignature } from '../onboarding/signatures.js';
import { InvalidRequest } from '../platform/errors.js';
import { strictBase64 } from '../platform/request.js';
import { epochMicros, truncateToMicros } from '../platform/time.js';
import { HASH_BYTES } from '../tokens/model.js';
import type { components } from './generated/ledger-api.js';
import { optionalString, record, string } from './decode.js';
import type { LedgerHttp } from './http.js';
import { transaction, transactionFilter, type Command, type DisclosedContract, type Transaction } from './ledger.js';
import { DEX_PACKAGE_ID } from './packages.js';

type Schemas = components['schemas'];

const PREPARE_TIMEOUT_MS = 30_000;
const EXECUTE_TIMEOUT_MS = 60_000;
/** Hashing scheme V3 signs the maximum record time. */
const HASHING_SCHEME_V3 = 3;
const HASHING_SCHEMES: Readonly<Record<string, number>> = {
  HASHING_SCHEME_VERSION_UNSPECIFIED: 0,
  HASHING_SCHEME_VERSION_V2: 2,
  HASHING_SCHEME_VERSION_V3: HASHING_SCHEME_V3,
};
/** Protocol version 35 and later hash the physical synchronizer id. */
const PHYSICAL_SYNCHRONIZER_MIN_PROTOCOL = 35;
/** The physical protocol version and serial are int32 values. */
const INT32_MAX = 2_147_483_647;
const PHYSICAL_SUFFIX = /^[1-9][0-9]*-(?:0|[1-9][0-9]*)$/;

/** Backend-owned preparation. HTTP callers provide its id and signature, never these bytes. */
export interface Prepared {
  readonly preparedTransaction: string;
  readonly preparedTransactionHash: string;
  readonly hashingSchemeVersion: number;
  readonly partyId: string;
  readonly publicKeyFingerprint: string;
  /** Microsecond UTC time, as the participant binds it. */
  readonly expiresAt: string;
}

/** Field numbers of interactive_submission_service.proto in Ledger API 3.5.7. */
const PREPARED_METADATA = 2;
const METADATA_SUBMITTER_INFO = 2;
const METADATA_SYNCHRONIZER_ID = 3;
const METADATA_MAX_RECORD_TIME = 11;
const SUBMITTER_ACT_AS = 1;
const SUBMITTER_COMMAND_ID = 2;

/** The signed metadata fields of a PreparedTransaction. */
interface Metadata {
  readonly actAs: readonly string[];
  readonly commandId: string;
  readonly synchronizerId: string;
  readonly maxRecordTime: bigint | undefined;
}

function fields(bytes: Uint8Array, read: (reader: BinaryReader, field: number, wireType: WireType) => boolean): void {
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();
    if (!read(reader, field, wireType)) reader.skip(wireType, field);
  }
}

/** Reads a copy of the metadata; the original bytes are what the participant executes. */
function metadata(encoded: string): Metadata | undefined {
  const bytes = strictBase64(encoded);
  if (!bytes) throw new InvalidRequest('Invalid stored transaction preparation');
  try {
    let metadataBytes: Uint8Array | undefined;
    fields(bytes, (reader, field, wireType) => {
      if (field !== PREPARED_METADATA || wireType !== WireType.LengthDelimited) return false;
      metadataBytes = reader.bytes();
      return true;
    });
    if (metadataBytes === undefined) return undefined;
    const actAs: string[] = [];
    let commandId = '';
    let synchronizerId = '';
    let maxRecordTime: bigint | undefined;
    fields(metadataBytes, (reader, field, wireType) => {
      if (field === METADATA_SUBMITTER_INFO && wireType === WireType.LengthDelimited) {
        fields(reader.bytes(), (submitter, submitterField, submitterWire) => {
          if (submitterWire !== WireType.LengthDelimited) return false;
          if (submitterField === SUBMITTER_ACT_AS) actAs.push(submitter.string());
          else if (submitterField === SUBMITTER_COMMAND_ID) commandId = submitter.string();
          else return false;
          return true;
        });
        return true;
      }
      if (field === METADATA_SYNCHRONIZER_ID && wireType === WireType.LengthDelimited) {
        synchronizerId = reader.string();
        return true;
      }
      if (field === METADATA_MAX_RECORD_TIME && wireType === WireType.Varint) {
        maxRecordTime = BigInt(reader.uint64());
        return true;
      }
      return false;
    });
    return { actAs, commandId, synchronizerId, maxRecordTime };
  } catch (error) {
    throw new InvalidRequest('Invalid stored transaction preparation', { cause: error });
  }
}

/** PV35+ prepares with the physical id `<logical-id>::<protocol-version>-<serial>`. */
export function matchesSynchronizer(prepared: string, logical: string): boolean {
  if (prepared === logical) return true;
  const delimiter = prepared.lastIndexOf('::');
  if (delimiter < 0 || prepared.slice(0, delimiter) !== logical) return false;
  const suffix = prepared.slice(delimiter + 2);
  if (!PHYSICAL_SUFFIX.test(suffix)) return false;
  const [protocol, serial] = suffix.split('-').map(Number);
  return (
    protocol !== undefined &&
    serial !== undefined &&
    protocol <= INT32_MAX &&
    serial <= INT32_MAX &&
    protocol >= PHYSICAL_SYNCHRONIZER_MIN_PROTOCOL
  );
}

function requireSigner(signer: PartyPreparation | null): asserts signer is PartyPreparation {
  if (!signer?.confirmed) throw new InvalidRequest('A confirmed external party is required');
  algorithm(signer.publicKey);
}

function requireFuture(expiresAt: string): void {
  if (BigInt(Date.now()) * 1_000n >= epochMicros(expiresAt))
    throw new InvalidRequest('Transaction preparation has expired');
}

function requireHashingScheme(scheme: number): void {
  if (scheme !== HASHING_SCHEME_V3)
    throw new InvalidRequest('Hashing scheme V3 is required to sign the maximum record time');
}

function requireSubmitter(prepared: Metadata | undefined, signer: PartyPreparation): asserts prepared is Metadata {
  if (
    !prepared ||
    prepared.actAs.length !== 1 ||
    prepared.actAs[0] !== signer.partyId ||
    !matchesSynchronizer(prepared.synchronizerId, signer.synchronizerId)
  ) {
    throw new InvalidRequest('Prepared transaction has a different submitter or synchronizer');
  }
}

function requireDeadline(prepared: Metadata, expiresAt: string): void {
  if (prepared.maxRecordTime !== epochMicros(expiresAt)) {
    throw new InvalidRequest('Participant did not bind the requested maximum record time');
  }
}

/** Validates before claiming durable submission work, so a bad signature never becomes unknown. */
export function verify(stored: Prepared, signature: string, signer: PartyPreparation | null): void {
  requireSigner(signer);
  requireFuture(stored.expiresAt);
  if (stored.partyId !== signer.partyId || stored.publicKeyFingerprint !== signer.publicKeyFingerprint) {
    throw new InvalidRequest('Preparation does not belong to the registered wallet');
  }
  if (strictBase64(stored.preparedTransactionHash)?.length !== HASH_BYTES) {
    throw new InvalidRequest('Expected a 32-byte prepared transaction hash');
  }
  requireHashingScheme(stored.hashingSchemeVersion);
  verifySignature(signer, stored.preparedTransactionHash, signature);
  const prepared = metadata(stored.preparedTransaction);
  requireSubmitter(prepared, signer);
  requireDeadline(prepared, stored.expiresAt);
}

/** Relays a single external party's transaction with its caller token and wallet signature. */
export class InteractiveTransactions {
  constructor(private readonly http: LedgerHttp) {}

  async prepare(
    commandId: string,
    userId: string,
    callerToken: string,
    signer: PartyPreparation | null,
    command: Command,
    disclosures: readonly DisclosedContract[],
    expiresAt: string,
  ): Promise<Prepared> {
    const deadline = truncateToMicros(expiresAt);
    requireSigner(signer);
    requireFuture(deadline);
    if (disclosures.some((disclosure) => disclosure.createdEventBlob === '')) {
      throw new InvalidRequest("Disclosures require the participant's created-event blob");
    }
    const request: Schemas['JsPrepareSubmissionRequest'] = {
      userId,
      commandId,
      commands: [command],
      actAs: [signer.partyId],
      synchronizerId: signer.synchronizerId,
      hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V3',
      disclosedContracts: [...disclosures],
      packageIdSelectionPreference: [DEX_PACKAGE_ID],
      maxRecordTime: deadline,
    };
    const response = record(
      await this.http.call({
        method: 'POST',
        path: '/v2/interactive-submission/prepare',
        token: callerToken,
        timeoutMs: PREPARE_TIMEOUT_MS,
        body: request,
      }),
      'preparation',
    );
    const preparedTransaction = optionalString(response.preparedTransaction, 'preparedTransaction') ?? '';
    const hash = string(response.preparedTransactionHash, 'preparedTransactionHash');
    if (preparedTransaction === '' || Buffer.from(hash, 'base64').length !== HASH_BYTES) {
      throw new Error('Participant returned an invalid transaction preparation');
    }
    const scheme = HASHING_SCHEMES[string(response.hashingSchemeVersion, 'hashingSchemeVersion')] ?? -1;
    requireHashingScheme(scheme);
    const prepared = metadata(preparedTransaction);
    requireSubmitter(prepared, signer);
    requireDeadline(prepared, deadline);
    if (prepared.commandId !== commandId) throw new Error('Participant prepared a different command');
    return {
      preparedTransaction,
      preparedTransactionHash: hash,
      hashingSchemeVersion: scheme,
      partyId: signer.partyId,
      publicKeyFingerprint: signer.publicKeyFingerprint,
      expiresAt: deadline,
    };
  }

  /**
   * Executes the stored preparation with the wallet signature. The `Empty` deduplication period
   * selects the participant's configured maximum. Unknown outcomes belong to the caller's recovery
   * workflow, never to a retry hidden in this adapter.
   */
  async execute(
    submissionId: string,
    stored: Prepared,
    signature: string,
    signer: PartyPreparation,
    callerToken: string,
    userId: string,
  ): Promise<Transaction> {
    verify(stored, signature, signer);
    const ed25519 = algorithm(signer.publicKey) === 'ED25519';
    const request: Schemas['JsExecuteSubmissionAndWaitForTransactionRequest'] = {
      preparedTransaction: stored.preparedTransaction,
      partySignatures: {
        signatures: [
          {
            party: signer.partyId,
            signatures: [
              {
                signature,
                signedBy: signer.publicKeyFingerprint,
                format: ed25519 ? 'SIGNATURE_FORMAT_RAW' : 'SIGNATURE_FORMAT_DER',
                signingAlgorithmSpec: ed25519
                  ? 'SIGNING_ALGORITHM_SPEC_ED25519'
                  : 'SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256',
              },
            ],
          },
        ],
      },
      submissionId,
      userId,
      // The participant requires this field; `Empty` is the unset period of the Ledger API.
      deduplicationPeriod: { Empty: {} },
      hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V3',
      transactionFormat: {
        eventFormat: { filtersByParty: { [signer.partyId]: transactionFilter() }, verbose: true },
        transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
      },
    };
    const response = record(
      await this.http.call({
        method: 'POST',
        path: '/v2/interactive-submission/executeAndWaitForTransaction',
        token: callerToken,
        timeoutMs: EXECUTE_TIMEOUT_MS,
        body: request,
      }),
      'execution',
    );
    return transaction(response.transaction);
  }
}
