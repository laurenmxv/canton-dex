/**
 * Exact arithmetic on the decimal strings the venue speaks.
 *
 * A Daml `Decimal` carries 28 integer and 10 fractional digits, which a double
 * cannot hold, so no money here ever becomes a JavaScript number. Everything
 * below works on a scaled integer instead, and the one function that does
 * produce a number says in its own name that it is for drawing.
 */

/** A value of `units / 10 ** scale`. `units` may be negative; `scale` never is. */
export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

/** Optional sign, digits, and at most one fractional group. Nothing else. */
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/**
 * What a Daml `Decimal` can represent, and nothing about how large a venue
 * prices: 28 integer digits, 10 fractional, no sign, and no leading zero to
 * left-pad it, which the venue refuses.
 */
const LEDGER_DECIMAL = /^(?:0|[1-9][0-9]{0,27})(?:\.[0-9]{1,10})?$/;

/** Whether the ledger can carry this text, which the form asks before sending it. */
export function isLedgerDecimal(text: string): boolean {
  return LEDGER_DECIMAL.test(text);
}

/**
 * Reads a decimal string, or null when the text is not one.
 *
 * Returning null rather than throwing is what lets a caller tell a reader that
 * their input is not a number yet, and lets a display fall back to showing a
 * value the venue sent that this app cannot read.
 */
export function parseDecimal(text: string): Decimal | null {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

/** Both values at the larger of their two scales, so they can be combined. */
function aligned(a: Decimal, b: Decimal): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.units * 10n ** BigInt(scale - a.scale),
    b: b.units * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

/** Negative, zero or positive, as a comparator wants it. */
export function compareDecimals(a: Decimal, b: Decimal): number {
  const pair = aligned(a, b);
  if (pair.a < pair.b) return -1;
  return pair.a > pair.b ? 1 : 0;
}

/** Exact, and signed: a smaller reserve after a batch gives a negative result. */
export function subtractDecimals(a: Decimal, b: Decimal): Decimal {
  const pair = aligned(a, b);
  return { units: pair.a - pair.b, scale: pair.scale };
}

/** Exact, at the sum of the two scales, as decimal multiplication defines it. */
export function multiplyDecimals(a: Decimal, b: Decimal): Decimal {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

export function isZero(value: Decimal): boolean {
  return value.units === 0n;
}

/** The number of fractional digits written down, which is what a precision limit bounds. */
export function fractionDigits(value: Decimal): number {
  const text = decimalText(value);
  const point = text.indexOf('.');
  return point === -1 ? 0 : text.length - point - 1;
}

/** Splits a value into its sign and its absolute digits at one scale. */
function digitsOf(value: Decimal): { sign: string; whole: string; fraction: string } {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');
  return {
    sign: negative ? '-' : '',
    whole: value.scale === 0 ? digits : digits.slice(0, digits.length - value.scale),
    fraction: value.scale === 0 ? '' : digits.slice(digits.length - value.scale),
  };
}

/** The plain decimal, with the zeros the ledger pads it with removed. */
export function decimalText(value: Decimal): string {
  const { sign, whole, fraction } = digitsOf(value);
  const kept = fraction.replace(/0+$/, '');
  return `${sign}${whole}${kept === '' ? '' : `.${kept}`}`;
}

/** Rounds half away from zero, which is what a reader expects of a shown figure. */
function roundedFraction(fraction: string, digits: number): { fraction: string; carry: boolean } {
  const padded = fraction.padEnd(digits + 1, '0');
  const kept = padded.slice(0, digits);
  const roundUp = Number(padded[digits]) >= 5;
  if (!roundUp) return { fraction: kept, carry: false };
  if (digits === 0) return { fraction: '', carry: true };
  const raised = (BigInt(kept) + 1n).toString().padStart(digits, '0');
  return raised.length > digits
    ? { fraction: raised.slice(1), carry: true }
    : { fraction: raised, carry: false };
}

function grouped(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface DecimalFormat {
  minFractionDigits?: number;
  maxFractionDigits?: number;
}

/**
 * A decimal string as a reader should see it: grouped thousands, and a bounded
 * number of fractional digits.
 *
 * Text this app cannot read as a decimal comes back untouched, so an
 * unexpected answer from the venue is visible rather than shown as `NaN`.
 */
export function formatDecimal(
  text: string,
  { minFractionDigits = 2, maxFractionDigits = 6 }: DecimalFormat = {},
): string {
  const value = parseDecimal(text);
  if (!value) return text;
  const { sign, whole, fraction } = digitsOf(value);
  const rounded = roundedFraction(fraction, maxFractionDigits);
  const carried = rounded.carry ? (BigInt(whole) + 1n).toString() : whole;
  const shown = rounded.fraction.replace(/0+$/, '').padEnd(minFractionDigits, '0');
  return `${sign}${grouped(carried)}${shown === '' ? '' : `.${shown}`}`;
}

/** A Daml `Decimal` carries ten fractional digits, and no venue amount has more. */
const LEDGER_SCALE = 10;

/**
 * An amount shown to its last digit.
 *
 * What a trader approves, and what the ledger actually paid, must read exactly
 * as the venue sent them: an eight-decimal BTC amount abbreviated to six can
 * show a real holding as nothing. `decimals` narrows this to one instrument's
 * own precision where it is known.
 */
export function formatExact(text: string, decimals: number = LEDGER_SCALE): string {
  return formatDecimal(text, { maxFractionDigits: decimals });
}

/**
 * `value / of`, as a plain number, for plotting only.
 *
 * The result is a coordinate, never an amount a reader is asked to approve.
 * The division happens on scaled integers so that a ratio far below one
 * survives it: two reserves can be orders of magnitude apart, and flooring
 * such a ratio to zero would drop the point off the chart. `10 ** 22` is the
 * largest power of ten a double holds exactly, which keeps simple ratios
 * exact. Null when the denominator is zero.
 */
const RATIO_SCALE = 10n ** 22n;

export function decimalRatio(value: Decimal, of: Decimal): number | null {
  if (of.units === 0n) return null;
  const pair = aligned(value, of);
  return Number((pair.a * RATIO_SCALE) / pair.b) / Number(RATIO_SCALE);
}
