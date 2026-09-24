import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { InvalidRequest } from '../platform/errors.js';
import { strictBase64 } from '../platform/request.js';
import type { PartyPreparation } from './model.js';

export type Algorithm = 'ED25519' | 'SECP256K1';

const ED25519_SIGNATURE_BYTES = 64;
const DER_SIGNATURE_MIN_BYTES = 8;
const DER_SIGNATURE_MAX_BYTES = 72;

interface ParsedKey {
  readonly key: KeyObject;
  readonly algorithm: Algorithm;
}

function algorithmOf(key: KeyObject): Algorithm | undefined {
  if (key.asymmetricKeyType === 'ed25519') return 'ED25519';
  if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'secp256k1') return 'SECP256K1';
  return undefined;
}

/**
 * The wallet's SPKI public key, Ed25519 or secp256k1 only. The encoding must be canonical: the
 * re-encoded key, with an uncompressed secp256k1 point, equals the submitted bytes.
 */
function parse(encoded: string): ParsedKey {
  const invalid = new InvalidRequest('Expected canonical Ed25519 or secp256k1 SPKI public key');
  const der = strictBase64(encoded);
  if (!der || der.length === 0) throw invalid;
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw invalid;
  }
  const algorithm = algorithmOf(key);
  const canonical = createPublicKey({ key: key.export({ format: 'jwk' }), format: 'jwk' }).export({
    format: 'der',
    type: 'spki',
  });
  if (!algorithm || !canonical.equals(der)) throw invalid;
  return { key, algorithm };
}

export function algorithm(encoded: string): Algorithm {
  return parse(encoded).algorithm;
}

/** Validates the wallet key when it is prepared. */
export function requirePublicKey(encoded: string): void {
  parse(encoded);
}

/**
 * Verifies a wallet signature over the participant's exact hash, with the key bound during
 * onboarding. Ed25519 signs the hash bytes; secp256k1 signs SHA-256 of them in DER form.
 */
export function verify(party: PartyPreparation, expectedHash: string, encoded: string): void {
  const invalid = new InvalidRequest('Invalid preparation signature');
  const signature = strictBase64(encoded);
  const hash = strictBase64(expectedHash);
  let parsed: ParsedKey;
  try {
    parsed = parse(party.publicKey);
  } catch {
    throw invalid;
  }
  const ed25519 = parsed.algorithm === 'ED25519';
  if (
    !signature ||
    !hash ||
    (ed25519
      ? signature.length !== ED25519_SIGNATURE_BYTES
      : signature.length < DER_SIGNATURE_MIN_BYTES || signature.length > DER_SIGNATURE_MAX_BYTES)
  ) {
    throw invalid;
  }
  let valid: boolean;
  try {
    valid = ed25519
      ? verifySignature(null, hash, parsed.key, signature)
      : verifySignature('sha256', hash, { key: parsed.key, dsaEncoding: 'der' }, signature);
  } catch {
    throw invalid;
  }
  if (!valid) throw invalid;
}

/** Verifies the signature over the onboarding topology multihash. */
export function verifyTopology(party: PartyPreparation, encoded: string): void {
  verify(party, party.multiHash, encoded);
}
