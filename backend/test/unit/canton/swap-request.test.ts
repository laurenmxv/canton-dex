import { describe, expect, it } from 'vitest';
import { MIN_OUT_KEY } from '../../../src/canton/allocations.js';
import type { Token } from '../../../src/canton/contracts.js';
import type { CreatedEvent } from '../../../src/canton/ledger.js';
import { AllocationInterface, byPackageId } from '../../../src/canton/packages.js';
import {
  settlementId,
  validateAllocation,
  type SwapRequestValue,
  type SwapRoute,
} from '../../../src/canton/swap-ledger.js';
import { numericText, numericUnits, trimmedText } from '../../../src/platform/decimal.js';

const DEADLINE = '2026-09-19T12:00:00Z';
const CREATED = '2026-09-19T11:59:00Z';

function token(id: string): Token {
  return {
    instrument: { admin: 'issuer', id },
    allocationFactory: 'factory',
    settlementFactory: 'factory',
    decimals: 8n,
  };
}

const ROUTE: SwapRoute = { dvo: 'dvo', venueOperator: 'operator', baseToken: token('BTC'), quoteToken: token('USDC') };

function request(direction: string, minimum: string): SwapRequestValue {
  return {
    poolCid: 'pool',
    trader: 'trader',
    terms: {
      requestId: 'request',
      direction,
      amountIn: numericUnits('10'),
      minOut: numericUnits(minimum),
      settlementDeadline: DEADLINE,
    },
    inputAllocation: 'input',
    outputAllocation: 'output',
  };
}

function allocation(
  swap: SwapRequestValue,
  input: boolean,
  pool: string,
  amount: string,
  trader: string,
  metadata: Record<string, string> = input ? { [MIN_OUT_KEY]: trimmedText(swap.terms.minOut) } : {},
): CreatedEvent {
  const base = input === (swap.terms.direction === 'BaseToQuote');
  const view = {
    originalAllocationCid: null,
    settlement: { executors: ['dvo', 'operator'], id: settlementId(swap.terms), cid: pool, meta: { values: {} } },
    allocation: {
      admin: 'issuer',
      authorizer: { owner: trader, provider: null, id: '' },
      transferLegSides: [],
      settlementDeadline: DEADLINE,
      nextIterationFunding: input ? { [base ? 'BTC' : 'USDC']: numericText(numericUnits(amount)) } : {},
      committed: true,
      meta: { values: metadata },
    },
    holdingCids: [],
    createdAt: CREATED,
    numIterations: '0',
    expiresAt: null,
    availableActions: {},
    meta: { values: {} },
  };
  return {
    offset: 1n,
    contractId: input ? 'input' : 'output',
    templateId: 'independent-token-package:Issuer:Allocation',
    createArgument: {},
    createdEventBlob: '',
    interfaceViews: [{ interfaceId: byPackageId(AllocationInterface), statusCode: 0, value: view }],
    signatories: [],
    observers: [],
    createdAt: CREATED,
  };
}

const MISMATCH = 'Confirmed allocations differ from the signed request';

describe('swap request allocations', () => {
  it('accepts iterated funding and canonical minimum metadata', () => {
    for (const direction of ['BaseToQuote', 'QuoteToBase']) {
      for (const minimum of ['9', '0', '9.0000000000', '0.00000001']) {
        const swap = request(direction, minimum);
        validateAllocation(allocation(swap, true, 'pool', '10', 'trader'), swap, ROUTE, true);
        validateAllocation(allocation(swap, false, 'pool', minimum, 'trader'), swap, ROUTE, false);
      }
    }
  });

  it('rejects an allocation bound to another pool or trader', () => {
    const swap = request('BaseToQuote', '9');
    expect(() => {
      validateAllocation(allocation(swap, true, 'another-pool', '10', 'trader'), swap, ROUTE, true);
    }).toThrow(MISMATCH);
    expect(() => {
      validateAllocation(allocation(swap, true, 'pool', '10', 'another-trader'), swap, ROUTE, true);
    }).toThrow(MISMATCH);
  });

  it('rejects changed input or minimum output terms even when the allocation ids match', () => {
    const swap = request('BaseToQuote', '9');
    expect(() => {
      validateAllocation(allocation(swap, true, 'pool', '11', 'trader'), swap, ROUTE, true);
    }).toThrow(MISMATCH);
    expect(() => {
      validateAllocation(allocation(swap, true, 'pool', '10', 'trader', { [MIN_OUT_KEY]: '8' }), swap, ROUTE, true);
    }).toThrow(MISMATCH);
  });

  it('rejects missing, noncanonical and unexpected minimum metadata', () => {
    const swap = request('BaseToQuote', '0');
    for (const metadata of [{}, { [MIN_OUT_KEY]: '0.0' }, { [MIN_OUT_KEY]: '0', extra: 'value' }]) {
      expect(() => {
        validateAllocation(allocation(swap, true, 'pool', '10', 'trader', metadata), swap, ROUTE, true);
      }).toThrow(MISMATCH);
    }
    expect(() => {
      validateAllocation(allocation(swap, false, 'pool', '0', 'trader', { [MIN_OUT_KEY]: '0' }), swap, ROUTE, false);
    }).toThrow(MISMATCH);
  });

  it('settlement identity binds both legs to the same economic terms', () => {
    const expected = request('BaseToQuote', '9');
    const other: SwapRequestValue = { ...expected, terms: { ...expected.terms, amountIn: numericUnits('1') } };
    expect(() => {
      validateAllocation(allocation(other, false, 'pool', '9', 'trader'), expected, ROUTE, false);
    }).toThrow(MISMATCH);
  });

  it('settlement identity uses the same integer units as Daml', () => {
    const terms = {
      requestId: 'request',
      direction: 'BaseToQuote',
      amountIn: numericUnits('10'),
      minOut: numericUnits('0.5'),
      settlementDeadline: '2026-01-01T00:10:00Z',
    };
    expect(settlementId(terms)).toBe('swap:request:BaseToQuote:100000000000:5000000000:1767226200000000');
  });

  it('settlement identity preserves integer units beyond int64', () => {
    const terms = {
      requestId: 'request',
      direction: 'BaseToQuote',
      amountIn: numericUnits('1000000000.0000000001'),
      minOut: numericUnits('9999999999.9999999999'),
      settlementDeadline: '2026-01-01T00:10:00Z',
    };
    expect(settlementId(terms)).toBe(
      'swap:request:BaseToQuote:10000000000000000001:99999999999999999999:1767226200000000',
    );
  });
});
