import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerHttp } from '../../../src/canton/http.js';
import {
  InteractiveTransactions,
  matchesSynchronizer,
  verify,
  type Prepared,
} from '../../../src/canton/interactive.js';
import { transactionFilter, type Command } from '../../../src/canton/ledger.js';
import { DEX_PACKAGE_ID } from '../../../src/canton/packages.js';
import type { PartyPreparation } from '../../../src/onboarding/model.js';
import { InvalidRequest } from '../../../src/platform/errors.js';
import { at } from '../../support/json.js';
import { fakeParticipant, type FakeParticipant } from '../support/participant.js';

type Algorithm = 'Ed25519' | 'secp256k1';
interface Key {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

const COMMAND: Command = { CreateCommand: { templateId: 'package:Test:Rules', createArguments: {} } };
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function key(algorithm: Algorithm): Key {
  return algorithm === 'Ed25519'
    ? generateKeyPairSync('ed25519')
    : generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
}

function signHash(signing: Key, algorithm: Algorithm, hash: Uint8Array): string {
  return encode(
    algorithm === 'Ed25519'
      ? sign(null, hash, signing.privateKey)
      : sign('sha256', hash, { key: signing.privateKey, dsaEncoding: 'der' }),
  );
}

function signer(signing: Key, party: string, fingerprint: string): PartyPreparation {
  return {
    preparationId: randomUUID(),
    partyId: party,
    confirmed: true,
    publicKey: signing.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    publicKeyFingerprint: fingerprint,
    multiHash: encode(new Uint8Array(34)),
    synchronizerId: 'synchronizer',
    status: 'CONFIRMED',
    participantId: 'participant',
    topologyTransactions: [],
  };
}

const micros = (iso: string) =>
  BigInt(Date.parse(iso.replace(/\.\d+Z$/, 'Z'))) * 1_000n +
  BigInt((/\.(\d+)Z$/.exec(iso)?.[1] ?? '').padEnd(9, '0')) / 1_000n;

/** A PreparedTransaction with its signed metadata and an unknown field the adapter must keep. */
function prepared(party: string, expiresAt: string, synchronizer = 'synchronizer'): Uint8Array {
  const submitter = new BinaryWriter()
    .tag(1, WireType.LengthDelimited)
    .string(party)
    .tag(2, WireType.LengthDelimited)
    .string('command')
    .finish();
  const metadata = new BinaryWriter()
    .tag(2, WireType.LengthDelimited)
    .bytes(submitter)
    .tag(3, WireType.LengthDelimited)
    .string(synchronizer)
    .tag(11, WireType.Varint)
    .uint64(micros(expiresAt))
    .finish();
  return new BinaryWriter()
    .tag(2, WireType.LengthDelimited)
    .bytes(metadata)
    .tag(100, WireType.LengthDelimited)
    .bytes(Buffer.from('opaque-extra'))
    .finish();
}

/** Now plus `seconds`, with nanosecond digits. */
function futureWithNanos(seconds: number): string {
  return new Date((Math.floor(Date.now() / 1_000) + seconds) * 1_000).toISOString().replace('.000Z', '.123456789Z');
}

describe('interactive transactions', () => {
  let participant: FakeParticipant | undefined;
  afterEach(async () => {
    await participant?.close();
    participant = undefined;
  });

  async function roundTrip(algorithm: Algorithm, synchronizer = 'synchronizer'): Promise<void> {
    const signing = key(algorithm);
    const party = signer(signing, 'trader::key', 'fingerprint');
    const hash = randomBytes(32);
    const expiresAt = futureWithNanos(90);
    const normalizedExpiry = expiresAt.replace('.123456789Z', '.123456Z');
    const transaction = prepared(party.partyId, expiresAt, synchronizer);
    let responseScheme = 'HASHING_SCHEME_VERSION_V3';
    participant = await fakeParticipant({
      'POST /v2/interactive-submission/prepare': () => ({
        body: {
          preparedTransaction: encode(transaction),
          preparedTransactionHash: encode(hash),
          hashingSchemeVersion: responseScheme,
        },
      }),
      'POST /v2/interactive-submission/executeAndWaitForTransaction': () => ({
        body: {
          transaction: {
            updateId: 'confirmed-update',
            effectiveAt: normalizedExpiry,
            events: [],
            offset: 9,
            synchronizerId: synchronizer,
            recordTime: normalizedExpiry,
          },
        },
      }),
    });
    const interactive = new InteractiveTransactions(new LedgerHttp(participant.url));
    const disclosure = {
      contractId: 'rules-cid',
      templateId: 'package:Test:Rules',
      createdEventBlob: encode(Buffer.from('participant-event-blob')),
      synchronizerId: 'synchronizer',
    };
    const stored = await interactive.prepare(
      'command',
      'caller-user',
      'prepare-token',
      party,
      COMMAND,
      [disclosure],
      expiresAt,
    );
    expect(stored.preparedTransaction).toBe(encode(transaction));
    expect(stored.preparedTransactionHash).toBe(encode(hash));
    expect(stored.hashingSchemeVersion).toBe(3);
    expect(stored.expiresAt).toBe(normalizedExpiry);
    const signature = signHash(signing, algorithm, hash);
    verify(stored, signature, party);
    const result = await interactive.execute('submission', stored, signature, party, 'fresh-token', 'caller-user');
    expect(result.updateId).toBe('confirmed-update');
    expect(participant.exchanges.map((exchange) => exchange.authorization)).toEqual([
      'Bearer prepare-token',
      'Bearer fresh-token',
    ]);
    const [prepare, execute] = participant.exchanges.map((exchange) => exchange.body);
    expect(at(prepare, 'userId')).toBe('caller-user');
    expect(at(prepare, 'commandId')).toBe('command');
    expect(at(prepare, 'actAs')).toEqual([party.partyId]);
    expect(at(prepare, 'readAs') ?? []).toEqual([]);
    expect(at(prepare, 'disclosedContracts')).toEqual([disclosure]);
    expect(at(prepare, 'minLedgerTime')).toBeUndefined();
    expect(at(prepare, 'maxRecordTime')).toBe(normalizedExpiry);
    expect(at(prepare, 'hashingSchemeVersion')).toBe('HASHING_SCHEME_VERSION_V3');
    expect(at(prepare, 'packageIdSelectionPreference')).toEqual([DEX_PACKAGE_ID]);
    expect(at(execute, 'transactionFormat', 'eventFormat', 'filtersByParty')).toEqual({
      [party.partyId]: transactionFilter(),
    });
    expect(at(execute, 'preparedTransaction')).toBe(encode(transaction));
    expect(at(execute, 'userId')).toBe('caller-user');
    expect(at(execute, 'submissionId')).toBe('submission');
    expect(at(execute, 'hashingSchemeVersion')).toBe('HASHING_SCHEME_VERSION_V3');
    expect(at(execute, 'partySignatures', 'signatures', 0, 'party')).toBe(party.partyId);
    const walletSignature = at(execute, 'partySignatures', 'signatures', 0, 'signatures', 0);
    expect(at(walletSignature, 'signedBy')).toBe(party.publicKeyFingerprint);
    expect(at(walletSignature, 'signature')).toBe(signature);
    expect(at(walletSignature, 'format')).toBe(
      algorithm === 'Ed25519' ? 'SIGNATURE_FORMAT_RAW' : 'SIGNATURE_FORMAT_DER',
    );
    expect(at(walletSignature, 'signingAlgorithmSpec')).toBe(
      algorithm === 'Ed25519' ? 'SIGNING_ALGORITHM_SPEC_ED25519' : 'SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256',
    );

    const executions = () =>
      participant?.exchanges.filter((exchange) => exchange.path.endsWith('executeAndWaitForTransaction'));
    await expect(
      interactive.execute('bad-signature', stored, encode(new Uint8Array(64)), party, 'unused', 'caller-user'),
    ).rejects.toBeInstanceOf(InvalidRequest);
    expect(executions()).toHaveLength(1);
    responseScheme = 'HASHING_SCHEME_VERSION_V2';
    await expect(
      interactive.prepare('command', 'caller-user', 'prepare-token', party, COMMAND, [disclosure], expiresAt),
    ).rejects.toThrow('Hashing scheme V3');
    expect(executions()).toHaveLength(1);
  }

  it('relays fresh caller tokens and the opaque preparation for secp256k1', async () => {
    await roundTrip('secp256k1');
  });

  it('uses a raw Ed25519 signature and preserves the participant hashing scheme', async () => {
    await roundTrip('Ed25519');
  });

  it('preserves the signed transaction bytes on a PV35 physical synchronizer', async () => {
    await roundTrip('secp256k1', 'synchronizer::35-0');
  });

  it('requires the exact logical id and a canonical bounded suffix for a physical synchronizer', () => {
    expect(matchesSynchronizer('synchronizer', 'synchronizer')).toBe(true);
    expect(matchesSynchronizer('synchronizer::35-0', 'synchronizer')).toBe(true);
    expect(matchesSynchronizer('synchronizer::35-12', 'synchronizer')).toBe(true);
    for (const invalid of [
      'other::35-0',
      'synchronizer-extra::35-0',
      'synchronizer::34-0',
      'synchronizer::035-0',
      'synchronizer::35-00',
      'synchronizer::35-',
      'synchronizer::35--1',
      'synchronizer::35-0-extra',
      'synchronizer::35-0::extra',
      'synchronizer::2147483648-0',
      'synchronizer::35-2147483648',
    ]) {
      expect(matchesSynchronizer(invalid, 'synchronizer'), invalid).toBe(false);
    }
  });

  it('rejects a changed key, hash, party or fingerprint, or expired work, before submission', () => {
    const signing = key('secp256k1');
    const party = signer(signing, 'trader::key', 'fingerprint');
    const hash = randomBytes(32);
    const signature = signHash(signing, 'secp256k1', hash);
    const expiresAt = futureWithNanos(90).replace('.123456789Z', '.123456Z');
    const stored: Prepared = {
      preparedTransaction: encode(prepared(party.partyId, expiresAt)),
      preparedTransactionHash: encode(hash),
      hashingSchemeVersion: 3,
      partyId: party.partyId,
      publicKeyFingerprint: party.publicKeyFingerprint,
      expiresAt,
    };
    verify(stored, signature, party);
    const later = new Date(Date.parse(expiresAt) + 1_000).toISOString().replace(/\.(\d{3})Z$/, '.$1456Z');
    expect(() => {
      verify({ ...stored, expiresAt: later }, signature, party);
    }).toThrow('maximum record time');
    expect(() => {
      verify(stored, signature, signer(key('secp256k1'), party.partyId, party.publicKeyFingerprint));
    }).toThrow(InvalidRequest);
    expect(() => {
      verify(stored, signature, signer(signing, 'other-party', party.publicKeyFingerprint));
    }).toThrow(InvalidRequest);
    expect(() => {
      verify(stored, signature, signer(signing, party.partyId, 'other-fingerprint'));
    }).toThrow(InvalidRequest);
    const changed = Buffer.from(hash);
    changed.writeUInt8((changed[0] ?? 0) ^ 1, 0);
    expect(() => {
      verify({ ...stored, preparedTransactionHash: encode(changed) }, signature, party);
    }).toThrow(InvalidRequest);
    expect(() => {
      verify({ ...stored, expiresAt: '1970-01-01T00:00:00.000000Z' }, signature, party);
    }).toThrow(InvalidRequest);
    expect(() => {
      verify({ ...stored, preparedTransaction: encode(prepared('other-party', stored.expiresAt)) }, signature, party);
    }).toThrow(InvalidRequest);
    expect(() => {
      verify({ ...stored, hashingSchemeVersion: 2 }, signature, party);
    }).toThrow(InvalidRequest);
  });
});
