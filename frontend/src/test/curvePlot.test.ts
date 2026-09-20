import { describe, expect, it } from 'vitest';
import type { PoolReserves } from '../lib/api/types';
import { axisAmount, curveInWindow, plotWindow } from '../features/settlement/curvePlot';
import { curveGeometry, type CurveGeometry } from '../features/settlement/reserves';

function reserves(base: string, quote: string): PoolReserves {
  return {
    stateId: `00state-${base}-${quote}`,
    baseReserve: base,
    quoteReserve: quote,
    spotPrice: '0',
    invariant: '0',
  };
}

function geometryOf(
  before: [string, string],
  after: [string, string],
): CurveGeometry {
  const geometry = curveGeometry(reserves(...before), reserves(...after));
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
    const window = plotWindow(geometry);

    expect(holds(window, geometry.beforePoint)).toBe(true);
    expect(holds(window, geometry.afterPoint)).toBe(true);
    // The window does not collapse onto the move: the two markers have to be
    // separable, not touching.
    expect(window.maxX - window.minX).toBeGreaterThan(
      Math.abs(geometry.afterPoint.x - geometry.beforePoint.x),
    );
  });

  it('shows a batch that moved a deep pool by a fraction of a percent', () => {
    // The figures a local venue reported for one confirmed batch: 5 BTC and
    // 300,000 USDC moving by 0.00016616 and 10. A window sized from the pool
    // rather than from the move would put both markers on one pixel.
    const geometry = geometryOf(['5', '300000'], ['4.99983384', '300010']);
    const window = plotWindow(geometry);
    const moved = Math.abs(geometry.afterPoint.x - geometry.beforePoint.x);

    expect(holds(window, geometry.beforePoint)).toBe(true);
    expect(holds(window, geometry.afterPoint)).toBe(true);
    // The move is a fifth of the frame or more, so the two markers are apart.
    expect(moved / (window.maxX - window.minX)).toBeGreaterThan(0.15);
  });

  it('holds both observations of a move that quarters one reserve', () => {
    const geometry = geometryOf(['100', '100'], ['25', '400']);
    const window = plotWindow(geometry);

    expect(holds(window, geometry.beforePoint)).toBe(true);
    expect(holds(window, geometry.afterPoint)).toBe(true);
  });

  it('opens a window around a pool no batch has moved', () => {
    const geometry = geometryOf(['5', '300000'], ['5', '300000']);
    const window = plotWindow(geometry);

    expect(window.maxX).toBeGreaterThan(window.minX);
    expect(window.maxY).toBeGreaterThan(window.minY);
    expect(holds(window, geometry.afterPoint)).toBe(true);
  });

  it('never opens onto a negative reserve, however large the move', () => {
    const window = plotWindow(geometryOf(['1000000', '1'], ['1', '1000000']));

    expect(window.minX).toBeGreaterThanOrEqual(0);
    expect(window.minY).toBeGreaterThanOrEqual(0);
  });

  it('holds a pair whose two reserves are orders of magnitude apart', () => {
    // A satoshi-scale base against a six-figure quote: each axis is scaled by
    // its own reserve, so both points still land inside one window.
    const geometry = geometryOf(['0.00000001', '250000'], ['0.00000002', '125000']);
    const window = plotWindow(geometry);

    expect(holds(window, geometry.beforePoint)).toBe(true);
    expect(holds(window, geometry.afterPoint)).toBe(true);
  });
});

describe('the curve drawn inside that window', () => {
  it('samples the invariant of the observation it was given, and no other', () => {
    const geometry = geometryOf(['5', '300000'], ['5.05', '297038.525897']);
    const window = plotWindow(geometry);
    const product = geometry.afterPoint.x * geometry.afterPoint.y;

    for (const point of curveInWindow(geometry.afterPoint, window)) {
      expect(point.x * point.y).toBeCloseTo(product, 12);
    }
  });

  it('draws the two curves apart, because retained fees raise the invariant', () => {
    const geometry = geometryOf(['5', '300000'], ['5.05', '297038.525897']);
    const window = plotWindow(geometry);
    const before = curveInWindow(geometry.beforePoint, window);
    const after = curveInWindow(geometry.afterPoint, window);

    expect(before[0]!.x * before[0]!.y).not.toBeCloseTo(after[0]!.x * after[0]!.y, 20);
  });

  it('clips to the window rather than running off the frame', () => {
    const geometry = geometryOf(['100', '100'], ['25', '400']);
    const window = plotWindow(geometry);

    for (const point of curveInWindow(geometry.afterPoint, window)) {
      expect(holds(window, point)).toBe(true);
    }
  });

  it('keeps the clipped arc in one piece, so no chord crosses the gap', () => {
    const geometry = geometryOf(['100', '100'], ['25', '400']);
    const window = plotWindow(geometry);
    const points = curveInWindow(geometry.afterPoint, window);

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

    expect(curveInWindow(geometry.afterPoint, elsewhere)).toEqual([]);
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
