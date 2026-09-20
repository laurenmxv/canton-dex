import { describe, expect, it } from 'vitest';
import {
  compareDecimals,
  decimalRatio,
  decimalText,
  formatDecimal,
  formatExact,
  fractionDigits,
  isLedgerDecimal,
  multiplyDecimals,
  parseDecimal,
  subtractDecimals,
} from '../lib/decimal';

/** Reads a value the venue sent, which is always a well-formed decimal string. */
function decimal(text: string) {
  const value = parseDecimal(text);
  if (!value) throw new Error(`${text} is not a decimal`);
  return value;
}

describe('reading a decimal', () => {
  it.each([
    ['1', 1n, 0],
    ['0.10', 10n, 2],
    ['-2.5', -25n, 1],
    ['300000.0000000000', 3000000000000000n, 10],
  ])('reads %s at the scale it was written', (text, units, scale) => {
    expect(parseDecimal(text)).toEqual({ units, scale });
  });

  it.each(['', ' ', '.', '1.', '.5', '1e6', '1,000', '0x10', 'NaN', '1 2'])(
    'refuses %s rather than guessing at it',
    (text) => {
      expect(parseDecimal(text)).toBeNull();
    },
  );
});

describe('what the ledger can carry', () => {
  // 28 integer digits and 10 fractional ones are the representation itself,
  // so nothing between zero and that bound is refused for being large.
  it.each([
    '1',
    '1000001',
    '9999999999999999999999999999',
    '9999999999999999999999999999.0000000001',
  ])('carries %s', (text) => {
    expect(isLedgerDecimal(text)).toBe(true);
  });

  it.each([
    ['a 29th integer digit', '10000000000000000000000000000'],
    ['an 11th fractional digit', '1.00000000001'],
    ['a sign', '-1'],
    ['a leading zero', '01'],
    ['an exponent', '1e6'],
    ['a bare point', '1.'],
  ])('refuses %s', (_case, text) => {
    expect(isLedgerDecimal(text)).toBe(false);
  });
});

describe('comparing amounts', () => {
  it('compares across scales, which is what a balance check does', () => {
    expect(compareDecimals(decimal('0.10'), decimal('0.1'))).toBe(0);
    expect(compareDecimals(decimal('9.9999999999'), decimal('10'))).toBe(-1);
    expect(compareDecimals(decimal('1000000.0000000001'), decimal('1000000'))).toBe(1);
  });

  it('separates two amounts a double cannot tell apart', () => {
    // 0.1 + 0.2 in binary floating point is not 0.3, and these two differ by
    // one unit at the tenth place, which a double rounds away entirely.
    expect(compareDecimals(decimal('9007199254740993'), decimal('9007199254740992'))).toBe(1);
    expect(compareDecimals(decimal('0.3000000000'), decimal('0.3000000001'))).toBe(-1);
  });
});

describe('the arithmetic a dashboard shows', () => {
  it('subtracts exactly, and keeps the sign a reserve moved in', () => {
    expect(decimalText(subtractDecimals(decimal('5.05'), decimal('5')))).toBe('0.05');
    expect(decimalText(subtractDecimals(decimal('297058.8235294118'), decimal('300000')))).toBe(
      '-2941.1764705882',
    );
  });

  it('multiplies exactly, so the invariant check is a check and not an estimate', () => {
    // A double gets 1500147.0588235296 for this product; the exact answer has
    // more digits than it can hold.
    const product = multiplyDecimals(decimal('5.05'), decimal('297058.8235294118'));
    expect(decimalText(product)).toBe('1500147.05882352959');
    expect(compareDecimals(product, decimal('1500147.0588235296'))).toBe(-1);
  });

  it('counts the fractional digits a token precision limit bounds', () => {
    expect(fractionDigits(decimal('0.10000000'))).toBe(1);
    expect(fractionDigits(decimal('0.000000001'))).toBe(9);
    expect(fractionDigits(decimal('12'))).toBe(0);
  });
});

describe('showing an amount', () => {
  it('groups thousands and bounds the fraction', () => {
    expect(formatDecimal('4200000.0000000000')).toBe('4,200,000.00');
    expect(formatDecimal('22919.6080412345')).toBe('22,919.608041');
    expect(formatDecimal('0.1')).toBe('0.10');
  });

  it('rounds the shown digits away from zero, and carries into the whole part', () => {
    expect(formatDecimal('0.9999999')).toBe('1.00');
    expect(formatDecimal('-0.9999999')).toBe('-1.00');
    expect(formatDecimal('1.2345675')).toBe('1.234568');
  });

  it('keeps every digit of a value a double would round', () => {
    expect(formatDecimal('123456789012345678.5', { minFractionDigits: 1, maxFractionDigits: 1 })).toBe(
      '123,456,789,012,345,678.5',
    );
  });

  it('shows what it cannot read untouched, rather than as a number it is not', () => {
    expect(formatDecimal('unknown')).toBe('unknown');
    expect(formatDecimal('')).toBe('');
  });

  it('drops the fraction entirely where none is asked for', () => {
    expect(formatDecimal('1000000', { minFractionDigits: 0 })).toBe('1,000,000');
  });
});

describe('a ratio for drawing', () => {
  it('bounds a pair of reserves into coordinates', () => {
    expect(decimalRatio(decimal('5'), decimal('5'))).toBe(1);
    expect(decimalRatio(decimal('2.5'), decimal('5'))).toBe(0.5);
  });

  it('answers nothing rather than infinity when there is nothing to divide by', () => {
    expect(decimalRatio(decimal('5'), decimal('0'))).toBeNull();
  });
});

describe('showing an amount to its last digit', () => {
  it('keeps every place an instrument carries, where six would read as nothing', () => {
    // One satoshi, and one wei-scale unit of a ten-decimal instrument.
    expect(formatExact('0.00000001', 8)).toBe('0.00000001');
    expect(formatExact('0.0000000001')).toBe('0.0000000001');
    expect(formatDecimal('0.00000001')).toBe('0.00');
  });

  it('narrows to the instrument’s own precision when it is known', () => {
    expect(formatExact('2941.1764705882', 6)).toBe('2,941.176471');
    expect(formatExact('2941.1764705882')).toBe('2,941.1764705882');
  });
});

describe('a ratio far below one', () => {
  it('survives the division rather than flooring to zero', () => {
    const tiny = decimalRatio(decimal('0.0000000001'), decimal('1000000'));
    expect(tiny).toBeGreaterThan(0);
    expect(tiny).toBeCloseTo(1e-16, 20);
  });
});
