/**
 * Request decoding with the rules of the baseline API. Each reader answers a missing or null
 * field with null, coerces scalars as the baseline did, and throws InvalidRequest for a shape
 * the baseline rejected. Route validators then apply the field constraints.
 */
import type { FastifyRequest } from 'fastify';
import { asciiDigits } from './decimal.js';
import { InvalidRequest } from './errors.js';
import { NANOS_PER_SECOND } from './time.js';

/** A JSON number with its source literal, so no digit is lost before validation. */
export class JsonNumber {
  constructor(readonly literal: string) {}
}

export type JsonObject = Readonly<Record<string, unknown>>;

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const STRICT_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const INTEGER = /^[+-]?\d+$/;
const DIGITS = /^\d+$/;
const SPACE = 0x20;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT32_MIN = -(2n ** 31n);
const INT32_MAX = 2n ** 31n - 1n;
const MAX_PAGE_SIZE = 100;
/**
 * An ISO 8601 timestamp: a date, `T` or `t`, a time with seconds, a fraction of up to nine digits,
 * then `Z`, `z` or an offset `±hh:mm` with optional seconds.
 */
const OFFSET_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:[Zz]|([+-])(\d{2}):(\d{2})(?::(\d{2}))?)$/;
/** Epoch seconds with an optional nanosecond fraction, as a number or digit text. */
const EPOCH_SECONDS = /^(-?)(\d+)(?:\.(\d{1,9}))?$/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof JsonNumber);
}

/** Parses JSON, keeping each number's literal. */
export function parseJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source: string }) =>
    typeof value === 'number' && context ? new JsonNumber(context.source) : value,
  );
}

/** A field that stored JSON must have; `stored` reports its absence as invalid stored data. */
export function present<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`Missing ${field}`);
  return value;
}

/** Reads JSON that a store wrote. A value it cannot read is a server error, not a bad request. */
export function stored<T>(column: string, json: string, read: (value: unknown) => T | null): T {
  try {
    const value = read(parseJson(json));
    if (value !== null) return value;
  } catch (error) {
    throw new Error(`Stored ${column} is invalid`, { cause: error });
  }
  throw new Error(`Stored ${column} is missing`);
}

/** The baseline reads `application/json` and `application/*+json` bodies. */
function isJsonMediaType(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || /^application\/[^/]+\+json$/.test(mediaType);
}

/**
 * The JSON object body of a route. As in the baseline, a missing or non-JSON content type is an
 * unexpected failure (500), and an empty, malformed or non-object body is invalid (400).
 */
export function readJsonObject(request: FastifyRequest): JsonObject {
  const contentType = request.headers['content-type'];
  if (!isJsonMediaType(contentType)) {
    throw new Error(`Content type '${contentType ?? ''}' is not supported`);
  }
  const body = request.body;
  if (!(body instanceof Buffer) || body.length === 0) throw new InvalidRequest('Required request body is missing');
  let value: unknown;
  try {
    value = parseJson(UTF8.decode(body));
  } catch {
    throw new InvalidRequest('Malformed JSON request body');
  }
  if (!isObject(value)) throw new InvalidRequest('The request body must be a JSON object');
  return value;
}

export function object(value: unknown): JsonObject | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new InvalidRequest('Expected a JSON object');
  return value;
}

export function list<T>(value: unknown, item: (element: unknown) => T): T[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new InvalidRequest('Expected a JSON array');
  return value.map(item);
}

/** A string field. The baseline also accepts a number or a boolean as its source text. */
export function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (value instanceof JsonNumber) return value.literal;
  if (typeof value === 'boolean') return String(value);
  throw new InvalidRequest('Expected a string');
}

/**
 * A 64-bit integer field: an integer literal or an integer string, exact over the signed int64 range.
 * Fractions and values beyond int64 are rejected; field constraints apply to the exact value.
 */
export function long(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  const literal = value instanceof JsonNumber ? value.literal : typeof value === 'string' ? value.trim() : undefined;
  if (literal === undefined || !INTEGER.test(literal)) throw new InvalidRequest('Expected an integer');
  const parsed = BigInt(literal);
  if (parsed < INT64_MIN || parsed > INT64_MAX) throw new InvalidRequest('Integer out of range');
  return parsed;
}

/** A 32-bit integer field: a 64-bit integer field within the signed int32 range. */
export function int(value: unknown): number | null {
  const parsed = long(value);
  if (parsed === null) return null;
  if (parsed < INT32_MIN || parsed > INT32_MAX) throw new InvalidRequest('Integer out of range');
  return Number(parsed);
}

function isoNanos(match: RegExpExecArray): bigint {
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = match.slice(1, 7).map(Number);
  // An offset group that did not match is undefined at run time.
  const [offsetHours = 0, offsetMinutes = 0, offsetSeconds = 0] = match
    .slice(9, 12)
    .map((part: string | undefined) => Number(part ?? 0));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 18 ||
    offsetMinutes > 59 ||
    offsetSeconds > 59
  ) {
    throw new InvalidRequest('Invalid instant');
  }
  const offset = BigInt(offsetHours * 3600 + offsetMinutes * 60 + offsetSeconds) * (match[8] === '-' ? -1n : 1n);
  const seconds = BigInt(date.getTime() / 1000) + BigInt(hour * 3600 + minute * 60 + second) - offset;
  return seconds * NANOS_PER_SECOND + BigInt((match[7] ?? '').padEnd(9, '0'));
}

function epochSecondNanos(text: string): bigint | undefined {
  const match = EPOCH_SECONDS.exec(text);
  if (!match) return undefined;
  const nanos = BigInt(match[2] ?? '0') * NANOS_PER_SECOND + BigInt((match[3] ?? '').padEnd(9, '0'));
  return match[1] === '-' ? -nanos : nanos;
}

/** An ISO 8601 timestamp with an offset, as nanoseconds since the epoch. */
export function parseInstant(textValue: string): bigint {
  const match = OFFSET_TIMESTAMP.exec(textValue);
  if (!match) throw new InvalidRequest('Expected an instant');
  return isoNanos(match);
}

/**
 * A timestamp field, in nanoseconds since the epoch: ISO 8601 text with any offset, or epoch seconds
 * with up to nine fraction digits, as a number or as digit text.
 */
export function instant(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  if (value instanceof JsonNumber || typeof value === 'string') {
    const literal = value instanceof JsonNumber ? value.literal : value;
    const epoch = epochSecondNanos(literal);
    if (epoch !== undefined) return epoch;
    if (typeof value === 'string') return parseInstant(value);
  }
  throw new InvalidRequest('Expected an instant');
}

/** An optional `+` or `-`, then decimal digits of any Unicode script, within the signed 32-bit range. */
export function parseInt32(textValue: string): number {
  if (!/^[+-]?\p{Nd}+$/u.test(textValue)) throw new InvalidRequest('Expected an integer');
  const digits = BigInt(asciiDigits(textValue.replace(/^[+-]/, '')));
  const parsed = textValue.startsWith('-') ? -digits : digits;
  if (parsed < INT32_MIN || parsed > INT32_MAX) throw new InvalidRequest('Integer out of range');
  return Number(parsed);
}

/** A history page holds 1 to 100 items. */
export function requirePageSize(limit: number): void {
  if (limit < 1 || limit > MAX_PAGE_SIZE) throw new InvalidRequest('Invalid page size');
}

/** The first value of a query parameter, or null when the request has none. */
export function queryParam(request: FastifyRequest, name: string): string | null {
  const start = request.url.indexOf('?');
  return new URLSearchParams(start < 0 ? '' : request.url.slice(start + 1)).get(name);
}

/** A boolean field. The baseline also coerces "true"/"false" and integers (0 is false). */
export function bool(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
  if (value instanceof JsonNumber && INTEGER.test(value.literal)) return BigInt(value.literal) !== 0n;
  throw new InvalidRequest('Expected a boolean');
}

function formatUuid(hex: string): string {
  const value = hex.toLowerCase();
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** A UUID body field, in the strict 36-character form or as 24 characters of Base64. */
export function uuid(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new InvalidRequest('Expected a UUID');
  if (STRICT_UUID.test(value)) return value.toLowerCase();
  if (value.length === 24) {
    const bytes = strictBase64(value);
    if (bytes?.length === 16) return formatUuid(bytes.toString('hex'));
  }
  throw new InvalidRequest('Expected a UUID');
}

/** An enum field: an exact constant name, or its ordinal index. */
export function enumeration<T extends string>(value: unknown, names: readonly T[]): T | null {
  if (value === undefined || value === null) return null;
  const byName = names.find((name) => name === value);
  if (byName !== undefined) return byName;
  const index =
    value instanceof JsonNumber ? value.literal : typeof value === 'string' && DIGITS.test(value) ? value : undefined;
  const ordinal = index !== undefined && INTEGER.test(index) ? names[Number(index)] : undefined;
  if (ordinal === undefined) throw new InvalidRequest('Unknown enum constant');
  return ordinal;
}

function parseHexInt64(textValue: string): bigint {
  if (!/^[+-]?[0-9a-fA-F]+$/.test(textValue)) throw new InvalidRequest('Invalid UUID string');
  const magnitude = BigInt(`0x${textValue.replace(/^[+-]/, '')}`);
  const parsed = textValue.startsWith('-') ? -magnitude : magnitude;
  if (parsed < INT64_MIN || parsed > INT64_MAX) throw new InvalidRequest('Invalid UUID string');
  return parsed;
}

/**
 * A UUID path value, parsed as the baseline did: five dash-separated hexadecimal components,
 * each truncated to its field width. The result is the canonical lowercase form.
 */
export function pathUuid(value: string): string {
  const parts = value.split('-');
  if (value.length > 36 || parts.length !== 5) throw new InvalidRequest('Invalid UUID string');
  const widths = [8, 4, 4, 4, 12];
  return parts
    .map((part, index) => {
      const width = widths[index] ?? 0;
      const mask = (1n << BigInt(width * 4)) - 1n;
      return (parseHexInt64(part) & mask).toString(16).padStart(width, '0');
    })
    .join('-');
}

/** Strict Base64 decoding: the standard alphabet, with optional but never misplaced padding. */
export function strictBase64(value: string): Buffer | undefined {
  const valid = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(value);
  return valid ? Buffer.from(value, 'base64') : undefined;
}

/** Strict Base64 decoding of the URL-safe alphabet, with the same padding rules. */
export function strictBase64Url(value: string): Buffer | undefined {
  const valid = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}(?:==)?|[A-Za-z0-9_-]{3}=?)?$/.test(value);
  return valid ? Buffer.from(value, 'base64url') : undefined;
}

/**
 * The not-blank constraint. Its trim drops the characters up to U+0020 at both ends, so a value
 * is blank unless it has a character above U+0020.
 */
export function notBlank(value: string | null): value is string {
  if (value === null) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > SPACE) return true;
  }
  return false;
}

/**
 * Whitespace other than a no-break space, for a UTF-16 code unit: U+0009 to U+000D, U+001C to
 * U+0020, and the Unicode space, line and paragraph separators except U+00A0, U+2007 and U+202F.
 * Every such character is in the Basic Multilingual Plane.
 */
export function isBreakingWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x20) ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a && code !== 0x2007) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Whether the text is empty or holds only breaking whitespace (`isBreakingWhitespace`). */
export function onlyWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!isBreakingWhitespace(value.charCodeAt(index))) return false;
  }
  return true;
}
