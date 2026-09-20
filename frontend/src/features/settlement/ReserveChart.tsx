import { useId } from 'react';
import type { PoolReserves, Settlement } from '../../lib/api/types';
import { compareDecimals, formatDecimal, formatExact, parseDecimal } from '../../lib/decimal';
import { formatAge, formatDateTime, shortContract } from '../../lib/labels';
import { Badge } from '../../ui/Badge';
import { axisAmount, curveInWindow, plotWindow, type PlotWindow } from './curvePlot';
import { curveGeometry, reserveDelta, type CurvePoint } from './reserves';

const WIDTH = 264;
const HEIGHT = 168;
const INSET = 11;

/** Grid lines drawn inside the frame, on each axis. */
const GRID_LINES = 3;

/** Below this, in drawn units, the two markers touch and a line between them is noise. */
const ARROW_MINIMUM = 14;

/** How far the connector stops short of each marker, so neither end sits under one. */
const ARROW_CLEARANCE = 6.5;

interface Placed {
  x: number;
  y: number;
}

/** One view coordinate, in the drawn frame. */
function place(point: CurvePoint, window: PlotWindow): Placed {
  const spanX = window.maxX - window.minX || 1;
  const spanY = window.maxY - window.minY || 1;
  return {
    x: INSET + ((point.x - window.minX) / spanX) * (WIDTH - 2 * INSET),
    y: HEIGHT - INSET - ((point.y - window.minY) / spanY) * (HEIGHT - 2 * INSET),
  };
}

function polyline(points: CurvePoint[], window: PlotWindow): string {
  return points
    .map((point) => {
      const at = place(point, window);
      return `${at.x.toFixed(1)},${at.y.toFixed(1)}`;
    })
    .join(' ');
}

/** The same arc, closed onto the floor of the frame, so it can carry a fill. */
function area(points: CurvePoint[], window: PlotWindow): string {
  if (points.length === 0) return '';
  const drawn = points.map((point) => place(point, window));
  const first = drawn[0]!;
  const last = drawn.at(-1)!;
  const floor = HEIGHT - INSET;
  const line = drawn.map((at) => `${at.x.toFixed(1)},${at.y.toFixed(1)}`).join(' L ');
  return `M ${line} L ${last.x.toFixed(1)},${floor} L ${first.x.toFixed(1)},${floor} Z`;
}

/** The connector between the two markers, trimmed clear of both. Null when they touch. */
function connector(
  from: Placed,
  to: Placed,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < ARROW_MINIMUM) return null;
  const unitX = dx / length;
  const unitY = dy / length;
  return {
    x1: from.x + unitX * ARROW_CLEARANCE,
    y1: from.y + unitY * ARROW_CLEARANCE,
    x2: to.x - unitX * ARROW_CLEARANCE,
    y2: to.y - unitY * ARROW_CLEARANCE,
  };
}

/** Digits a tick is written to. Past this the window is below what a double resolves. */
const TICK_DIGITS_MAX = 10;

/**
 * An axis tick, written to whatever precision the window needs.
 *
 * The precision follows the span rather than the magnitude: this frame is
 * zoomed onto a move that can be a ten-thousandth of a reserve, and two ticks
 * rounded to the same figure would say the axis does not change. The exact
 * reserves are printed in the key below, so a tick only has to place the eye.
 */
function tick(coordinate: number, scale: string, span: number): string {
  const amount = axisAmount(coordinate, scale);
  if (amount === null || !parseDecimal(amount)) return '—';
  const digits =
    span > 0 ? Math.min(TICK_DIGITS_MAX, Math.max(0, Math.ceil(-Math.log10(span)) + 1)) : 2;
  // Both ends of an axis are written to the same precision, so the pair reads
  // as one scale rather than as two unrelated figures.
  return formatDecimal(amount, { minFractionDigits: digits, maxFractionDigits: digits });
}

/** How wide the window is in real reserves, which is what sets the tick precision. */
function realSpan(window: PlotWindow, scale: string, axis: 'x' | 'y'): number {
  const low = axisAmount(axis === 'x' ? window.minX : window.minY, scale);
  const high = axisAmount(axis === 'x' ? window.maxX : window.maxY, scale);
  if (low === null || high === null) return 0;
  return Math.abs(Number(high) - Number(low));
}

/** Whether the invariant rose, fell or held, from the two figures the venue reported. */
function invariantMove(before: string, after: string): 'rose' | 'fell' | 'unchanged' | null {
  const start = parseDecimal(before);
  const end = parseDecimal(after);
  if (!start || !end) return null;
  const order = compareDecimals(end, start);
  return order > 0 ? 'rose' : order < 0 ? 'fell' : 'unchanged';
}

/** Keeps the sign a delta carries, because which way it moved is the point. */
function signed(value: string): string {
  const shown = formatExact(value);
  return value.startsWith('-') ? shown : `+${shown}`;
}

/**
 * What one confirmed batch did to a pool's reserves.
 *
 * Everything drawn is the batch's own two observations. The chart is history:
 * it is the last batch the ledger confirmed, which is not necessarily where
 * the pool stands now, and it says which of the two it is by comparing the
 * after state with the observation the venue just took.
 *
 * Both axes are reserves. Each is scaled by its own larger observation, so the
 * two axes are not to one scale and nothing here is a price. The window is
 * zoomed onto the move, because a batch shifts a deep pool by a fraction of a
 * percent and an origin-anchored frame leaves that as one dot.
 *
 * Each observation sits on its own constant-product curve. A pool keeps its
 * fee, so x·y=k is larger after the batch than before, and no single curve
 * passes through both points.
 */
export function ReserveChart({
  settlement,
  before,
  after,
  baseLabel,
  quoteLabel,
  currentStateId,
  now,
}: {
  /** The batch these two observations belong to, which is what dates them. */
  settlement: Settlement;
  before: PoolReserves;
  after: PoolReserves;
  baseLabel: string;
  quoteLabel: string;
  /** The state the venue's own latest observation is at, where it has one. */
  currentStateId: string | null;
  now: number;
}) {
  // Colons a generated id carries are dropped, so `url(#id)` stays simple.
  const uid = useId().replace(/:/g, '');
  const gradientId = `${uid}-fill`;
  const arrowId = `${uid}-arrow`;
  const geometry = curveGeometry(before, after);
  if (!geometry) return null;

  const window = plotWindow(geometry);
  const beforeCurve = curveInWindow(geometry.beforePoint, window);
  const afterCurve = curveInWindow(geometry.afterPoint, window);
  const beforeAt = place(geometry.beforePoint, window);
  const afterAt = place(geometry.afterPoint, window);
  const arrow = connector(beforeAt, afterAt);
  const delta = reserveDelta(before, after);
  const invariant = invariantMove(before.invariant, after.invariant);
  const current = currentStateId !== null && currentStateId === after.stateId;
  const baseSpan = realSpan(window, geometry.baseScale, 'x');
  const quoteSpan = realSpan(window, geometry.quoteScale, 'y');

  const grid = Array.from({ length: GRID_LINES }, (_, index) => {
    const fraction = (index + 1) / (GRID_LINES + 1);
    return {
      x: INSET + fraction * (WIDTH - 2 * INSET),
      y: INSET + fraction * (HEIGHT - 2 * INSET),
    };
  });

  const afterText = `${formatExact(after.baseReserve)} ${baseLabel} · ${formatExact(after.quoteReserve)} ${quoteLabel}`;
  const beforeText = `${formatExact(before.baseReserve)} ${baseLabel} · ${formatExact(before.quoteReserve)} ${quoteLabel}`;

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <div>
          <span className="chart-title">Reserves across the last confirmed batch</span>
          <p className="muted text-xs">
            <span className="mono">{shortContract(settlement.settlementId)}</span> ·{' '}
            {settlement.swapIds.length} request{settlement.swapIds.length === 1 ? '' : 's'} ·
            confirmed {formatAge(settlement.updatedAt, now)} ago
          </p>
        </div>
        <Badge tone={current ? 'success' : 'neutral'}>
          {current ? 'Still the current state' : 'Superseded'}
        </Badge>
      </figcaption>

      <div className="chart-body">
        <div className="chart-plot">
          <span className="chart-axis">↑ {quoteLabel} reserve</span>
          <div className="chart-frame">
            <div className="chart-ticks-y tabular">
              <span>{tick(window.maxY, geometry.quoteScale, quoteSpan)}</span>
              <span>{tick(window.minY, geometry.quoteScale, quoteSpan)}</span>
            </div>
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              className="chart-svg"
              role="img"
              aria-label={`Constant product curves for the last confirmed batch. Before it, ${beforeText}. After it, ${afterText}.`}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
                </linearGradient>
                <marker
                  id={arrowId}
                  viewBox="0 0 7 7"
                  refX="6"
                  refY="3.5"
                  markerWidth="7"
                  markerHeight="7"
                  markerUnits="userSpaceOnUse"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0.8 L 6 3.5 L 0 6.2 z" fill="var(--foreground)" opacity="0.55" />
                </marker>
              </defs>

              {grid.map((line) => (
                <g key={line.x} stroke="var(--border)" strokeWidth="1">
                  <line x1={line.x} y1={INSET} x2={line.x} y2={HEIGHT - INSET} opacity="0.5" />
                  <line x1={INSET} y1={line.y} x2={WIDTH - INSET} y2={line.y} opacity="0.5" />
                </g>
              ))}

              <path d={area(afterCurve, window)} fill={`url(#${gradientId})`} />

              <polyline
                points={polyline(beforeCurve, window)}
                fill="none"
                stroke="var(--muted-foreground)"
                strokeWidth="1.25"
                strokeDasharray="3 3"
                strokeLinecap="round"
                opacity="0.7"
              />
              <polyline
                points={polyline(afterCurve, window)}
                fill="none"
                stroke="var(--primary)"
                strokeWidth="1.75"
                strokeLinecap="round"
              />

              {/* Where the batch left the pool, read off both axes. */}
              <g stroke="var(--primary)" strokeWidth="1" strokeDasharray="2 3" opacity="0.4">
                <line x1={INSET} y1={afterAt.y} x2={afterAt.x} y2={afterAt.y} />
                <line x1={afterAt.x} y1={afterAt.y} x2={afterAt.x} y2={HEIGHT - INSET} />
              </g>

              {arrow ? (
                <line
                  x1={arrow.x1}
                  y1={arrow.y1}
                  x2={arrow.x2}
                  y2={arrow.y2}
                  stroke="var(--foreground)"
                  strokeWidth="1.25"
                  strokeDasharray="2 2"
                  opacity="0.5"
                  markerEnd={`url(#${arrowId})`}
                />
              ) : null}

              <g stroke="var(--border)" strokeWidth="1">
                <line x1={INSET} y1={HEIGHT - INSET} x2={WIDTH - INSET} y2={HEIGHT - INSET} />
                <line x1={INSET} y1={INSET} x2={INSET} y2={HEIGHT - INSET} />
              </g>

              <circle
                cx={beforeAt.x}
                cy={beforeAt.y}
                r="3.4"
                fill="var(--card)"
                stroke="var(--muted-foreground)"
                strokeWidth="1.5"
              />
              <circle cx={afterAt.x} cy={afterAt.y} r="5.2" fill="var(--card)" />
              <circle cx={afterAt.x} cy={afterAt.y} r="3.4" fill="var(--primary)" />
            </svg>
          </div>
          <div className="chart-ticks-x tabular">
            <span>{tick(window.minX, geometry.baseScale, baseSpan)}</span>
            <span>{tick(window.maxX, geometry.baseScale, baseSpan)}</span>
          </div>
          <span className="chart-axis chart-axis-x">{baseLabel} reserve →</span>
        </div>

        <dl className="chart-key">
          <div className="chart-key-row">
            <dt>
              <span className="chart-swatch chart-swatch-after" aria-hidden="true" />
              After · <span className="mono">{shortContract(after.stateId)}</span>
            </dt>
            <dd className="tabular">{afterText}</dd>
          </div>
          <div className="chart-key-row">
            <dt>
              <span className="chart-swatch chart-swatch-before" aria-hidden="true" />
              Before · <span className="mono">{shortContract(before.stateId)}</span>
            </dt>
            <dd className="tabular">{beforeText}</dd>
          </div>
          {delta ? (
            <>
              <div className="chart-key-row">
                <dt>{baseLabel} change</dt>
                <dd className="tabular">{signed(delta.base)}</dd>
              </div>
              <div className="chart-key-row">
                <dt>{quoteLabel} change</dt>
                <dd className="tabular">{signed(delta.quote)}</dd>
              </div>
            </>
          ) : null}
          <div className="chart-key-row">
            <dt>Invariant x·y=k</dt>
            <dd className="tabular">
              {formatDecimal(before.invariant, { maxFractionDigits: 2 })} →{' '}
              {formatDecimal(after.invariant, { maxFractionDigits: 2 })}
              {invariant === null ? '' : ` · ${invariant}`}
            </dd>
          </div>
        </dl>
      </div>

      <div className="chart-notes muted text-xs">
        <p>
          Confirmed {formatDateTime(settlement.updatedAt)} ·{' '}
          {settlement.trigger === 'MANUAL' ? 'started by an operator' : 'started by the venue'}
          {settlement.updateId ? (
            <>
              {' '}
              · ledger update <span className="mono">{shortContract(settlement.updateId)}</span>
            </>
          ) : null}
        </p>
      </div>
    </figure>
  );
}
