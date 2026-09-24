/**
 * Narrowing of participant JSON. A payload that does not have the documented shape fails
 * loudly; it never becomes an empty value.
 */
export type JsonRecord = Readonly<Record<string, unknown>>;

function unexpected(what: string): Error {
  return new Error(`Unexpected participant response: ${what}`);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown, what: string): JsonRecord {
  if (!isRecord(value)) throw unexpected(`${what} is not an object`);
  return value;
}

export function string(value: unknown, what: string): string {
  if (typeof value !== 'string') throw unexpected(`${what} is not a string`);
  return value;
}

export function optionalString(value: unknown, what: string): string | undefined {
  return value === undefined || value === null ? undefined : string(value, what);
}

export function integer(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw unexpected(`${what} is not an integer`);
  return value;
}

const INT64_MAX = 2n ** 63n - 1n;

/** A ledger offset: a non-negative int64, exact over its full range. */
export function offset(value: unknown, what: string): bigint {
  const exact = typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value;
  if (typeof exact !== 'bigint' || exact < 0n || exact > INT64_MAX) throw unexpected(`${what} is not an offset`);
  return exact;
}

export function boolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw unexpected(`${what} is not a boolean`);
  return value;
}

export function array<T>(value: unknown, what: string, item: (element: unknown, what: string) => T): T[] {
  if (!Array.isArray(value)) throw unexpected(`${what} is not an array`);
  return value.map((element, index) => item(element, `${what}[${String(index)}]`));
}

/** A repeated protobuf field, which the JSON API omits when it is empty. */
export function repeated<T>(value: unknown, what: string, item: (element: unknown, what: string) => T): T[] {
  return value === undefined || value === null ? [] : array(value, what, item);
}

export function strings(value: unknown, what: string): string[] {
  return repeated(value, what, string);
}
