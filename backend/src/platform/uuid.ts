import { createHash } from 'node:crypto';

/**
 * A name-based version 3 UUID without a namespace: the MD5 of the name's UTF-8 bytes, with the
 * version and variant bits set.
 */
export function nameUuid(name: string): string {
  const bytes = createHash('md5').update(name, 'utf8').digest();
  bytes.writeUInt8(((bytes[6] ?? 0) & 0x0f) | 0x30, 6);
  bytes.writeUInt8(((bytes[8] ?? 0) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
