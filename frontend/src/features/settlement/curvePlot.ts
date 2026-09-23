import { decimalText, formatDecimal, multiplyDecimals, parseDecimal } from '../../lib/decimal';
import type { CurvePoint } from './reserves';

/** The part of the reserve plane a chart draws, in the same view units. */
export interface PlotWindow {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * How far the window reaches past the points on each side, as a multiple of
 * the distance they span.
 *
 * A real batch moves a deep pool by a fraction of a percent: one observed
 * batch here moved a five-unit reserve by 0.0002. The window is therefore
 * sized from the move itself, not from the pool, the way a depth chart is
 * drawn around the price that is active now. At 2.5 the move spans a fifth of
 * the frame, which leaves both markers clear of the edges.
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
 * The window a set of points is drawn in.
 *
 * Both axes get the same half extent, so the curve keeps the shape x·y=k
 * gives it rather than being stretched into one. Neither axis goes below
 * zero, because no reserve does.
 */
export function plotWindow(points: readonly CurvePoint[], margin: number = SEPARATION_MARGIN): PlotWindow {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const [lowX, highX, lowY, highY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const centreX = (lowX + highX) / 2;
  const centreY = (lowY + highY) / 2;
  const separation = Math.max(highX - lowX, highY - lowY);
  const reserves = Math.max(centreX, centreY);
  // The move sets the scale wherever there is one. Falling back to a fraction
  // of the reserves for a small move would bury it: that is the very case an
  // origin-anchored frame could not show.
  const half =
    separation > reserves * NEGLIGIBLE
      ? separation * margin
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

/** One chart's drawing area, in SVG user units, and how far its plot sits inside it. */
export interface Frame {
  width: number;
  height: number;
  inset: number;
}

/** One view coordinate, in the drawn frame. */
export function place(point: CurvePoint, window: PlotWindow, frame: Frame): CurvePoint {
  const spanX = window.maxX - window.minX || 1;
  const spanY = window.maxY - window.minY || 1;
  return {
    x: frame.inset + ((point.x - window.minX) / spanX) * (frame.width - 2 * frame.inset),
    y: frame.height - frame.inset - ((point.y - window.minY) / spanY) * (frame.height - 2 * frame.inset),
  };
}

export function polyline(points: readonly CurvePoint[], window: PlotWindow, frame: Frame): string {
  return points
    .map((point) => {
      const at = place(point, window, frame);
      return `${at.x.toFixed(1)},${at.y.toFixed(1)}`;
    })
    .join(' ');
}

/** Digits a tick is written to. Past this the window is below what a double resolves. */
const TICK_DIGITS_MAX = 10;

/**
 * An axis tick, written to whatever precision the window needs.
 *
 * The precision follows the span rather than the magnitude: a frame zoomed
 * onto a move can be a ten-thousandth of a reserve wide, and two ticks rounded
 * to the same figure would say the axis does not change. The exact reserves
 * are printed beside the chart, so a tick only has to place the eye.
 */
export function tick(coordinate: number, scale: string, span: number): string {
  const amount = axisAmount(coordinate, scale);
  if (amount === null || !parseDecimal(amount)) return '—';
  const digits =
    span > 0 ? Math.min(TICK_DIGITS_MAX, Math.max(0, Math.ceil(-Math.log10(span)) + 1)) : 2;
  // Both ends of an axis are written to the same precision, so the pair reads
  // as one scale rather than as two unrelated figures.
  return formatDecimal(amount, { minFractionDigits: digits, maxFractionDigits: digits });
}

/** How wide the window is in real reserves, which is what sets the tick precision. */
export function realSpan(window: PlotWindow, scale: string, axis: 'x' | 'y'): number {
  const low = axisAmount(axis === 'x' ? window.minX : window.minY, scale);
  const high = axisAmount(axis === 'x' ? window.maxX : window.maxY, scale);
  if (low === null || high === null) return 0;
  return Math.abs(Number(high) - Number(low));
}
