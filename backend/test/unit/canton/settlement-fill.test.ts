import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CreatedEvent, LedgerEvent, Transaction } from '../../../src/canton/ledger.js';
import { byPackageId, PoolState, SwapReceipt } from '../../../src/canton/packages.js';
import { confirm, projected, stopPreview, validStep } from '../../../src/canton/settlement-ledger.js';
import { numericText, numericUnits } from '../../../src/platform/decimal.js';
import {
  reference,
  swapRequest,
  type Fill,
  type Pending,
  type PreviewStep,
  type ProjectedPoolState,
  type Snapshot,
} from '../../../src/settlements/model.js';
import { RequestBlocked } from '../../../src/settlements/ports.js';
import type { Direction, Swap } from '../../../src/swaps/model.js';
import type { Instrument } from '../../../src/tokens/model.js';

const NOW = '2026-09-19T00:00:00Z';
const DEADLINE = '2026-09-19T00:01:00Z';
const BTC: Instrument = { admin: 'btc-admin', id: 'BTC' };
const USDC: Instrument = { admin: 'usdc-admin', id: 'USDC' };

function swap(direction: Direction, input: Instrument, output: Instrument): Swap {
  const id = randomUUID();
  return {
    swapId: id,
    quoteId: randomUUID(),
    poolId: 'pool',
    poolName: 'Pool',
    trader: 'trader',
    direction,
    inputInstrument: input,
    outputInstrument: output,
    amountIn: '1',
    expectedOut: '18',
    feeAmount: '0.003',
    minOut: '0',
    settlementDeadline: DEADLINE,
    status: 'SETTLING',
    arrivalSequence: 1n,
    createdAt: NOW,
    submittedAt: NOW,
    updatedAt: NOW,
    settlementId: null,
    amountOut: null,
    allocationCids: [`input-${id}`, `output-${id}`],
    updateId: null,
    errorCode: null,
    error: null,
    canWithdraw: false,
  };
}

function pending(swaps: Swap[]): Pending {
  const id = randomUUID();
  return {
    settlement: {
      settlementId: id,
      poolId: 'pool',
      trigger: 'MANUAL',
      status: 'SUBMITTING',
      requests: swaps.map((item) => ({ type: 'swap', requestId: item.swapId })),
      fills: [],
      before: { stateId: 'before-state', baseReserve: '100', quoteReserve: '200', spotPrice: '2', invariant: '20000' },
      after: null,
      policyVersion: 0n,
      createdAt: NOW,
      updatedAt: NOW,
      updateId: null,
      errorCode: null,
      error: null,
      retryOf: null,
    },
    requests: swaps.map((item) => swapRequest(item)),
    commandId: id,
    beginOffset: 42n,
    stateVersion: 'before-state:config',
    selection: null,
  };
}

function created(id: string, templateId: string, createArgument: unknown): LedgerEvent {
  const event: CreatedEvent = {
    offset: 43n,
    contractId: id,
    templateId,
    createArgument,
    createdEventBlob: '',
    interfaceViews: [],
    signatories: [],
    observers: [],
    createdAt: NOW,
  };
  return { created: event };
}

function receipt(batch: Pending, item: Swap, amount: string, direction: Direction): LedgerEvent {
  const [inputAllocation, outputAllocation] = item.allocationCids;
  return created(`receipt-${item.swapId}`, byPackageId(SwapReceipt), {
    dvo: 'dvo',
    venueOperator: 'operator',
    trader: item.trader,
    poolCid: item.poolId,
    inputAllocation,
    outputAllocation,
    batchId: batch.settlement.settlementId,
    terms: {
      requestId: item.swapId,
      direction,
      amountIn: numericText(numericUnits(item.amountIn)),
      minOut: numericText(numericUnits(item.minOut)),
      settlementDeadline: item.settlementDeadline,
    },
    amountOut: numericText(numericUnits(amount)),
    settledAt: NOW,
  });
}

function transaction(...receipts: LedgerEvent[]): Transaction {
  const state = {
    poolCid: 'pool',
    dvo: 'dvo',
    venueOperator: 'operator',
    baseReserve: '100.0000000000',
    quoteReserve: '201.0000000000',
    lpTokenSupply: '1000.0000000000',
    baseHoldingCids: [],
    quoteHoldingCids: [],
  };
  return {
    updateId: 'confirmed-update',
    commandId: '',
    offset: 43n,
    synchronizerId: 'synchronizer',
    recordTime: NOW,
    effectiveAt: NOW,
    events: [...receipts, created('after-state', byPackageId(PoolState), state)],
  };
}

describe('settlement fills', () => {
  it('mixed-direction receipts carry each request output instrument in batch order', () => {
    const sellBase = swap('BaseToQuote', BTC, USDC);
    const sellQuote = swap('QuoteToBase', USDC, BTC);
    const batch = pending([sellBase, sellQuote]);
    const tx = transaction(
      receipt(batch, sellQuote, '0.00123456', 'QuoteToBase'),
      receipt(batch, sellBase, '18.123456', 'BaseToQuote'),
    );
    const result = confirm(tx, batch);
    expect(result.fills.map((fill) => fill.requestId)).toEqual([sellBase.swapId, sellQuote.swapId]);
    expect(result.fills.map((fill) => (fill.type === 'swap' ? fill.outputInstrument : null))).toEqual([USDC, BTC]);
    expect(result.fills.map((fill) => (fill.type === 'swap' ? fill.amountOut : null))).toEqual([
      '18.123456',
      '0.00123456',
    ]);
  });

  it('a receipt with another direction cannot mislabel the payment', () => {
    const item = swap('BaseToQuote', BTC, USDC);
    const batch = pending([item]);
    const tx = transaction(receipt(batch, item, '18.123456', 'QuoteToBase'));
    expect(() => confirm(tx, batch)).toThrow('Confirmed receipt direction differs from the request');
  });

  it('the forecast stops at the blocker without moving the remaining requests', () => {
    const requests = [
      swapRequest(swap('BaseToQuote', BTC, USDC)),
      swapRequest(swap('BaseToQuote', BTC, USDC)),
      swapRequest(swap('QuoteToBase', USDC, BTC)),
    ];
    const snapshot: Snapshot = {
      poolId: 'pool',
      version: 'state:config',
      reserves: { stateId: 'state', baseReserve: '100', quoteReserve: '200', spotPrice: '2', invariant: '20000' },
      feeBps: '30',
      health: 'READY',
      reason: null,
      observedAt: NOW,
      ledgerOffset: 1n,
      lpTokenSupply: '10',
      initialRatio: '2',
    };
    const [first, second] = requests;
    if (!first || !second) throw new Error('Three requests');
    const initial = projected(snapshot);
    const after: ProjectedPoolState = {
      baseReserve: '101',
      quoteReserve: '198.1',
      lpTokenSupply: '10',
      spotPrice: '1.9613861386',
      invariant: '20008.1',
    };
    const fill: Fill = {
      requestId: reference(first).requestId,
      amountOut: '1.9',
      outputInstrument: USDC,
      type: 'swap',
    };
    const trace: PreviewStep[] = [];
    trace.push(validStep(first, fill, trace, initial, after));
    stopPreview(snapshot, requests, trace, new RequestBlocked(reference(second), 'MIN_OUT', 'Minimum not met'));
    expect(trace.map((step) => step.status)).toEqual(['VALID', 'BLOCKED', 'NOT_EVALUATED']);
    expect(trace[0]?.after).toEqual(after);
    expect(trace[0]?.outputs).toEqual([{ instrument: USDC, amount: '1.9', minimum: '0', headroomBps: '10000' }]);
    for (const step of trace.slice(1)) {
      expect(step.before).toEqual(after);
      expect(step.after).toBeNull();
      expect(step.fill).toBeNull();
    }
  });
});
