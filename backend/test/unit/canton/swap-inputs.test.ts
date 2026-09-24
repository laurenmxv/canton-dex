import { describe, expect, it } from 'vitest';
import type { CreatedEvent } from '../../../src/canton/ledger.js';
import { byPackageId, HoldingInterface } from '../../../src/canton/packages.js';
import { selectInputs } from '../../../src/canton/pools.js';
import { numericText, numericUnits } from '../../../src/platform/decimal.js';
import { Conflict } from '../../../src/platform/errors.js';
import type { Instrument } from '../../../src/tokens/model.js';

const TOKEN: Instrument = { admin: 'issuer', id: 'USDC' };

function holding(
  id: string,
  amount: string,
  owner = 'trader',
  instrument: Instrument = TOKEN,
  lock: unknown = null,
): CreatedEvent {
  return {
    offset: 1n,
    contractId: id,
    templateId: `issuer-package-${instrument.admin}:Issuer:Holding`,
    createArgument: {},
    createdEventBlob: '',
    interfaceViews: [
      {
        interfaceId: byPackageId(HoldingInterface),
        statusCode: 0,
        value: {
          account: { owner, provider: null, id: '' },
          instrumentId: instrument,
          amount: numericText(numericUnits(amount)),
          lock,
          meta: { values: {} },
        },
      },
    ],
    signatories: [],
    observers: [],
    createdAt: '2026-09-19T00:00:00Z',
  };
}

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof Conflict) return error.code;
    throw error;
  }
  return undefined;
}

describe('swap inputs', () => {
  it('uses one large holding despite sixteen earlier small holdings', () => {
    const holdings = Array.from({ length: 16 }, (_, i) => holding(`a-${String(i)}`, '0.01'));
    holdings.push(holding('z-large', '100'));
    expect(selectInputs(holdings, 'trader', TOKEN, numericUnits('1'))).toEqual(['z-large']);
  });

  it('breaks equal amount ties by contract id regardless of ledger order', () => {
    const holdings = [holding('c', '1'), holding('b', '2'), holding('a', '2')];
    expect(selectInputs(holdings, 'trader', TOKEN, numericUnits('3'))).toEqual(['a', 'b']);
    expect(selectInputs(holdings.toReversed(), 'trader', TOKEN, numericUnits('3'))).toEqual(['a', 'b']);
  });

  it('prefers unlocked holdings and leaves lock policy to the token factory', () => {
    const lock = { holders: ['trader'], expiresAt: null, expiresAfter: null, context: null };
    const holdings = [
      holding('available', '1'),
      holding('locked', '100', 'trader', TOKEN, lock),
      holding('other-owner', '100', 'other-trader'),
      holding('other-token', '100', 'trader', { admin: 'issuer', id: 'BTC' }),
    ];
    expect(selectInputs(holdings, 'trader', TOKEN, numericUnits('1'))).toEqual(['available']);
    expect(selectInputs(holdings, 'trader', TOKEN, numericUnits('2'))).toEqual(['available', 'locked']);
    expect(code(() => selectInputs(holdings, 'trader', TOKEN, numericUnits('102')))).toBe('INSUFFICIENT_BALANCE');
  });

  it('still rejects an input that needs seventeen holdings', () => {
    const holdings = Array.from({ length: 17 }, (_, i) => holding(`holding-${String(i)}`, '1'));
    expect(code(() => selectInputs(holdings, 'trader', TOKEN, numericUnits('17')))).toBe('TOO_MANY_HOLDINGS');
  });
});
