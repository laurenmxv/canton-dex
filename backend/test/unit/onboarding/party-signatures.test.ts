import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { suggestHint, validateReview, type PartyPreparation } from '../../../src/onboarding/model.js';
import { algorithm, requirePublicKey, verify, verifyTopology } from '../../../src/onboarding/signatures.js';
import { InvalidRequest } from '../../../src/platform/errors.js';

interface Key {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const spki = (key: Key) => key.publicKey.export({ type: 'spki', format: 'der' });

function ecKey(curve: string): Key {
  return generateKeyPairSync('ec', { namedCurve: curve });
}

function ecSign(key: Key, hash: Uint8Array): string {
  return encode(sign('sha256', hash, { key: key.privateKey, dsaEncoding: 'der' }));
}

function preparation(key: Key, hash: Uint8Array): PartyPreparation {
  return {
    preparationId: randomUUID(),
    partyId: 'david::fingerprint',
    confirmed: false,
    publicKey: encode(spki(key)),
    publicKeyFingerprint: 'fingerprint',
    multiHash: encode(hash),
    synchronizerId: 'synchronizer',
    status: 'PREPARED',
    participantId: 'participant::test',
    topologyTransactions: [],
  };
}

describe('party signatures', () => {
  it('signs a transaction with its explicit hash instead of the onboarding multihash', () => {
    const key = ecKey('secp256k1');
    const party = preparation(key, randomBytes(34));
    const transactionHash = randomBytes(32);
    const signature = ecSign(key, transactionHash);
    verify(party, encode(transactionHash), signature);
    expect(() => {
      verifyTopology(party, signature);
    }).toThrow(InvalidRequest);
    expect(() => {
      verify(party, encode(transactionHash), ecSign(key, createHash('sha256').update(transactionHash).digest()));
    }).toThrow(InvalidRequest);
  });

  it('verifies a secp256k1 DER signature over the original multihash exactly once', () => {
    const key = ecKey('secp256k1');
    const hash = randomBytes(34);
    hash.writeUInt8(0x12, 0);
    hash.writeUInt8(0x20, 1);
    const party = preparation(key, hash);
    expect(algorithm(party.publicKey)).toBe('SECP256K1');
    const signature = ecSign(key, hash);
    verifyTopology(party, signature);
    expect(() => {
      verifyTopology(preparation(ecKey('secp256k1'), hash), signature);
    }).toThrow(InvalidRequest);
    expect(() => {
      verifyTopology(party, ecSign(key, createHash('sha256').update(hash).digest()));
    }).toThrow(InvalidRequest);
    expect(() => {
      verifyTopology(party, encode(new Uint8Array(64)));
    }).toThrow(InvalidRequest);
    const trailing = Buffer.concat([Buffer.from(signature, 'base64'), Buffer.alloc(1)]);
    expect(() => {
      verifyTopology(party, encode(trailing));
    }).toThrow(InvalidRequest);
    hash.writeUInt8((hash[2] ?? 0) ^ 1, 2);
    expect(() => {
      verifyTopology(preparation(key, hash), signature);
    }).toThrow(InvalidRequest);
  });

  it('rejects an unsupported curve and malformed SPKI', () => {
    expect(() => {
      requirePublicKey(encode(spki(ecKey('prime256v1'))));
    }).toThrow(InvalidRequest);
    const der = spki(ecKey('secp256k1'));
    for (const encoded of [
      'not-base64',
      '',
      encode(Buffer.concat([der, Buffer.alloc(1)])),
      encode(der.subarray(0, der.length - 1)),
    ]) {
      expect(() => {
        requirePublicKey(encoded);
      }, encoded).toThrow(InvalidRequest);
    }
  });

  it('binds the signature to the prepared key and the exact hash', () => {
    const key = generateKeyPairSync('ed25519');
    const hash = randomBytes(32);
    const party = preparation(key, hash);
    const signed = encode(sign(null, hash, key.privateKey));
    verifyTopology(party, signed);
    expect(() => {
      verifyTopology(party, encode(new Uint8Array(64)));
    }).toThrow(InvalidRequest);
    hash.writeUInt8((hash[0] ?? 0) ^ 1, 0);
    expect(() => {
      verifyTopology({ ...party, multiHash: encode(hash) }, signed);
    }).toThrow(InvalidRequest);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => {
      requirePublicKey(encode(spki(rsa)));
    }).toThrow(InvalidRequest);
  });

  it('suggests valid ASCII and bounded party hints', () => {
    expect(suggestHint('Dávid Pérez')).toBe('dex_david_perez');
    expect(suggestHint('Acme Trading Ltd')).toBe('dex_acme_trading_ltd');
    expect(suggestHint('123')).toBe('dex_123');
    expect(suggestHint('名字')).toBe('dex_trader');
    expect(suggestHint('a'.repeat(120))).toHaveLength(64);
    for (const name of ['123', '名字', 'a'.repeat(120), '- _ ?']) {
      validateReview({ decision: 'APPROVED', approvedPoolIds: ['pool'], partyHint: suggestHint(name) });
    }
  });

  it('keeps the dex_ prefix and a valid bounded name in approved hints', () => {
    for (const hint of [
      'david_perez',
      'dex',
      'dex_',
      'dex__',
      'DEX_david',
      'dex_Dávid',
      'dex_bad name',
      `dex_${'a'.repeat(61)}`,
    ]) {
      expect(() => {
        validateReview({ decision: 'APPROVED', approvedPoolIds: ['pool'], partyHint: hint });
      }, hint).toThrow(InvalidRequest);
    }
    expect(() => {
      validateReview({ decision: 'APPROVED', approvedPoolIds: ['pool'], partyHint: null });
    }).toThrow(InvalidRequest);
    validateReview({ decision: 'REJECTED', approvedPoolIds: [], partyHint: null });
  });
});
