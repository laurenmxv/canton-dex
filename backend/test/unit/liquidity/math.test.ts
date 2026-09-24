import { describe, expect, it } from 'vitest';
import {
  depositAmounts,
  initialSupply,
  MINIMUM_LIQUIDITY,
  ratio,
  requireRatio,
  withdrawalAmounts,
} from '../../../src/liquidity/math.js';
import { numericUnits } from '../../../src/platform/decimal.js';
import { Conflict } from '../../../src/platform/errors.js';

const d = numericUnits;
/** 200 at scale 20, the scale of a product of two amounts. */
const TWO_HUNDRED_SQUARED = d('200') * 10n ** 10n;

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof Conflict) return error.code;
    throw error;
  }
  return undefined;
}

describe('liquidity math', () => {
  it('keeps the permanent minimum backed through initialization and the final redemption', () => {
    const deposit = depositAmounts(d('10'), d('30'), d('2'), d('0'), d('0'), d('0'), 8, 6);
    expect(deposit.base).toBe(d('10'));
    expect(deposit.quote).toBe(d('20'));
    expect(deposit.quoteRefund).toBe(d('10'));
    expect(deposit.lp).toBe(d('14.1421355237'));
    const supply = deposit.lp + MINIMUM_LIQUIDITY;
    expect(supply).toBe(d('14.1421356237'));
    expect(supply * supply <= TWO_HUNDRED_SQUARED).toBe(true);
    expect((supply + 1n) * (supply + 1n) > TWO_HUNDRED_SQUARED).toBe(true);
    const withdrawal = withdrawalAmounts(deposit.lp, deposit.base, deposit.quote, supply, 8, 6);
    expect(deposit.base - withdrawal.base > 0n).toBe(true);
    expect(deposit.quote - withdrawal.quote > 0n).toBe(true);
    expect(supply - withdrawal.lp).toBe(MINIMUM_LIQUIDITY);
  });

  it('rounds proportional shares down and required inputs up, with refunds', () => {
    const deposit = depositAmounts(d('1'), d('3'), d('2'), d('3'), d('7'), d('5'), 8, 6);
    expect(deposit.lp).toBe(d('1.6666666666'));
    expect(deposit.base).toBe(d('1'));
    expect(deposit.quote).toBe(d('2.333334'));
    expect(deposit.quoteRefund).toBe(d('0.666666'));
    const withdrawal = withdrawalAmounts(d('1'), d('3'), d('7'), d('5'), 8, 6);
    expect(withdrawal.base).toBe(d('0.6'));
    expect(withdrawal.quote).toBe(d('1.4'));
    expect(() => {
      requireRatio(d('3'), d('7'), d('2'), d('2.3'));
    }).toThrow(Conflict);
  });

  it('accepts boundary products and rejects overflow like the ledger', () => {
    const boundary = d('999999999.9999999999');
    expect(initialSupply(boundary, boundary)).toBe(boundary);
    expect(ratio(boundary, boundary, d('1164153218269348144.5847505093'), 10, false)).toBe(d('0.8589934591'));
    expect(ratio(boundary, boundary, d('1164153218269348144.5847505093'), 10, true)).toBe(d('0.8589934592'));
    expect(code(() => initialSupply(d('1000000000'), d('1000000000')))).toBe('AMOUNT_TOO_LARGE');
    expect(() => ratio(d('1000000000'), d('1000000000'), d('1'), 10, false)).toThrow(Conflict);
    expect(code(() => depositAmounts(d('0.00000001'), d('0.00000001'), d('1'), 0n, 0n, 0n, 8, 8))).toBe(
      'AMOUNT_TOO_SMALL',
    );
  });
});
