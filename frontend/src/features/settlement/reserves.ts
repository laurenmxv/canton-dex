import type { PoolReserves } from '../../lib/api/types';
import {
  compareDecimals,
  decimalRatio,
  decimalText,
  multiplyDecimals,
  parseDecimal,
  subtractDecimals,
  type Decimal,
} from '../../lib/decimal';

/** How much each reserve moved, signed, as decimal strings. */
export interface ReserveDelta {
  base: string;
  quote: string;
}

/**
 * The change one batch made, from the two confirmed observations it recorded.
 *
 * Null until both sides exist: a batch that has not been confirmed has moved
 * nothing, and saying otherwise would invent a settlement.
 */
export function reserveDelta(
  before: PoolReserves | null,
  after: PoolReserves | null,
): ReserveDelta | null {
  if (!before || !after) return null;
  const values = [
    parseDecimal(after.baseReserve),
    parseDecimal(before.baseReserve),
    parseDecimal(after.quoteReserve),
    parseDecimal(before.quoteReserve),
  ];
  if (values.some((value) => value === null)) return null;
  const [afterBase, beforeBase, afterQuote, beforeQuote] = values as Decimal[];
  return {
    base: decimalText(subtractDecimals(afterBase!, beforeBase!)),
    quote: decimalText(subtractDecimals(afterQuote!, beforeQuote!)),
  };
}

/**
 * Whether the reported invariant is exactly the product of the two reserves.
 *
 * This is a check, not a health score: it either holds or it does not, and it
 * is null when a figure cannot be read. A batch that retains fees raises the
 * invariant, and that is expected; a product that disagrees with the reported
 * one is not.
 */
export function invariantMatchesReserves(reserves: PoolReserves): boolean | null {
  const base = parseDecimal(reserves.baseReserve);
  const quote = parseDecimal(reserves.quoteReserve);
  const invariant = parseDecimal(reserves.invariant);
  if (!base || !quote || !invariant) return null;
  return compareDecimals(multiplyDecimals(base, quote), invariant) === 0;
}

/** How long ago the venue looked, in seconds. Null when the timestamp is unreadable. */
export function observationAgeSeconds(observedAt: string, now: number): number | null {
  const taken = Date.parse(observedAt);
  return Number.isFinite(taken) ? Math.max(0, Math.round((now - taken) / 1000)) : null;
}

/** Past this, an observation is old enough that it should not be read as current. */
export const STALE_OBSERVATION_SECONDS = 30;

export interface CurvePoint {
  x: number;
  y: number;
}

/** Two reserves, as an observation records them or a preview projects them. */
export interface ReservePair {
  baseReserve: string;
  quoteReserve: string;
}

export interface ReserveGeometry {
  /** Each state, in view units, in the order it was given. */
  points: CurvePoint[];
  /**
   * What each axis was divided by: the largest reserve any state holds on
   * that axis.
   *
   * The axes are scaled independently, because a pair can hold five of one
   * instrument against three hundred thousand of the other and one shared
   * scale would flatten the smaller side onto its axis. A coordinate times
   * this scale is the reserve it stands for, which is how a chart labels its
   * ticks. Nothing here compares the two axes to each other.
   */
  baseScale: string;
  quoteScale: string;
}

function largest(values: readonly Decimal[]): Decimal {
  return values.reduce((best, value) => (compareDecimals(value, best) > 0 ? value : best));
}

/**
 * Each state as a point in view units.
 *
 * Every coordinate is a bounded ratio of one reserve to the largest one on its
 * axis, so nothing here is an amount and nothing here is money. An empty pool
 * sits at the origin. Null when a reserve cannot be read, or when an axis
 * holds nothing in any state, since that axis then has no scale to draw at.
 */
export function reserveGeometry(states: readonly ReservePair[]): ReserveGeometry | null {
  const bases = states.map((state) => parseDecimal(state.baseReserve));
  const quotes = states.map((state) => parseDecimal(state.quoteReserve));
  if (states.length === 0 || [...bases, ...quotes].some((value) => value === null)) return null;
  const largestBase = largest(bases as Decimal[]);
  const largestQuote = largest(quotes as Decimal[]);

  const points: CurvePoint[] = [];
  for (let index = 0; index < states.length; index += 1) {
    const x = decimalRatio(bases[index]!, largestBase);
    const y = decimalRatio(quotes[index]!, largestQuote);
    if (x === null || y === null || x < 0 || y < 0) return null;
    points.push({ x, y });
  }
  return { points, baseScale: decimalText(largestBase), quoteScale: decimalText(largestQuote) };
}
