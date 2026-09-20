import type { PoolReserves } from '../../lib/api/types';
import { curveGeometry, type CurvePoint } from './reserves';

const WIDTH = 260;
const HEIGHT = 150;
const PAD = 12;

/** Both axes share one bound, taken from the geometry so both points fit. */
function place(point: CurvePoint, viewMax: number): { x: number; y: number } {
  return {
    x: PAD + (Math.min(point.x, viewMax) / viewMax) * (WIDTH - 2 * PAD),
    y: HEIGHT - PAD - (Math.min(point.y, viewMax) / viewMax) * (HEIGHT - 2 * PAD),
  };
}

function path(points: CurvePoint[], viewMax: number): string {
  return points
    .filter((point) => point.y <= viewMax && point.y > 0)
    .map((point) => {
      const at = place(point, viewMax);
      return `${at.x.toFixed(1)},${at.y.toFixed(1)}`;
    })
    .join(' ');
}

/**
 * Where the pool sat before a batch, and where it sits after.
 *
 * Both axes are the pool's own reserves, scaled to the larger of the two
 * observations, so the picture says which way each reserve moved and nothing
 * about price in any currency. Each point has its own curve, because the fees
 * the pool retains raise the invariant: the point after a batch is not on the
 * curve before it, and drawing one curve would claim it was.
 */
export function ReserveChart({
  before,
  after,
  baseLabel,
  quoteLabel,
}: {
  before: PoolReserves;
  after: PoolReserves;
  baseLabel: string;
  quoteLabel: string;
}) {
  const geometry = curveGeometry(before, after);
  if (!geometry) return null;

  const { viewMax } = geometry;
  const beforeAt = place(geometry.beforePoint, viewMax);
  const afterAt = place(geometry.afterPoint, viewMax);

  return (
    <figure className="stack-sm" style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height="auto"
        role="img"
        aria-label={`Reserves before and after this batch: ${baseLabel} against ${quoteLabel}`}
      >
        <line
          x1={PAD}
          y1={HEIGHT - PAD}
          x2={WIDTH - PAD}
          y2={HEIGHT - PAD}
          stroke="currentColor"
          opacity="0.25"
        />
        <line x1={PAD} y1={PAD} x2={PAD} y2={HEIGHT - PAD} stroke="currentColor" opacity="0.25" />
        <polyline
          points={path(geometry.beforeCurve, viewMax)}
          fill="none"
          stroke="currentColor"
          opacity="0.35"
          strokeDasharray="4 3"
        />
        <polyline
          points={path(geometry.afterCurve, viewMax)}
          fill="none"
          stroke="currentColor"
          opacity="0.7"
        />
        <circle cx={beforeAt.x} cy={beforeAt.y} r="3.5" fill="currentColor" opacity="0.4" />
        <circle cx={afterAt.x} cy={afterAt.y} r="3.5" fill="currentColor" />
      </svg>
      <figcaption className="muted text-xs">
        {baseLabel} × {quoteLabel} · before dashed, after solid
      </figcaption>
    </figure>
  );
}
