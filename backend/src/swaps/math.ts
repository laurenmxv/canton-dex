/**
 * The exact counterpart of `Lib.Math.swapOutputAtScale`. Amounts are bigint units of 10^-10,
 * the precision of Daml `Decimal`.
 */
import { NUMERIC_SCALE, numericUnits } from '../platform/decimal.js';
import { InvalidRequest } from '../platform/errors.js';

/** Basis points in one whole. */
export const BPS = 10_000n;
const UNIT = 10n ** BigInt(NUMERIC_SCALE);
/** A plain amount: at most 28 integer digits without a leading zero, and ten fraction digits. */
const PLAIN_AMOUNT = /^(?:0|[1-9][0-9]{0,27})(?:\.[0-9]{1,10})?$/;

/** The size of one token quantum at `decimals` precision, in units. */
export function quantum(decimals: number): bigint {
  return 10n ** BigInt(NUMERIC_SCALE - decimals);
}

/** A plain decimal amount in units; positive unless zero is allowed. */
export function plainAmount(text: string | null, allowZero: boolean): bigint {
  if (text === null || !PLAIN_AMOUNT.test(text)) throw new InvalidRequest('Invalid amount');
  const units = numericUnits(text);
  if (units < (allowZero ? 0n : 1n)) throw new InvalidRequest('Amount must be positive');
  return units;
}

/** A plain amount that the token's precision can represent exactly. */
export function tokenAmount(text: string, decimals: number, allowZero: boolean): bigint {
  if (!PLAIN_AMOUNT.test(text)) {
    throw new InvalidRequest('Use a plain decimal amount with at most 28 integer and ten fractional digits');
  }
  const units = numericUnits(text);
  if (units < (allowZero ? 0n : 1n) || units % quantum(decimals) !== 0n) {
    throw new InvalidRequest('Amount must be positive and fit the token precision');
  }
  return units;
}

/** `value` rounded down to a multiple of the token quantum. */
export function floorTo(value: bigint, decimals: number): bigint {
  const step = quantum(decimals);
  return (value / step) * step;
}

/** The output of a swap after the input fee, rounded down to the output token's precision. */
export function swapOutput(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  feeBps: bigint,
  outputDecimals: number,
): bigint {
  if (
    outputDecimals < 0 ||
    outputDecimals > NUMERIC_SCALE ||
    feeBps < 0n ||
    feeBps >= BPS * UNIT ||
    feeBps % UNIT !== 0n
  ) {
    throw new InvalidRequest('Unsupported pool fee or token precision');
  }
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) throw new InvalidRequest('Pool amounts must be positive');
  const effective = amountIn * (BPS - feeBps / UNIT);
  return floorTo((reserveOut * effective) / (reserveIn * BPS + effective), outputDecimals);
}

/** The signed minimum for a slippage tolerance, rounded down to the token precision. */
export function minimumOut(expected: bigint, slippageBps: number, decimals: number): bigint {
  return floorTo((expected * (BPS - BigInt(slippageBps))) / BPS, decimals);
}
