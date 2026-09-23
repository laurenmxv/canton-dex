import { useRef, type KeyboardEvent } from 'react';
import {
  curveInWindow,
  place,
  plotWindow,
  polyline,
  realSpan,
  tick,
  type Frame,
} from './curvePlot';
import type { PoolLabels } from './FillAmounts';
import {
  NO_PROJECTED_MOVE,
  OBSERVED,
  reserveText,
  stepStateLabels,
  type StepState,
  type TrajectoryPoint,
} from './preview';
import type { Family } from './queueRows';
import { reserveGeometry, type CurvePoint } from './reserves';

const FRAME: Frame = { width: 320, height: 216, inset: 20 };
const { width: WIDTH, height: HEIGHT, inset: INSET } = FRAME;

/**
 * How far the window reaches past the path. A path of several steps fills more
 * of the frame than a single move does: at 0.8 it spans about three fifths.
 */
const PATH_MARGIN = 0.8;

/** Grid lines drawn inside the frame, on each axis. */
const GRID_LINES = 3;

/** Marker radii in drawn units: a step, the step in focus, and a blocked step's ring. */
const MARKER = 8;
const MARKER_ACTIVE = 10;
const BLOCKED_RING = 13;

/** Below this many drawn units from the start, no marker has visibly moved. */
const VISIBLE_MOVE = 1;

const COLOUR: Record<TrajectoryPoint['state'], string> = {
  observed: 'var(--foreground)',
  projected: 'var(--primary)',
  thin: 'var(--warning)',
  blocked: 'var(--destructive)',
  unchecked: 'var(--muted-foreground)',
};

/** The legend's swatches, in the colours the markers are drawn in. */
const LEGEND: { state: StepState; swatch: string }[] = [
  { state: 'projected', swatch: 'border-primary' },
  { state: 'thin', swatch: 'border-[color:var(--warning)]' },
  { state: 'blocked', swatch: 'border-dashed border-[color:var(--destructive)]' },
];

interface Drawn {
  point: TrajectoryPoint;
  at: CurvePoint;
}

/**
 * Where one queue's next batch would take the pool, step by step.
 *
 * The first point is the state the venue observed; every numbered point after
 * it is a projection the ledger has not confirmed. A blocked step is a ring
 * around the point it stopped at, because a failed request moves nothing.
 * Base is across and quote is up, each scaled by its own largest reserve, and
 * the window is zoomed onto the path. Only a swap trades along x·y=k, so only
 * the swap queue gets that curve as a guide: deposits and withdrawals move the
 * reserves in proportion instead.
 *
 * Every marker is a button. Hover and focus light up its row, a press pins it,
 * and the arrow keys walk the steps from one tab stop for the whole chart.
 */
export function TrajectoryChart({
  points,
  family,
  activeStep,
  pinnedStep,
  baseLabel,
  quoteLabel,
  onHover,
  onPin,
}: PoolLabels & {
  points: readonly TrajectoryPoint[];
  family: Family;
  activeStep: number | null;
  pinnedStep: number | null;
  onHover: (step: number | null) => void;
  onPin: (step: number) => void;
}) {
  const frame = useRef<SVGSVGElement>(null);
  const geometry = reserveGeometry(points.map((point) => point.reserves));
  if (!geometry) {
    return (
      <div className="text-muted-foreground flex aspect-[320/216] items-center justify-center rounded-md border border-dashed text-sm">
        No reserves to chart
      </div>
    );
  }

  const window = plotWindow(geometry.points, PATH_MARGIN);
  const drawn: Drawn[] = points.map((point, index) => ({
    point,
    at: place(geometry.points[index]!, window, FRAME),
  }));
  const start = drawn[0]!.at;
  const route = drawn.filter(({ point }) => point.state !== 'blocked');
  const markers = drawn.filter(({ point }) => point.step !== null);
  const guide = family === 'swap' ? curveInWindow(geometry.points[0]!, window) : [];
  const moves = drawn.some(({ point }) => point.state === 'projected' || point.state === 'thin');
  const visible = drawn.some(({ at }) => Math.hypot(at.x - start.x, at.y - start.y) >= VISIBLE_MOVE);
  // A step nothing evaluated has no marker, so it cannot hold the chart's tab stop.
  const hasMarker = (step: number | null) => markers.some(({ point }) => point.step === step);
  const tabStop = [activeStep, pinnedStep].find(hasMarker) ?? markers[0]?.point.step ?? null;
  // The step in focus is drawn last, so nothing covers it.
  const ordered = [...markers].sort(
    (a, b) => Number(a.point.step === activeStep) - Number(b.point.step === activeStep),
  );
  const baseSpan = realSpan(window, geometry.baseScale, 'x');
  const quoteSpan = realSpan(window, geometry.quoteScale, 'y');
  const grid = Array.from({ length: GRID_LINES }, (_, index) => {
    const fraction = (index + 1) / (GRID_LINES + 1);
    return { x: INSET + fraction * (WIDTH - 2 * INSET), y: INSET + fraction * (HEIGHT - 2 * INSET) };
  });

  function focusStep(step: number | null | undefined) {
    if (step === null || step === undefined) return;
    frame.current?.querySelector<SVGGElement>(`[data-step="${step}"]`)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<SVGGElement>, step: number) {
    const index = markers.findIndex(({ point }) => point.step === step);
    const target: Record<string, number | null | undefined> = {
      ArrowRight: markers[index + 1]?.point.step,
      ArrowDown: markers[index + 1]?.point.step,
      ArrowLeft: markers[index - 1]?.point.step,
      ArrowUp: markers[index - 1]?.point.step,
      Home: markers[0]?.point.step,
      End: markers.at(-1)?.point.step,
    };
    if (event.key in target) {
      event.preventDefault();
      focusStep(target[event.key]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onPin(step);
    }
  }

  function marker({ point, at }: Drawn) {
    const step = point.step!;
    const active = step === activeStep;
    const pinned = step === pinnedStep;
    const colour = COLOUR[point.state];
    const blocked = point.state === 'blocked';
    const radius = blocked ? BLOCKED_RING : active ? MARKER_ACTIVE : MARKER;
    // A blocked step shares its point with the step before it, so its number
    // sits on the ring instead of on the point.
    const label = blocked
      ? { x: at.x + BLOCKED_RING * 0.72, y: at.y - BLOCKED_RING * 0.72, fill: 'var(--card)' }
      : { x: at.x, y: at.y, fill: colour };
    return (
      <g
        key={step}
        data-step={step}
        data-active={active || undefined}
        role="button"
        tabIndex={step === tabStop ? 0 : -1}
        aria-pressed={pinned}
        aria-label={`Step ${step}, ${stepStateLabels[point.state as StepState]}: ${reserveText(point.reserves, baseLabel, quoteLabel)}`}
        className="cursor-pointer outline-none"
        onMouseEnter={() => onHover(step)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(step)}
        onBlur={() => onHover(null)}
        onClick={() => onPin(step)}
        onKeyDown={(event) => onKeyDown(event, step)}
      >
        {active ? <circle cx={at.x} cy={at.y} r={radius + 4} fill={colour} opacity="0.14" /> : null}
        <circle
          cx={at.x}
          cy={at.y}
          r={radius}
          fill={blocked ? 'none' : 'var(--card)'}
          stroke={colour}
          strokeWidth={pinned ? 2.25 : 1.5}
          strokeDasharray={blocked ? '3 2' : undefined}
        />
        {blocked ? <circle cx={label.x} cy={label.y} r="6" fill={colour} /> : null}
        <text
          x={label.x}
          y={label.y}
          dy="0.35em"
          textAnchor="middle"
          fontSize={blocked ? 7.5 : 8.5}
          fontWeight="600"
          fill={label.fill}
        >
          {step}
        </text>
      </g>
    );
  }

  return (
    <figure className="m-0 flex flex-col gap-2">
      <div className="text-muted-foreground grid grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 gap-y-1 text-[0.625rem] tabular-nums">
        <span />
        <span className="text-[0.6875rem]">↑ {quoteLabel} reserve</span>
        <div className="flex flex-col justify-between py-2.5 text-right">
          <span>{tick(window.maxY, geometry.quoteScale, quoteSpan)}</span>
          <span>{tick(window.minY, geometry.quoteScale, quoteSpan)}</span>
        </div>
        <svg
          ref={frame}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="block h-auto w-full min-w-0 overflow-visible [&_circle]:[vector-effect:non-scaling-stroke] [&_line]:[vector-effect:non-scaling-stroke] [&_polyline]:[vector-effect:non-scaling-stroke]"
          role="group"
          aria-label={`Reserve trajectory, ${baseLabel} across and ${quoteLabel} up`}
        >
          {grid.map((line) => (
            <g key={line.x} stroke="var(--border)" strokeWidth="1" opacity="0.5">
              <line x1={line.x} y1={INSET} x2={line.x} y2={HEIGHT - INSET} />
              <line x1={INSET} y1={line.y} x2={WIDTH - INSET} y2={line.y} />
            </g>
          ))}
          <g stroke="var(--border)" strokeWidth="1">
            <line x1={INSET} y1={HEIGHT - INSET} x2={WIDTH - INSET} y2={HEIGHT - INSET} />
            <line x1={INSET} y1={INSET} x2={INSET} y2={HEIGHT - INSET} />
          </g>

          {guide.length > 0 ? (
            <polyline
              data-slot="swap-curve"
              points={polyline(guide, window, FRAME)}
              fill="none"
              stroke="var(--muted-foreground)"
              strokeWidth="1"
              strokeDasharray="2 3"
              opacity="0.55"
            />
          ) : null}

          {route.length > 1 ? (
            <polyline
              points={route.map(({ at }) => `${at.x.toFixed(1)},${at.y.toFixed(1)}`).join(' ')}
              fill="none"
              stroke="var(--primary)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              strokeLinecap="round"
              opacity="0.75"
            />
          ) : null}

          <g aria-hidden="true">
            <circle cx={start.x} cy={start.y} r="5.5" fill="var(--card)" />
            <circle cx={start.x} cy={start.y} r="3.75" fill={COLOUR.observed} />
          </g>

          {ordered.map(marker)}
        </svg>
        <span />
        <div className="flex justify-between px-[6.25%]">
          <span>{tick(window.minX, geometry.baseScale, baseSpan)}</span>
          <span>{tick(window.maxX, geometry.baseScale, baseSpan)}</span>
        </div>
        <span />
        <span className="justify-self-end text-[0.6875rem]">{baseLabel} reserve →</span>
      </div>

      <figcaption className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.6875rem]">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 rounded-full bg-[var(--foreground)]" />
          {OBSERVED}
        </span>
        {LEGEND.map(({ state, swatch }) => (
          <span key={state} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-2.5 rounded-full border-[1.5px] ${swatch}`} />
            {stepStateLabels[state]}
          </span>
        ))}
        {guide.length > 0 ? <span>┄ x·y=k at the observed state</span> : null}
        {!moves ? <span>{NO_PROJECTED_MOVE}</span> : !visible ? <span>Move below chart resolution</span> : null}
      </figcaption>
    </figure>
  );
}
