import { describe, expect, it } from 'vitest';
import { numericText } from '../../../src/platform/decimal.js';
import { InvalidRequest } from '../../../src/platform/errors.js';
import { decimal, pairKey, proposalTerms, type CreateProposal, type Options } from '../../../src/pools/model.js';
import type { Instrument } from '../../../src/tokens/model.js';

const OPTIONS: Options = {
  factoryId: 'factory',
  dvo: 'dvo',
  venueOperator: 'operator',
  instruments: [
    { admin: 'a', id: 'A', symbol: 'A', decimals: 6 },
    { admin: 'a', id: 'USD', symbol: 'USD', decimals: 6 },
    { admin: 'b', id: 'B', symbol: 'B', decimals: 8 },
    { admin: 'b', id: 'BTC', symbol: 'BTC', decimals: 8 },
    { admin: 'b', id: 'USD', symbol: 'USD', decimals: 8 },
  ],
};

function input(base: Instrument, quote: Instrument, feeBps: string): CreateProposal {
  return { name: 'A / B', baseInstrumentId: base, quoteInstrumentId: quote, feeBps };
}

function key(base: Instrument, quote: Instrument): string {
  const terms = proposalTerms(input(base, quote, '30'), OPTIONS);
  return pairKey(terms.baseInstrumentId, terms.quoteInstrumentId);
}

describe('pool terms', () => {
  it('pair identity ignores direction but includes administrators', () => {
    const a = { admin: 'a', id: 'USD' };
    const b = { admin: 'b', id: 'BTC' };
    expect(key(a, b)).toBe(key(b, a));
    expect(key(a, b)).not.toBe(key({ admin: 'b', id: 'USD' }, b));
    expect(proposalTerms(input(a, b, '30'), OPTIONS).dvo).toBe('dvo');
  });

  it('enforces decimal limits and fees without floating point', () => {
    for (const invalid of ['1e3', 'NaN', '-1', '1.00000000001', '10000000000000000000000000000', ' 1']) {
      expect(() => decimal(invalid)).toThrow(InvalidRequest);
    }
    expect(numericText(decimal('9999999999999999999999999999.1234567890'))).toBe(
      '9999999999999999999999999999.1234567890',
    );
    for (const fee of ['10000', '-1']) {
      expect(() => proposalTerms(input({ admin: 'a', id: 'A' }, { admin: 'b', id: 'B' }, fee), OPTIONS)).toThrow(
        InvalidRequest,
      );
    }
    expect(proposalTerms(input({ admin: 'a', id: 'A' }, { admin: 'b', id: 'B' }, '0'), OPTIONS).feeBps).toBe('0');
  });

  it('rejects malformed, unregistered and duplicate instruments', () => {
    const pairs: [Instrument, Instrument][] = [
      [
        { admin: 'outside', id: 'A' },
        { admin: 'b', id: 'B' },
      ],
      [
        { admin: 'a', id: 'A' },
        { admin: 'a', id: 'A' },
      ],
      [
        { admin: 'a', id: 'A\nB' },
        { admin: 'b', id: 'B' },
      ],
    ];
    for (const [base, quote] of pairs) {
      expect(() => proposalTerms(input(base, quote, '30'), OPTIONS)).toThrow(InvalidRequest);
    }
  });
});
