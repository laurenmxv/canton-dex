import { describe, expect, it } from 'vitest';
import type { PoolReserves } from '../lib/api/types';
import { invariantMatchesReserves, reserveDelta, reserveGeometry } from '../features/settlement/reserves';

function reserves(base: string, quote: string): PoolReserves {
  return {
    stateId: `00state-${base}-${quote}`,
    baseReserve: base,
    quoteReserve: quote,
    spotPrice: '0',
    invariant: '0',
  };
}

describe('the points a pool moves between', () => {
  it('scales each axis by its own larger observation', () => {
    const geometry = reserveGeometry([reserves('100', '100'), reserves('25', '400')])!;

    expect(geometry.points).toEqual([
      { x: 1, y: 0.25 },
      { x: 0.25, y: 1 },
    ]);
    expect([geometry.baseScale, geometry.quoteScale]).toEqual(['100', '400']);
  });

  it('scales a whole trajectory by the largest reserve anywhere on it', () => {
    const geometry = reserveGeometry([reserves('4', '100'), reserves('8', '50'), reserves('2', '200')])!;

    expect(geometry.points.map((point) => point.x)).toEqual([0.5, 1, 0.25]);
    expect(geometry.points.map((point) => point.y)).toEqual([0.5, 0.25, 1]);
    expect([geometry.baseScale, geometry.quoteScale]).toEqual(['8', '200']);
  });

  it('keeps a point orders of magnitude below the other one above zero', () => {
    const geometry = reserveGeometry([
      reserves('1000000', '0.0000000001'),
      reserves('0.0000000001', '1000000'),
    ])!;

    expect(geometry.points[1]!.x).toBeGreaterThan(0);
    expect(geometry.points[0]!.y).toBeGreaterThan(0);
  });

  it('puts an empty pool at the origin once a first deposit gives the axes a scale', () => {
    const geometry = reserveGeometry([reserves('0', '0'), reserves('5', '300000')])!;

    expect(geometry.points).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
  });

  it('has no scale for an empty pool that nothing moves', () => {
    expect(reserveGeometry([reserves('0', '0')])).toBeNull();
  });

  it('answers nothing for a reserve it cannot read', () => {
    expect(reserveGeometry([reserves('unknown', '1'), reserves('1', '1')])).toBeNull();
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
