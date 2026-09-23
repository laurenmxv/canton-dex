import { useId } from 'react';
import type { PoolReserves, Settlement } from '../../lib/api/types';
import { compareDecimals, formatExact, formatUnrounded, parseDecimal } from '../../lib/decimal';
import { formatAge, formatDateTime, shortContract } from '../../lib/labels';
import { Mono } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import {
  curveInWindow,
  place,
  plotWindow,
  polyline,
  realSpan,
  tick,
  type Frame,
  type PlotWindow,
} from './curvePlot';
import { reserveText } from './preview';
import { reserveDelta, reserveGeometry, type CurvePoint } from './reserves';

const FRAME: Frame = { width: 264, height: 168, inset: 11 };
const { width: WIDTH, height: HEIGHT, inset: INSET } = FRAME;

/** Grid lines drawn inside the frame, on each axis. */
const GRID_LINES = 3;

/** Below this, in drawn units, the two markers touch and a line between them is noise. */
const ARROW_MINIMUM = 14;

/** How far the connector stops short of each marker, so neither end sits under one. */
const ARROW_CLEARANCE = 6.5;

/** The same arc, closed onto the floor of the frame, so it can carry a fill. */
function area(points: CurvePoint[], window: PlotWindow): string {
  if (points.length === 0) return '';
  const drawn = points.map((point) => place(point, window, FRAME));
  const first = drawn[0]!;
  const last = drawn.at(-1)!;
  const floor = HEIGHT - INSET;
  const line = drawn.map((at) => `${at.x.toFixed(1)},${at.y.toFixed(1)}`).join(' L ');
  return `M ${line} L ${last.x.toFixed(1)},${floor} L ${first.x.toFixed(1)},${floor} Z`;
}

/** The connector between the two markers, trimmed clear of both. Null when they touch. */
function connector(
  from: CurvePoint,
  to: CurvePoint,
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
 * Everything drawn is the batch's own two observations. The chart is history,
 * which is not necessarily where the pool stands now, and it says which of the
 * two it is by comparing the after state with the observation the venue just
 * took.
 *
 * Both axes are reserves. Each is scaled by its own larger observation, so the
 * two axes are not to one scale and nothing here is a price. The window is
 * zoomed onto the move, because a batch shifts a deep pool by a fraction of a
 * percent and an origin-anchored frame leaves that as one dot.
 *
 * Each observation sits on its own constant-product curve, because a batch
 * moves x·y=k: retained fees and deposits raise it, and withdrawals lower it.
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
  const geometry = reserveGeometry([before, after]);
  if (!geometry) return null;

  const [beforePoint, afterPoint] = geometry.points as [CurvePoint, CurvePoint];
  const window = plotWindow(geometry.points);
  const beforeCurve = curveInWindow(beforePoint, window);
  const afterCurve = curveInWindow(afterPoint, window);
  const beforeAt = place(beforePoint, window, FRAME);
  const afterAt = place(afterPoint, window, FRAME);
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

  const afterText = reserveText(after, baseLabel, quoteLabel);
  const beforeText = reserveText(before, baseLabel, quoteLabel);

  return (
    <figure className="m-0 flex flex-col gap-2.5 rounded-md border bg-[color-mix(in_oklab,var(--muted)_40%,var(--card))] px-4 pt-3.5 pb-4">
      <figcaption className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="text-sm font-semibold">Reserves across this batch</span>
          <p className="text-muted-foreground text-xs">
            <Mono>{shortContract(settlement.settlementId)}</Mono> ·{' '}
            {settlement.requests.length} request{settlement.requests.length === 1 ? '' : 's'} ·
            confirmed {formatAge(settlement.updatedAt, now)} ago
          </p>
        </div>
        <StatusBadge tone={current ? 'success' : 'neutral'} label={current ? 'Still the current state' : 'Superseded'} />
      </figcaption>

      <div className="flex flex-wrap items-center gap-5">
        <div className="flex max-w-[21rem] min-w-[13rem] flex-[1_1_17rem] flex-col gap-1">
          <span className="text-muted-foreground text-[0.6875rem]">↑ {quoteLabel} reserve</span>
          <div className="flex items-stretch gap-1.5">
            <div className="text-muted-foreground flex flex-col justify-between py-1.5 text-right text-[0.625rem] tabular-nums">
              <span>{tick(window.maxY, geometry.quoteScale, quoteSpan)}</span>
              <span>{tick(window.minY, geometry.quoteScale, quoteSpan)}</span>
            </div>
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              className="block h-auto w-full min-w-0 flex-1 [&_circle]:[vector-effect:non-scaling-stroke] [&_line]:[vector-effect:non-scaling-stroke] [&_polyline]:[vector-effect:non-scaling-stroke]"
              role="img"
              aria-label={`Constant product curves for this confirmed batch. Before it, ${beforeText}. After it, ${afterText}.`}
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
                points={polyline(beforeCurve, window, FRAME)}
                fill="none"
                stroke="var(--muted-foreground)"
                strokeWidth="1.25"
                strokeDasharray="3 3"
                strokeLinecap="round"
                opacity="0.7"
              />
              <polyline
                points={polyline(afterCurve, window, FRAME)}
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
          <div className="text-muted-foreground flex justify-between px-[4.2%] text-[0.625rem] tabular-nums">
            <span>{tick(window.minX, geometry.baseScale, baseSpan)}</span>
            <span>{tick(window.maxX, geometry.baseScale, baseSpan)}</span>
          </div>
          <span className="text-muted-foreground self-end text-[0.6875rem]">{baseLabel} reserve →</span>
        </div>

        <dl className="flex min-w-0 flex-[1_1_11rem] flex-col gap-2.5 text-[0.75rem] [&_dd]:wrap-anywhere [&_dt]:text-muted-foreground [&_dt]:flex [&_dt]:items-center [&_dt]:gap-1.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt>
              <span className="bg-primary size-2.5 flex-none rounded-full" aria-hidden="true" />
              After · <Mono>{shortContract(after.stateId)}</Mono>
            </dt>
            <dd className="tabular-nums">{afterText}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt>
              <span className="size-2.5 flex-none rounded-full shadow-[inset_0_0_0_1.5px_var(--muted-foreground)]" aria-hidden="true" />
              Before · <Mono>{shortContract(before.stateId)}</Mono>
            </dt>
            <dd className="tabular-nums">{beforeText}</dd>
          </div>
          {delta ? (
            <>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt>{baseLabel} change</dt>
                <dd className="tabular-nums">{signed(delta.base)}</dd>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt>{quoteLabel} change</dt>
                <dd className="tabular-nums">{signed(delta.quote)}</dd>
              </div>
            </>
          ) : null}
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt>Invariant x·y=k</dt>
            <dd className="tabular-nums">
              {formatUnrounded(before.invariant)} → {formatUnrounded(after.invariant)}
              {invariant === null ? '' : ` · ${invariant}`}
            </dd>
          </div>
        </dl>
      </div>

      <div className="text-muted-foreground flex flex-col gap-1.5 text-xs leading-normal">
        <p>
          Confirmed {formatDateTime(settlement.updatedAt)} ·{' '}
          {settlement.trigger === 'MANUAL' ? 'started by an operator' : 'started by the venue'}
          {settlement.updateId ? (
            <>
              {' '}
              · ledger update <Mono>{shortContract(settlement.updateId)}</Mono>
            </>
          ) : null}
        </p>
      </div>
    </figure>
  );
}
