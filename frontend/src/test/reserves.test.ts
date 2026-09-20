import { describe, expect, it } from 'vitest';
import type { PoolReserves } from '../lib/api/types';
import { curveGeometry, invariantMatchesReserves, reserveDelta } from '../features/settlement/reserves';

function reserves(base: string, quote: string): PoolReserves {
  return {
    stateId: `00state-${base}-${quote}`,
    baseReserve: base,
    quoteReserve: quote,
    spotPrice: '0',
    invariant: '0',
  };
}

/** True when a point is inside the window the curves were sampled over. */
function within(geometry: NonNullable<ReturnType<typeof curveGeometry>>, point: { x: number; y: number }) {
  const xs = geometry.afterCurve.map((at) => at.x);
  return point.x >= Math.min(...xs) && point.x <= Math.max(...xs) && point.y <= geometry.viewMax;
}

describe('the curve a batch moved along', () => {
  it('draws a window that contains both observations', () => {
    const geometry = curveGeometry(reserves('5', '300000'), reserves('5.05', '297038.525897'))!;

    expect(within(geometry, geometry.beforePoint)).toBe(true);
    expect(within(geometry, geometry.afterPoint)).toBe(true);
  });

  it('contains a marker a fixed window would have left off the chart', () => {
    // A valid movement of this size puts the after point at a quarter of the
    // larger base reserve, far below where a fixed start would begin.
    const geometry = curveGeometry(reserves('100', '100'), reserves('25', '400'))!;

    expect(geometry.afterPoint).toEqual({ x: 0.25, y: 1 });
    expect(within(geometry, geometry.beforePoint)).toBe(true);
    expect(within(geometry, geometry.afterPoint)).toBe(true);
  });

  it('contains a marker orders of magnitude below the other one', () => {
    const geometry = curveGeometry(reserves('1000000', '0.0000000001'), reserves('0.0000000001', '1000000'))!;

    expect(geometry.afterPoint.x).toBeGreaterThan(0);
    expect(within(geometry, geometry.beforePoint)).toBe(true);
    expect(within(geometry, geometry.afterPoint)).toBe(true);
  });

  it('draws the two curves apart, because retained fees raise the invariant', () => {
    const geometry = curveGeometry(reserves('5', '300000'), reserves('5.05', '297038.525897'))!;

    // Same x, different y: the point after a batch is not on the curve before it.
    expect(geometry.beforeCurve[0]!.y).not.toBe(geometry.afterCurve[0]!.y);
  });

  it('answers nothing for a reserve it cannot read', () => {
    expect(curveGeometry(reserves('unknown', '1'), reserves('1', '1'))).toBeNull();
  });
});

describe('what a batch actually changed', () => {
  it('subtracts the two confirmed observations exactly', () => {
    const delta = reserveDelta(reserves('5', '300000'), reserves('5.05', '297038.525897'))!;

    expect(delta).toEqual({ base: '0.05', quote: '-2961.474103' });
  });

  it('claims no change where one side was never recorded', () => {
    expect(reserveDelta(reserves('5', '300000'), null)).toBeNull();
    expect(reserveDelta(null, reserves('5', '300000'))).toBeNull();
  });
});

describe('the invariant check', () => {
  it('holds when the venue’s figure is the product of its own reserves', () => {
    expect(
      invariantMatchesReserves({ ...reserves('5.05', '297038.525897'), invariant: '1500044.55577985' }),
    ).toBe(true);
  });

  it('fails when it is not, rather than rounding the difference away', () => {
    expect(
      invariantMatchesReserves({ ...reserves('5.05', '297038.525897'), invariant: '1500044.5557798' }),
    ).toBe(false);
  });
});
