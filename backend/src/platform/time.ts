/** PostgreSQL `timestamptz` text in a UTC session, for example `2026-09-23 10:11:12.1234+00`. */
const POSTGRES_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?\+00$/;

/**
 * The instant form of the baseline API: UTC with `Z`, and a fraction of 0, 3, 6
 * or 9 digits, the fewest that keep the value exact.
 */
function isoInstantText(dateTime: string, nanos: string): string {
  const fraction = nanos.padEnd(9, '0');
  if (/^0{9}$/.test(fraction)) return `${dateTime}Z`;
  if (fraction.endsWith('000000')) return `${dateTime}.${fraction.slice(0, 3)}Z`;
  if (fraction.endsWith('000')) return `${dateTime}.${fraction.slice(0, 6)}Z`;
  return `${dateTime}.${fraction}Z`;
}

/** An RFC 3339 UTC timestamp with up to nanosecond digits, as the participant writes them. */
const RFC3339_UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;

/** Nanoseconds since the epoch of an RFC 3339 UTC timestamp, without JavaScript date truncation. */
export function epochNanos(iso: string): bigint {
  const match = RFC3339_UTC.exec(iso);
  const wholeSecondMillis = match ? Date.parse(`${match[1] ?? ''}Z`) : Number.NaN;
  if (!match || Number.isNaN(wholeSecondMillis)) throw new Error(`Unexpected timestamp ${iso}`);
  return BigInt(wholeSecondMillis) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

export function epochMicros(iso: string): bigint {
  return epochNanos(iso) / NANOS_PER_MICRO;
}

/** The instant with its sub-microsecond digits dropped: the precision of Daml `Time`. */
export function truncateToMicros(iso: string): string {
  const match = RFC3339_UTC.exec(iso);
  if (!match) throw new Error(`Unexpected timestamp ${iso}`);
  return `${match[1] ?? ''}.${(match[2] ?? '').padEnd(9, '0').slice(0, 6)}Z`;
}

/** A JavaScript clock time as a Daml `Time` value. */
export function ledgerTime(epochMillis: number): string {
  return truncateToMicros(new Date(epochMillis).toISOString());
}

/** A database timestamp as the API writes it, with its microseconds. */
export function isoInstant(postgres: string): string {
  const match = POSTGRES_UTC.exec(postgres);
  if (!match) throw new Error(`Unexpected PostgreSQL timestamp ${postgres}`);
  return isoInstantText(`${match[1] ?? ''}T${match[2] ?? ''}`, match[3] ?? '');
}

export const NANOS_PER_MICRO = 1_000n;
const NANOS_PER_MILLI = 1_000_000n;
export const NANOS_PER_SECOND = 1_000_000_000n;
/** The Unix time, in nanoseconds, of this process's high-resolution time origin. */
const ORIGIN_NANOS =
  BigInt(Math.trunc(performance.timeOrigin)) * NANOS_PER_MILLI + BigInt(Math.round((performance.timeOrigin % 1) * 1e6));

/**
 * The current time in nanoseconds, the resolution of the API's timestamps. `Date.now()` has
 * milliseconds only, so the high-resolution time since the process time origin supplies the rest.
 * After a clock step or a suspended host the two disagree, and then the wall clock wins.
 */
export function clockNanos(): bigint {
  const wall = BigInt(Date.now()) * NANOS_PER_MILLI;
  const precise = ORIGIN_NANOS + BigInt(Math.round(performance.now() * 1e6));
  const drift = precise - wall;
  return drift > -NANOS_PER_MILLI && drift < 2n * NANOS_PER_MILLI ? precise : wall;
}

/** A time in nanoseconds since the epoch, as the API writes it (see `isoInstantText`). */
export function instantText(nanos: bigint): string {
  const seconds = new Date(Number(nanos / NANOS_PER_SECOND) * 1_000).toISOString().slice(0, 19);
  return isoInstantText(seconds, String(nanos % NANOS_PER_SECOND).padStart(9, '0'));
}

/** An RFC 3339 UTC timestamp with any fraction, as the API writes it (see `isoInstantText`). */
export function canonicalInstant(iso: string): string {
  return instantText(epochNanos(iso));
}

/** Whether the timestamp is strictly later than the current clock time, at nanosecond precision. */
export function isFuture(iso: string): boolean {
  return epochNanos(iso) > clockNanos();
}
