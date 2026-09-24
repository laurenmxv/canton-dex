import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { jsonText } from '../../../src/platform/json.js';
import type { Fill } from '../../../src/settlements/model.js';
import { readFill } from '../../../src/settlements/store.js';
import { swap } from './fixtures.js';

describe('settlement models', () => {
  it('typed fills preserve instruments, actual amounts and decimal strings', () => {
    const fills: Fill[] = [
      {
        requestId: randomUUID(),
        amountOut: '999999.123456',
        outputInstrument: { admin: 'issuer', id: 'USDC' },
        type: 'swap',
      },
      {
        requestId: randomUUID(),
        actualBaseIn: '1',
        actualQuoteIn: '2',
        actualBaseRefund: '0.01',
        actualQuoteRefund: '0',
        actualLpOut: '1.2345678900',
        type: 'deposit',
      },
      {
        requestId: randomUUID(),
        actualLpBurned: '0.0000000001',
        actualBaseOut: '0.01',
        actualQuoteOut: '0.02',
        type: 'withdraw',
      },
    ];
    const encoded = jsonText(fills);
    for (const part of [
      '"type":"swap"',
      '"type":"deposit"',
      '"type":"withdraw"',
      '"actualLpOut":"1.2345678900"',
      '"actualLpBurned":"0.0000000001"',
    ]) {
      expect(encoded).toContain(part);
    }
    const decoded = (JSON.parse(encoded) as unknown[]).map(readFill);
    expect(decoded).toEqual(fills);
    expect((JSON.parse(jsonText(decoded)) as unknown[]).map(readFill)).toEqual(fills);
  });

  it('the queue wire format separates scheduling from the ledger status', () => {
    const wrapped = swap(1n);
    const tree = JSON.parse(jsonText(wrapped)) as { deferred: unknown; type: unknown; request: { swapId: unknown } };
    expect(Object.keys(tree)).toHaveLength(3);
    expect(tree.deferred).toBe(false);
    expect(tree.type).toBe('swap');
    expect(tree.request.swapId).toBe(wrapped.type === 'swap' ? wrapped.request.swapId : undefined);
  });
});
