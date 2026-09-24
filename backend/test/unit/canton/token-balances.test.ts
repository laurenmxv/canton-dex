import { describe, expect, it } from 'vitest';
import type { HoldingView } from '../../../src/canton/contracts.js';
import { balances } from '../../../src/canton/token-ledger.js';

function holding(admin: string, instrument: string, amount: string, locked: boolean): HoldingView {
  return {
    account: { owner: 'trader', provider: null, id: '' },
    instrumentId: { admin, id: instrument },
    amount,
    locked,
  };
}

describe('token balances', () => {
  it('keeps same-named instruments from different issuers separate', () => {
    const result = balances(
      [
        holding('issuer-a', 'USD', '10', false),
        holding('issuer-a', 'USD', '2', true),
        holding('issuer-b', 'USD', '30', false),
        holding('unlisted', 'USD', '100', false),
      ],
      [
        { admin: 'issuer-a', id: 'USD', symbol: 'USD-A', decimals: 6 },
        { admin: 'issuer-b', id: 'USD', symbol: 'USD-B', decimals: 8 },
        { admin: 'issuer-b', id: 'BTC', symbol: 'BTC-B', decimals: 8 },
      ],
    );
    expect(result).toHaveLength(3);
    expect(result[0]?.instrument.admin).toBe('issuer-a');
    expect(result[0]?.available).toBe('10');
    expect(result[0]?.locked).toBe('2');
    expect(result[0]?.total).toBe('12');
    expect(result[1]?.instrument.admin).toBe('issuer-b');
    expect(result[1]?.available).toBe('30');
    expect(result[2]?.total).toBe('0');
  });
});
