import { decimalText, multiplyDecimals, parseDecimal } from '../../lib/decimal';
import type { CurveGeometry, CurvePoint } from './reserves';

/** The part of the reserve plane a chart draws, in the same view units. */
export interface PlotWindow {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * How much of the window the move between the two observations takes up.
 *
 * A real batch moves a deep pool by a fraction of a percent: one observed
 * batch here moved a five-unit reserve by 0.0002. The window is therefore
 * sized from the move itself, not from the pool, the way a depth chart is
 * drawn around the price that is active now. At 2.5, the move spans two
 * fifths of the frame and both markers stay clear of the edges.
 */
const SEPARATION_MARGIN = 2.5;

/**
 * The window a pool that did not move still gets, as a fraction of its own
 * reserves. A batch can confirm without changing a reserve, and a window of
 * no width would divide by zero rather than draw it.
 */
const MINIMUM_EXTENT = 0.045;

/**
 * Below this fraction of the reserves, a separation is arithmetic noise in a
 * double rather than a move, and the minimum window is used instead.
 */
const NEGLIGIBLE = 1e-9;

/** Samples per curve. Enough that a drawn arc has no visible corners. */
const STEPS = 64;

/**
 * The window the two observations are drawn in.
 *
 * Both axes get the same half extent, so the curve keeps the shape x·y=k
 * gives it rather than being stretched into one. Neither axis goes below
 * zero, because no reserve does.
 */
export function plotWindow(geometry: CurveGeometry): PlotWindow {
  const { beforePoint: before, afterPoint: after } = geometry;
  const centreX = (before.x + after.x) / 2;
  const centreY = (before.y + after.y) / 2;
  const separation = Math.max(Math.abs(after.x - before.x), Math.abs(after.y - before.y));
  const reserves = Math.max(centreX, centreY);
  // The move sets the scale wherever there is one. Falling back to a fraction
  // of the reserves for a small move would bury it: that is the very case the
  // old origin-anchored frame could not show.
  const half =
    separation > reserves * NEGLIGIBLE
      ? separation * SEPARATION_MARGIN
      : reserves * MINIMUM_EXTENT;
  return {
    minX: Math.max(0, centreX - half),
    maxX: centreX + half,
    minY: Math.max(0, centreY - half),
    maxY: centreY + half,
  };
}

/**
 * The curve one observation sits on, sampled across the window.
 *
 * The invariant is the observation's own product, so this draws the same
 * constant-product curve the pool trades on and invents no other. y=k/x falls
 * as x rises, so the part inside the window is one interval: the samples join
 * into an arc with no chord across a gap.
 */
export function curveInWindow(
  observation: CurvePoint,
  window: PlotWindow,
  steps: number = STEPS,
): CurvePoint[] {
  const product = observation.x * observation.y;
  if (!(product > 0) || !(window.maxY > 0)) return [];

  const from = Math.max(window.minX, product / window.maxY);
  const to = window.minY > 0 ? Math.min(window.maxX, product / window.minY) : window.maxX;
  if (!(to > from)) return [];

  const points: CurvePoint[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const x = from + ((to - from) * step) / steps;
    points.push({ x, y: product / x });
  }
  return points;
}

/** Fractional digits a plot coordinate is read back at. Past this it is noise. */
const COORDINATE_DIGITS = 12;

/**
 * A plot coordinate read back as the reserve it stands for.
 *
 * The coordinate is a ratio of one axis's largest observed reserve, so the
 * reserve is that ratio times the scale. It is an axis label and never an
 * amount to act on: the ratio is a double, and the reserves themselves are
 * printed exactly beside the chart. Null where the scale cannot be read.
 */
export function axisAmount(coordinate: number, scale: string): string | null {
  if (!Number.isFinite(coordinate) || coordinate < 0) return null;
  const size = parseDecimal(scale);
  const ratio = parseDecimal(coordinate.toFixed(COORDINATE_DIGITS));
  if (!size || !ratio) return null;
  return decimalText(multiplyDecimals(ratio, size));
}
