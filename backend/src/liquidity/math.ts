/**
 * The exact counterpart of `Lib.Math` and `Lib.Liquidity` at the ledger's ten-decimal precision.
 * Amounts are bigint units of 10^-10; every product stays within Daml's 38 significant digits.
 */
import { NUMERIC_SCALE } from '../platform/decimal.js';
import { Conflict, InvalidRequest } from '../platform/errors.js';
import { quantum } from '../swaps/math.js';

const UNIT = 10n ** BigInt(NUMERIC_SCALE);
const MAX_NUMERIC = 10n ** 38n - 1n;

/** LP supply locked at initialization, never redeemable: 0.0000001. */
export const MINIMUM_LIQUIDITY = 1_000n;

export interface DepositAmounts {
  readonly base: bigint;
  readonly quote: bigint;
  readonly baseRefund: bigint;
  readonly quoteRefund: bigint;
  readonly lp: bigint;
}

export interface WithdrawalAmounts {
  readonly base: bigint;
  readonly quote: bigint;
  readonly lp: bigint;
}

function checked(value: bigint): bigint {
  if (value < 0n || value > MAX_NUMERIC) {
    throw new Conflict("Amounts exceed the ledger's exact arithmetic range", 'AMOUNT_TOO_LARGE');
  }
  return value;
}

/** The integer square root, rounded down. */
function integerSqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let current = value;
  let next = (current + value / current) / 2n;
  while (next < current) {
    current = next;
    next = (current + value / current) / 2n;
  }
  return current;
}

/** `amount × numerator / denominator` at the token precision, rounded down or up once. */
export function ratio(
  amount: bigint,
  numerator: bigint,
  denominator: bigint,
  decimals: number,
  roundUp: boolean,
): bigint {
  if (decimals < 0 || decimals > NUMERIC_SCALE || denominator <= 0n)
    throw new InvalidRequest('Invalid liquidity ratio');
  const step = quantum(decimals);
  const top = checked(checked(amount) * checked(numerator));
  const bottom = checked(checked(denominator) * step);
  const quotient = top / bottom;
  const result = roundUp && top % bottom !== 0n ? quotient + 1n : quotient;
  return checked(result * step);
}

/** The LP supply of an empty pool's first deposit: the square root of the reserve product. */
export function initialSupply(base: bigint, quote: bigint): bigint {
  return integerSqrt(checked(checked(base) * checked(quote)));
}

/** Initialization at the configured ratio, or proportional shares rounded down with inputs rounded up. */
export function depositAmounts(
  maxBase: bigint,
  maxQuote: bigint,
  initialRatio: bigint,
  baseReserve: bigint,
  quoteReserve: bigint,
  supply: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): DepositAmounts {
  let base: bigint;
  let quote: bigint;
  let shares: bigint;
  if (supply === 0n) {
    const quoted = ratio(maxQuote, UNIT, initialRatio, baseDecimals, false);
    base = maxBase < quoted ? maxBase : quoted;
    quote = ratio(base, initialRatio, UNIT, quoteDecimals, true);
    shares = initialSupply(base, quote) - MINIMUM_LIQUIDITY;
  } else {
    const byBase = ratio(maxBase, supply, baseReserve, NUMERIC_SCALE, false);
    const byQuote = ratio(maxQuote, supply, quoteReserve, NUMERIC_SCALE, false);
    shares = byBase < byQuote ? byBase : byQuote;
    base = ratio(shares, baseReserve, supply, baseDecimals, true);
    quote = ratio(shares, quoteReserve, supply, quoteDecimals, true);
  }
  if (base <= 0n || quote <= 0n || shares <= 0n) {
    throw new Conflict("Deposit is too small at the pool's precision", 'AMOUNT_TOO_SMALL');
  }
  if (base > maxBase || quote > maxQuote)
    throw new Conflict('Deposit exceeds the signed maximum amounts', 'DEPOSIT_LIMIT');
  return { base, quote, baseRefund: maxBase - base, quoteRefund: maxQuote - quote, lp: shares };
}

/** A redemption rounded down to each token's precision; the permanent minimum stays in the pool. */
export function withdrawalAmounts(
  lp: bigint,
  baseReserve: bigint,
  quoteReserve: bigint,
  supply: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): WithdrawalAmounts {
  if (supply <= 0n || lp > supply - MINIMUM_LIQUIDITY) {
    throw new Conflict('Withdrawal exceeds circulating LP supply', 'INSUFFICIENT_LP');
  }
  const base = ratio(lp, baseReserve, supply, baseDecimals, false);
  const quote = ratio(lp, quoteReserve, supply, quoteDecimals, false);
  if (base <= 0n || quote <= 0n)
    throw new Conflict('Withdrawal is too small at the token precision', 'AMOUNT_TOO_SMALL');
  return { base, quote, lp };
}

/** The pool ratio `quote / base` lies within the signed bounds. */
export function requireRatio(base: bigint, quote: bigint, min: bigint, max: bigint): void {
  const scaledQuote = checked(checked(quote) * UNIT);
  const lower = checked(checked(base) * checked(min));
  const upper = checked(checked(base) * checked(max));
  if (scaledQuote < lower || scaledQuote > upper) {
    throw new Conflict('Pool ratio is outside the signed bounds', 'RATIO_LIMIT');
  }
}
