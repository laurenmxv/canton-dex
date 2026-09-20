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

export interface CurveGeometry {
  /** The constant-product curve through each observation, in view units. */
  beforeCurve: CurvePoint[];
  afterCurve: CurvePoint[];
  beforePoint: CurvePoint;
  afterPoint: CurvePoint;
  /** The largest coordinate either axis has to show, so both points fit. */
  viewMax: number;
  /**
   * What each axis was divided by: the larger of the two observed reserves on
   * that axis.
   *
   * The axes are scaled independently, because a pair can hold five of one
   * instrument against three hundred thousand of the other and one shared
   * scale would flatten the smaller side onto its axis. A coordinate times
   * this scale is the reserve it stands for, which is how the chart labels
   * its ticks. Nothing here compares the two axes to each other.
   */
  baseScale: string;
  quoteScale: string;
}

/**
 * How far past the two observed points the curves are drawn.
 *
 * The range comes from the points themselves: a fixed window would leave a
 * large reserve move drawn off its own curve.
 */
const MARGIN = 0.4;
const STEPS = 32;

function curve(product: number, from: number, to: number): CurvePoint[] {
  const points: CurvePoint[] = [];
  for (let step = 0; step <= STEPS; step += 1) {
    const x = from + ((to - from) * step) / STEPS;
    points.push({ x, y: product / x });
  }
  return points;
}

/**
 * The two curves and the two points a batch moved between, in view units.
 *
 * Every coordinate is a bounded ratio of one reserve to the larger observed
 * one, so nothing here is an amount and nothing here is money. The two curves
 * are drawn separately on purpose: retained fees raise the invariant, so the
 * point after a batch does not lie on the curve before it.
 */
export function curveGeometry(
  before: PoolReserves,
  after: PoolReserves,
): CurveGeometry | null {
  const values = [
    parseDecimal(before.baseReserve),
    parseDecimal(before.quoteReserve),
    parseDecimal(after.baseReserve),
    parseDecimal(after.quoteReserve),
  ];
  if (values.some((value) => value === null)) return null;
  const [beforeBase, beforeQuote, afterBase, afterQuote] = values as Decimal[];

  const largestBase = compareDecimals(beforeBase!, afterBase!) >= 0 ? beforeBase! : afterBase!;
  const largestQuote = compareDecimals(beforeQuote!, afterQuote!) >= 0 ? beforeQuote! : afterQuote!;
  const scaled = [
    decimalRatio(beforeBase!, largestBase),
    decimalRatio(beforeQuote!, largestQuote),
    decimalRatio(afterBase!, largestBase),
    decimalRatio(afterQuote!, largestQuote),
  ];
  if (scaled.some((value) => value === null || value <= 0)) return null;
  const [bx, by, ax, ay] = scaled as number[];

  // Both ratios are positive, so a fraction of the smaller one starts the
  // range below both markers however far apart they are.
  const from = Math.min(bx!, ax!) * (1 - MARGIN);
  const to = Math.max(bx!, ax!) * (1 + MARGIN);

  return {
    beforeCurve: curve(bx! * by!, from, to),
    afterCurve: curve(ax! * ay!, from, to),
    beforePoint: { x: bx!, y: by! },
    afterPoint: { x: ax!, y: ay! },
    viewMax: Math.max(to, by!, ay!) * 1.05,
    baseScale: decimalText(largestBase),
    quoteScale: decimalText(largestQuote),
  };
}
