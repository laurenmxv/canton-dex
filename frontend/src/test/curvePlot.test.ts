import { describe, expect, it } from 'vitest';
import type { PoolReserves } from '../lib/api/types';
import {
  axisAmount,
  curveInWindow,
  plotWindow,
  realSpan,
  tick,
} from '../features/settlement/curvePlot';
import { reserveGeometry, type ReserveGeometry } from '../features/settlement/reserves';

function reserves(base: string, quote: string): PoolReserves {
  return {
    stateId: `00state-${base}-${quote}`,
    baseReserve: base,
    quoteReserve: quote,
    spotPrice: '0',
    invariant: '0',
  };
}

function geometryOf(...states: [string, string][]): ReserveGeometry {
  const geometry = reserveGeometry(states.map((state) => reserves(...state)));
  if (!geometry) throw new Error('these reserves have a geometry');
  return geometry;
}

function holds(window: ReturnType<typeof plotWindow>, point: { x: number; y: number }): boolean {
  return (
    point.x >= window.minX &&
    point.x <= window.maxX &&
    point.y >= window.minY &&
    point.y <= window.maxY
  );
}

describe('the window a reserve move is drawn in', () => {
  it('holds both observations of a move too small to set a scale of its own', () => {
    const geometry = geometryOf(['5', '300000'], ['5.05', '297038.525897']);
    const [before, after] = geometry.points as [{ x: number; y: number }, { x: number; y: number }];
    const window = plotWindow(geometry.points);

    expect(holds(window, before)).toBe(true);
    expect(holds(window, after)).toBe(true);
    // The window does not collapse onto the move: the two markers have to be
    // separable, not touching.
    expect(window.maxX - window.minX).toBeGreaterThan(Math.abs(after.x - before.x));
  });

  it('shows a batch that moved a deep pool by a fraction of a percent', () => {
    // The figures a local venue reported for one confirmed batch: 5 BTC and
    // 300,000 USDC moving by 0.00016616 and 10. A window sized from the pool
    // rather than from the move would put both markers on one pixel.
    const geometry = geometryOf(['5', '300000'], ['4.99983384', '300010']);
    const [before, after] = geometry.points as [{ x: number; y: number }, { x: number; y: number }];
    const window = plotWindow(geometry.points);
    const moved = Math.abs(after.x - before.x);

    expect(holds(window, before)).toBe(true);
    expect(holds(window, after)).toBe(true);
    // The move is a fifth of the frame or more, so the two markers are apart.
    expect(moved / (window.maxX - window.minX)).toBeGreaterThan(0.15);
  });

  it('holds every step of a path, and gives a narrower margin a larger share of the frame', () => {
    const geometry = geometryOf(
      ['5', '300000'],
      ['5.05', '297049.876544'],
      ['5.1', '294147.5'],
      ['5.13', '292430.2'],
    );
    const wide = plotWindow(geometry.points);
    const tight = plotWindow(geometry.points, 0.8);

    for (const point of geometry.points) {
      expect(holds(wide, point)).toBe(true);
      expect(holds(tight, point)).toBe(true);
    }
    expect(tight.maxX - tight.minX).toBeLessThan(wide.maxX - wide.minX);
  });

  it('holds both observations of a move that quarters one reserve', () => {
    const geometry = geometryOf(['100', '100'], ['25', '400']);
    const window = plotWindow(geometry.points);

    for (const point of geometry.points) expect(holds(window, point)).toBe(true);
  });

  it('opens a window around a pool no batch has moved, and around a lone observation', () => {
    for (const geometry of [geometryOf(['5', '300000'], ['5', '300000']), geometryOf(['5', '300000'])]) {
      const window = plotWindow(geometry.points);

      expect(window.maxX).toBeGreaterThan(window.minX);
      expect(window.maxY).toBeGreaterThan(window.minY);
      expect(holds(window, geometry.points[0]!)).toBe(true);
    }
  });

  it('starts a first deposit into an empty pool at the corner of the frame', () => {
    const geometry = geometryOf(['0', '0'], ['5', '300000']);
    const window = plotWindow(geometry.points, 0.8);

    expect([window.minX, window.minY]).toEqual([0, 0]);
    for (const point of geometry.points) expect(holds(window, point)).toBe(true);
  });

  it('never opens onto a negative reserve, however large the move', () => {
    const window = plotWindow(geometryOf(['1000000', '1'], ['1', '1000000']).points);

    expect(window.minX).toBeGreaterThanOrEqual(0);
    expect(window.minY).toBeGreaterThanOrEqual(0);
  });

  it('holds a marker orders of magnitude below the other one', () => {
    const geometry = geometryOf(['1000000', '0.0000000001'], ['0.0000000001', '1000000']);
    const window = plotWindow(geometry.points);

    for (const point of geometry.points) expect(holds(window, point)).toBe(true);
  });

  it('holds a pair whose two reserves are orders of magnitude apart', () => {
    // A satoshi-scale base against a six-figure quote: each axis is scaled by
    // its own reserve, so both points still land inside one window.
    const geometry = geometryOf(['0.00000001', '250000'], ['0.00000002', '125000']);
    const window = plotWindow(geometry.points);

    for (const point of geometry.points) expect(holds(window, point)).toBe(true);
  });

  it('writes the two ends of a zoomed axis far enough apart to read as different', () => {
    const geometry = geometryOf(['5', '300000'], ['5.00000001', '299999.4']);
    const window = plotWindow(geometry.points);
    const span = realSpan(window, geometry.baseScale, 'x');

    expect(tick(window.minX, geometry.baseScale, span)).not.toBe(tick(window.maxX, geometry.baseScale, span));
  });
});

describe('the curve drawn inside that window', () => {
  it('samples the invariant of the observation it was given, and no other', () => {
    const geometry = geometryOf(['5', '300000'], ['5.05', '297038.525897']);
    const window = plotWindow(geometry.points);
    const after = geometry.points[1]!;
    const product = after.x * after.y;

    for (const point of curveInWindow(after, window)) {
      expect(point.x * point.y).toBeCloseTo(product, 12);
    }
  });

  it('draws each observation on its own curve once a batch moved the invariant', () => {
    const geometry = geometryOf(['5', '300000'], ['5.05', '297038.525897']);
    const window = plotWindow(geometry.points);
    const before = curveInWindow(geometry.points[0]!, window);
    const after = curveInWindow(geometry.points[1]!, window);

    expect(before[0]!.x * before[0]!.y).not.toBeCloseTo(after[0]!.x * after[0]!.y, 20);
  });

  it('clips to the window rather than running off the frame', () => {
    const geometry = geometryOf(['100', '100'], ['25', '400']);
    const window = plotWindow(geometry.points);

    for (const point of curveInWindow(geometry.points[1]!, window)) {
      expect(holds(window, point)).toBe(true);
    }
  });

  it('keeps the clipped arc in one piece, so no chord crosses the gap', () => {
    const geometry = geometryOf(['100', '100'], ['25', '400']);
    const window = plotWindow(geometry.points);
    const points = curveInWindow(geometry.points[1]!, window);

    // y=k/x falls as x rises, so a correctly clipped arc is monotonic. A
    // polyline over a split range would break that.
    for (let index = 1; index < points.length; index += 1) {
      expect(points[index]!.x).toBeGreaterThan(points[index - 1]!.x);
      expect(points[index]!.y).toBeLessThan(points[index - 1]!.y);
    }
  });

  it('answers with nothing where the window holds no part of the curve', () => {
    const geometry = geometryOf(['5', '300000'], ['5.05', '297038.525897']);
    const elsewhere = { minX: 40, maxX: 50, minY: 40, maxY: 50 };

    expect(curveInWindow(geometry.points[1]!, elsewhere)).toEqual([]);
  });

  it('draws nothing for an observation with no invariant to draw', () => {
    const window = { minX: 0, maxX: 2, minY: 0, maxY: 2 };

    expect(curveInWindow({ x: 0, y: 1 }, window)).toEqual([]);
  });
});

describe('reading a plot coordinate back as a reserve', () => {
  it('multiplies the coordinate by the axis it was scaled against', () => {
    expect(axisAmount(1, '300000')).toBe('300000');
    expect(axisAmount(0.5, '5.05')).toBe('2.525');
  });

  it('keeps a scale a double could not hold', () => {
    // 28 integer digits is what a Daml Decimal carries, and the exact product
    // survives because the multiplication never becomes a number.
    expect(axisAmount(1, '1234567890123456789012.0123456789')).toBe(
      '1234567890123456789012.0123456789',
    );
  });

  it('answers nothing for a scale it cannot read, or a coordinate off the axis', () => {
    expect(axisAmount(1, 'unknown')).toBeNull();
    expect(axisAmount(Number.NaN, '5')).toBeNull();
    expect(axisAmount(-1, '5')).toBeNull();
  });
});
