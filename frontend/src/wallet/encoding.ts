/**
 * Conversions between what the Snap speaks and what the venue's API stores.
 *
 * The Snap talks in hex; the API stores base64, so most of this only changes
 * how the same bytes are written down. The one exception reads the algorithm
 * out of a public key. Nothing here hashes, signs, or parses a topology
 * transaction.
 */

export function stripHexPrefix(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
}

/** Rejects anything that is not an even-length run of hex digits. */
export function hexToBytes(value: string): Uint8Array {
  const hex = stripHexPrefix(value.trim());
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new RangeError('Expected an even-length hexadecimal string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function hexToBase64(value: string): string {
  return bytesToBase64(hexToBytes(value));
}

/** The Snap wants the multihash as hex, exactly as the venue prepared it. */
export function base64ToHex(value: string): string {
  return bytesToHex(base64ToBytes(value));
}

/**
 * Which signature scheme a stored public key belongs to, read from the OID in
 * its DER SubjectPublicKeyInfo.
 *
 * The venue accepts both: Ed25519 from the historical offline script, and
 * secp256k1 from the Snap. Only the key itself says which, so this is what
 * decides whether a wallet can sign a preparation at all.
 */
export type KeyAlgorithm = 'ed25519' | 'secp256k1' | 'unknown';

/** 1.3.101.112, the Ed25519 algorithm identifier. */
const ED25519_OID = '06032b6570';
/** 1.2.840.10045.2.1, id-ecPublicKey, which the Snap pairs with secp256k1. */
const EC_PUBLIC_KEY_OID = '06072a8648ce3d0201';

export function keyAlgorithm(publicKeyBase64: string): KeyAlgorithm {
  let hex: string;
  try {
    hex = bytesToHex(base64ToBytes(publicKeyBase64));
  } catch {
    return 'unknown';
  }
  if (hex.includes(ED25519_OID)) return 'ed25519';
  if (hex.includes(EC_PUBLIC_KEY_OID)) return 'secp256k1';
  return 'unknown';
}
