/**
 * Daml `Numeric 10` values as exact bigint units of 10^-10. No floating point is involved; a
 * value with more than ten fraction digits is rejected, never rounded.
 */
export const NUMERIC_SCALE = 10;
const UNIT = 10n ** BigInt(NUMERIC_SCALE);
const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

export function numericUnits(text: string): bigint {
  const match = DECIMAL.exec(text);
  const fraction = match?.[3] ?? '';
  if (!match || fraction.length > NUMERIC_SCALE) throw new Error(`Not a Numeric 10 value: ${text}`);
  const units = BigInt(match[2] ?? '0') * UNIT + BigInt(fraction.padEnd(NUMERIC_SCALE, '0'));
  return match[1] ? -units : units;
}

/** The plain scale-10 text of the baseline API, for example `5.0000000000`. */
export function numericText(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const magnitude = units < 0n ? -units : units;
  return `${sign}${String(magnitude / UNIT)}.${String(magnitude % UNIT).padStart(NUMERIC_SCALE, '0')}`;
}

/** The plain text of `value × 10^-scale` without trailing fractional zeros. */
export function plainText(value: bigint, scale: number): string {
  const sign = value < 0n ? '-' : '';
  const digits = String(value < 0n ? -value : value).padStart(scale + 1, '0');
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return `${sign}${digits.slice(0, digits.length - scale)}${fraction === '' ? '' : `.${fraction}`}`;
}

/** The baseline's trimmed text, without trailing fractional zeros: `0.1`, `10000` or `0`. */
export function trimmedText(units: bigint): string {
  return plainText(units, NUMERIC_SCALE);
}

/** Exact value equality of two Numeric 10 texts, whatever their number of fraction digits. */
export function sameNumeric(left: string, right: string): boolean {
  return numericUnits(left) === numericUnits(right);
}

function scaledUnits(text: string, scale: number): bigint {
  const match = DECIMAL.exec(text);
  if (!match) throw new Error(`Not a decimal value: ${text}`);
  const units = BigInt((match[2] ?? '0') + (match[3] ?? '').padEnd(scale, '0'));
  return match[1] ? -units : units;
}

/** The exact order of two plain decimal texts of any scale, such as invariants. */
export function compareDecimal(left: string, right: string): number {
  const scale = Math.max(DECIMAL.exec(left)?.[3]?.length ?? 0, DECIMAL.exec(right)?.[3]?.length ?? 0);
  const difference = scaledUnits(left, scale) - scaledUnits(right, scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** `left / right` at scale 10, rounded toward negative infinity. */
export function divideFloor(left: bigint, right: bigint): bigint {
  if (right === 0n) throw new Error('Division by zero');
  const scaled = left * UNIT;
  const quotient = scaled / right;
  return quotient * right === scaled || scaled < 0n === right < 0n ? quotient : quotient - 1n;
}

/** `left / right` at scale 10, rounded half away from zero. */
export function divideHalfUp(left: bigint, right: bigint): bigint {
  if (right === 0n) throw new Error('Division by zero');
  const numerator = (left < 0n ? -left : left) * UNIT;
  const divisor = right < 0n ? -right : right;
  const quotient = (2n * numerator + divisor) / (2n * divisor);
  return left < 0n !== right < 0n ? -quotient : quotient;
}

/**
 * A decimal literal: an optional sign, integer digits, a fraction after `.` and an exponent after
 * `e` or `E`, with digits of any Unicode script.
 */
const DECIMAL_LITERAL = /^([+-]?)(\p{Nd}*)(?:\.(\p{Nd}*))?(?:[eE]([+-]?)(\p{Nd}+))?$/u;
const INT32_MIN = -(2n ** 31n);
const INT32_MAX = 2n ** 31n - 1n;
/** An exponent has at most ten digits after its leading zeros. */
const MAX_EXPONENT_DIGITS = 10;

/** ASCII digits for Unicode decimal digits, which Unicode encodes in contiguous runs of 0 to 9. */
export function asciiDigits(text: string): string {
  return Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;
    let zero = code;
    while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
    return String((code - zero) % 10);
  }).join('');
}

/** `unscaled × 10^-scale` as plain text: no exponent, and the scale's trailing zeros are kept. */
function plainString(unscaled: bigint, scale: number): string {
  if (unscaled === 0n) return scale > 0 ? `0.${'0'.repeat(scale)}` : '0';
  const sign = unscaled < 0n ? '-' : '';
  const digits = String(unscaled < 0n ? -unscaled : unscaled);
  if (scale <= 0) return `${sign}${digits}${'0'.repeat(-scale)}`;
  const padded = digits.padStart(scale + 1, '0');
  return `${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

/**
 * The exact plain text of a decimal literal, which may have a sign, a fraction and an exponent. The
 * scale is the number of fraction digits minus the exponent and must fit in 32 signed bits. For
 * example, `1E3` is `1000` and `2.50` stays `2.50`.
 */
export function decimalLiteralPlainText(literal: string): string {
  const match = DECIMAL_LITERAL.exec(literal);
  const [, sign = '', whole = '', fraction = '', exponentSign = '', exponentDigits = '0'] = match ?? [];
  const significantExponent = asciiDigits(exponentDigits).replace(/^0+(?=.)/, '');
  if (!match || whole.length + fraction.length === 0 || significantExponent.length > MAX_EXPONENT_DIGITS) {
    throw new Error(`Not a decimal number: ${literal}`);
  }
  const exponent = BigInt(significantExponent) * (exponentSign === '-' ? -1n : 1n);
  const scale = BigInt(Array.from(fraction).length) - exponent;
  if (scale < INT32_MIN || scale > INT32_MAX) throw new Error(`Decimal scale out of range: ${literal}`);
  const unscaled = BigInt(asciiDigits(whole + fraction));
  return plainString(sign === '-' ? -unscaled : unscaled, Number(scale));
}
