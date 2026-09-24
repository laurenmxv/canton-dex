import { describe, expect, it } from 'vitest';
import { numericUnits } from '../../../src/platform/decimal.js';
import { InvalidRequest } from '../../../src/platform/errors.js';
import { swapOutput, tokenAmount } from '../../../src/swaps/math.js';

const d = numericUnits;

function vector(scale: number, fee: string, reserveIn: string, reserveOut: string, amount: string, expected: string) {
  expect(swapOutput(d(reserveIn), d(reserveOut), d(amount), d(fee), scale)).toBe(d(expected));
}

describe('swap math', () => {
  it('matches the Daml reference vectors', () => {
    vector(6, '30', '1000000', '500', '1000', '0.498003');
    vector(8, '30', '1000000', '500', '1000', '0.49800349');
    vector(10, '30', '1000000', '500', '1000', '0.4980034905');
    vector(10, '0', '1', '1', '2', '0.6666666666');
    vector(0, '0', '1', '2', '1', '1');
    vector(10, '30', '997', '1000', '1000', '500');
    vector(10, '0', '1000000', '1000000', '1000000', '500000');
  });

  it('prices amounts and reserves above one million', () => {
    vector(10, '0', '2000000', '6000000', '2000000', '3000000');
    vector(10, '30', '2991000', '6000000', '3000000', '3000000');
    vector(6, '30', '997', '1000', '1000000000', '999.999');
  });

  it('never rounds dust up to one token quantum', () => {
    vector(6, '0', '1000000', '1000000', '0.000001', '0');
    vector(10, '0', '1000000', '1000000', '0.0000000001', '0');
    vector(8, '30', '1', '1', '0.000001', '0.00000099');
    vector(10, '30', '1', '1', '0.000001', '0.0000009969');
  });

  it('accepts native decimal amounts and enforces the token precision', () => {
    for (const valid of ['1000000.0000000001', '1000000000000000000000000000', '0.0000000001']) {
      expect(tokenAmount(valid, 10, false)).toBe(d(valid));
    }
    expect(tokenAmount('0.1000000000', 8, false)).toBe(d('0.1'));
    expect(tokenAmount('0', 6, true)).toBe(0n);
    expect(() => tokenAmount('0.000000001', 8, false)).toThrow(InvalidRequest);
    for (const invalid of ['0', '-1', '10000000000000000000000000000', '0.00000000001', '1e3', '01', '1 ']) {
      expect(() => tokenAmount(invalid, 10, false), invalid).toThrow(InvalidRequest);
    }
  });
});
