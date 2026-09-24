import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MIN_BASE_OUT_KEY, MIN_LP_OUT_KEY, MIN_QUOTE_OUT_KEY } from '../../../src/canton/allocations.js';
import type { PoolContract, Token } from '../../../src/canton/contracts.js';
import type { CreatedEvent, ExercisedEvent, LedgerEvent, Transaction } from '../../../src/canton/ledger.js';
import { liquiditySettlementId, settlementResult, validateAllocation } from '../../../src/canton/liquidity-ledger.js';
import { AllocationInterface, byPackageId, LiquidityReceipt, Pool } from '../../../src/canton/packages.js';
import { validStep } from '../../../src/canton/settlement-ledger.js';
import type { Kind, Request, Terms } from '../../../src/liquidity/model.js';
import { numericText, numericUnits } from '../../../src/platform/decimal.js';
import { liquidityRequest, type ProjectedPoolState } from '../../../src/settlements/model.js';

const FIRST_RECEIPT = 'first-receipt';
const SECOND_RECEIPT = 'second-receipt';
const RECEIPT_MISMATCH = 'Liquidity receipt differs from the settled request';
const ALLOCATION_MISMATCH = /differs from the signed request/;
const NOW = '2026-09-22T12:00:00Z';
const DEADLINE = '2026-09-22T12:10:00Z';
const EMPTY = { context: { values: {} }, meta: { values: {} } };
const TOKEN_ARGS = {
  baseAllocationArgs: EMPTY,
  quoteAllocationArgs: EMPTY,
  lpAllocationArgs: EMPTY,
  baseSettlementArgs: EMPTY,
  quoteSettlementArgs: EMPTY,
  lpSettlementArgs: EMPTY,
};
const KINDS: readonly Kind[] = ['DEPOSIT', 'WITHDRAW'];

function token(admin: string, id: string): Token {
  return {
    instrument: { admin, id },
    allocationFactory: 'allocation-factory',
    settlementFactory: 'settlement-factory',
    decimals: 10n,
  };
}

const POOL: PoolContract = {
  dvo: 'dvo',
  venueOperator: 'operator',
  baseToken: token('issuer', 'BASE'),
  quoteToken: token('issuer', 'QUOTE'),
  lpToken: token('dvo', 'LP'),
  baseAccount: { owner: 'dvo', provider: 'operator', id: 'base' },
  quoteAccount: { owner: 'dvo', provider: 'operator', id: 'quote' },
};

function decimal(value: string): string {
  return numericText(numericUnits(value));
}

function request(kind: Kind, zeroMinimum = false): Request {
  const shared = {
    poolId: 'pool',
    poolName: 'Pool',
    trader: 'trader',
    baseInstrument: { admin: 'issuer', id: 'BASE' },
    quoteInstrument: { admin: 'issuer', id: 'QUOTE' },
    lpInstrument: { admin: 'dvo', id: 'LP' },
  };
  const terms: Terms =
    kind === 'DEPOSIT'
      ? {
          ...shared,
          mode: 'PROPORTIONAL',
          maxBaseAmount: '10',
          maxQuoteAmount: '20',
          expectedBaseAmount: '10',
          expectedQuoteAmount: '20',
          expectedBaseRefund: '0',
          expectedQuoteRefund: '0',
          expectedLpOut: '14',
          minLpOut: zeroMinimum ? '0' : '13',
          minRatio: '1.9',
          maxRatio: '2.1',
          initialMinimumLp: null,
          settlementDeadline: DEADLINE,
        }
      : {
          ...shared,
          lpAmount: '2',
          expectedBaseOut: '1',
          expectedQuoteOut: '2',
          minBaseOut: zeroMinimum ? '0' : '0.9',
          minQuoteOut: zeroMinimum ? '0' : '1.9',
          settlementDeadline: DEADLINE,
        };
  const requestId = randomUUID();
  return {
    requestId,
    quoteId: randomUUID(),
    kind,
    terms,
    status: 'SETTLING',
    arrivalSequence: 1n,
    createdAt: NOW,
    submittedAt: NOW,
    updatedAt: NOW,
    settlementId: null,
    result: null,
    allocationCids: [`${requestId}-base`, `${requestId}-quote`, `${requestId}-lp`],
    updateId: null,
    errorCode: null,
    error: null,
    canRecover: false,
  };
}

interface Specification {
  admin: string;
  authorizer: unknown;
  transferLegSides: unknown[];
  settlementDeadline: string;
  nextIterationFunding: Record<string, string> | null;
  committed: boolean;
  meta: { values: Record<string, string> };
}

function specification(liquidity: Request, index: number): Specification {
  const instrument = ['BASE', 'QUOTE', 'LP'][index] ?? '';
  const metadata: Record<string, string> = {};
  let funding: Record<string, string> | null = {};
  let legs: unknown[] = [];
  const terms = liquidity.terms;
  if ('mode' in terms) {
    if (index < 2) funding = { [instrument]: decimal(index === 0 ? terms.maxBaseAmount : terms.maxQuoteAmount) };
    else metadata[MIN_LP_OUT_KEY] = terms.minLpOut;
  } else if (index < 2) {
    metadata[index === 0 ? MIN_BASE_OUT_KEY : MIN_QUOTE_OUT_KEY] = index === 0 ? terms.minBaseOut : terms.minQuoteOut;
  } else {
    funding = null;
    legs = [
      {
        transferLegId: 'lp-burn',
        side: 'SenderSide',
        otherside: { owner: null, provider: null, id: 'cip-112/burn' },
        amount: decimal(terms.lpAmount),
        instrumentId: instrument,
        meta: { values: {} },
      },
    ];
  }
  return {
    admin: index === 2 ? 'dvo' : 'issuer',
    authorizer: { owner: 'trader', provider: null, id: '' },
    transferLegSides: legs,
    settlementDeadline: DEADLINE,
    nextIterationFunding: funding,
    committed: true,
    meta: { values: metadata },
  };
}

function allocation(liquidity: Request, index: number, spec: Specification): CreatedEvent {
  const view = {
    originalAllocationCid: null,
    settlement: {
      executors: ['dvo', 'operator'],
      id: liquiditySettlementId(liquidity),
      cid: 'pool',
      meta: { values: {} },
    },
    allocation: spec,
    holdingCids: [],
    createdAt: NOW,
    numIterations: '0',
    expiresAt: null,
    availableActions: {},
    meta: { values: {} },
  };
  return {
    offset: 1n,
    contractId: liquidity.allocationCids[index] ?? '',
    templateId: 'independent-token-package:Issuer:Allocation',
    createArgument: {},
    createdEventBlob: '',
    interfaceViews: [{ interfaceId: byPackageId(AllocationInterface), statusCode: 0, value: view }],
    signatories: [],
    observers: [],
    createdAt: NOW,
  };
}

/** One request of a pool batch choice, with the outcome the pool returns for it. */
function batchEntry(liquidity: Request, allocations: readonly string[], changedTerms: boolean) {
  const [baseAllocation, quoteAllocation, lpAllocation] = allocations;
  const deposit = liquidity.kind === 'DEPOSIT';
  const terms = deposit
    ? {
        requestId: liquidity.requestId,
        mode: 'Proportional',
        maxBaseAmount: decimal(changedTerms ? '11' : '10'),
        maxQuoteAmount: decimal('20'),
        minLpOut: decimal('13'),
        minRatio: decimal('1.9'),
        maxRatio: decimal('2.1'),
        settlementDeadline: DEADLINE,
      }
    : {
        requestId: liquidity.requestId,
        lpAmount: decimal(changedTerms ? '3' : '2'),
        minBaseOut: decimal('0.9'),
        minQuoteOut: decimal('1.9'),
        settlementDeadline: DEADLINE,
      };
  const outcome = deposit
    ? {
        baseAmount: decimal('10'),
        quoteAmount: decimal('20'),
        baseRefund: decimal('0'),
        quoteRefund: decimal('0'),
        lpAmount: decimal('14'),
      }
    : { baseAmount: decimal('1'), quoteAmount: decimal('2'), lpAmount: decimal('2') };
  return {
    request: {
      request: { poolCid: 'pool', trader: 'trader', terms, baseAllocation, quoteAllocation, lpAllocation },
      tokenArgs: TOKEN_ARGS,
    },
    outcome,
  };
}

/** The pool's batch choice over the entries, returning `receipts` in the given order. */
function poolBatch(
  kind: Kind,
  entries: readonly ReturnType<typeof batchEntry>[],
  receipts: readonly string[],
): LedgerEvent {
  const exercised: ExercisedEvent = {
    contractId: 'pool',
    templateId: byPackageId(Pool),
    choice: kind === 'DEPOSIT' ? 'Pool_AddLiquidity' : 'Pool_WithdrawLiquidity',
    consuming: false,
    actingParties: ['dvo', 'operator'],
    choiceArgument: {
      configCid: 'config',
      stateCid: 'before-state',
      requests: entries.map((entry) => entry.request),
    },
    exerciseResult: {
      stateCid: 'after-state',
      receiptCids: receipts,
      outcomes: entries.map((entry) => entry.outcome),
    },
  };
  return { exercised };
}

function exercise(liquidity: Request, allocations: readonly string[], changedTerms: boolean, receiptId: string) {
  return poolBatch(liquidity.kind, [batchEntry(liquidity, allocations, changedTerms)], [receiptId]);
}

function receipt(liquidity: Request, id: string): LedgerEvent {
  const outcome =
    liquidity.kind === 'DEPOSIT'
      ? {
          tag: 'LiquidityDeposited',
          value: {
            baseAmount: decimal('10'),
            quoteAmount: decimal('20'),
            baseRefund: decimal('0'),
            quoteRefund: decimal('0'),
            lpAmount: decimal('14'),
          },
        }
      : {
          tag: 'LiquidityWithdrawn',
          value: { baseAmount: decimal('1'), quoteAmount: decimal('2'), lpAmount: decimal('2') },
        };
  return {
    created: {
      offset: 1n,
      contractId: id,
      templateId: byPackageId(LiquidityReceipt),
      createArgument: {
        dvo: 'dvo',
        venueOperator: 'operator',
        trader: 'trader',
        poolCid: 'pool',
        requestId: liquidity.requestId,
        outcome,
        settledAt: NOW,
      },
      createdEventBlob: '',
      interfaceViews: [],
      signatories: [],
      observers: [],
      createdAt: NOW,
    },
  };
}

function transaction(...events: LedgerEvent[]): Transaction {
  return {
    updateId: 'update',
    commandId: '',
    offset: 1n,
    synchronizerId: 'synchronizer',
    recordTime: NOW,
    effectiveAt: NOW,
    events,
  };
}

/** One batch exercise that settles both requests, returning `receipts` in the given order. */
function batch(first: Request, second: Request, receipts: readonly string[]): LedgerEvent {
  return poolBatch(
    first.kind,
    [batchEntry(first, first.allocationCids, false), batchEntry(second, second.allocationCids, false)],
    receipts,
  );
}

describe('liquidity ledger', () => {
  it('validates iterated funding and minimum metadata, including zero', () => {
    for (const kind of KINDS) {
      for (const zero of [false, true]) {
        const liquidity = request(kind, zero);
        for (let index = 0; index < 3; index += 1) {
          validateAllocation(allocation(liquidity, index, specification(liquidity, index)), liquidity, POOL, index);
        }
      }
    }
  });

  it('rejects missing, changed, noncanonical and unexpected metadata', () => {
    for (const kind of KINDS) {
      const liquidity = request(kind, true);
      for (let index = 0; index < 3; index += 1) {
        const spec = specification(liquidity, index);
        const invalid: Record<string, string>[] = [{ unexpected: 'value' }];
        const [key] = Object.keys(spec.meta.values);
        if (key !== undefined) invalid.push({}, { [key]: '1' }, { [key]: '0.0' });
        for (const values of invalid) {
          const changed = { ...spec, meta: { values } };
          expect(() => {
            validateAllocation(allocation(liquidity, index, changed), liquidity, POOL, index);
          }).toThrow(ALLOCATION_MISMATCH);
        }
      }
    }
  });

  it('rejects changed funding and additional initial legs', () => {
    for (const kind of KINDS) {
      const liquidity = request(kind);
      for (let index = 0; index < 3; index += 1) {
        const spec = specification(liquidity, index);
        const changed = { ...spec, nextIterationFunding: { WRONG: decimal('1') } };
        expect(() => {
          validateAllocation(allocation(liquidity, index, changed), liquidity, POOL, index);
        }).toThrow(ALLOCATION_MISMATCH);
        const extraLeg = {
          ...spec,
          transferLegSides: [
            ...spec.transferLegSides,
            {
              transferLegId: 'extra',
              side: 'ReceiverSide',
              otherside: spec.authorizer,
              amount: decimal('1'),
              instrumentId: 'BASE',
              meta: { values: {} },
            },
          ],
        };
        expect(() => {
          validateAllocation(allocation(liquidity, index, extraLeg), liquidity, POOL, index);
        }).toThrow(ALLOCATION_MISMATCH);
      }
    }
  });

  it('confirms a deposit and a withdrawal at a numerically equal ledger scale', () => {
    for (const kind of KINDS) {
      const liquidity = request(kind);
      const tx = transaction(
        exercise(liquidity, liquidity.allocationCids, false, 'receipt'),
        receipt(liquidity, 'receipt'),
      );
      expect(settlementResult(tx, liquidity)).toEqual(
        kind === 'DEPOSIT'
          ? {
              actualBaseIn: '10',
              actualQuoteIn: '20',
              actualBaseRefund: '0',
              actualQuoteRefund: '0',
              actualLpOut: '14',
            }
          : { actualLpBurned: '2', actualBaseOut: '1', actualQuoteOut: '2' },
      );
    }
  });

  it('correlates every deposit to its returned receipt inside one batch', () => {
    const first = request('DEPOSIT');
    const second = request('DEPOSIT');
    const tx = transaction(
      batch(first, second, [FIRST_RECEIPT, SECOND_RECEIPT]),
      receipt(second, SECOND_RECEIPT),
      receipt(first, FIRST_RECEIPT),
    );
    for (const liquidity of [first, second]) {
      expect(settlementResult(tx, liquidity)).toEqual({
        actualBaseIn: '10',
        actualQuoteIn: '20',
        actualBaseRefund: '0',
        actualQuoteRefund: '0',
        actualLpOut: '14',
      });
    }
    const mismatched = transaction(
      batch(first, second, [SECOND_RECEIPT, FIRST_RECEIPT]),
      receipt(first, FIRST_RECEIPT),
      receipt(second, SECOND_RECEIPT),
    );
    expect(() => settlementResult(mismatched, first)).toThrow(RECEIPT_MISMATCH);
  });

  it('correlates every withdrawal to its returned receipt inside one batch', () => {
    const first = request('WITHDRAW');
    const second = request('WITHDRAW');
    const tx = transaction(
      batch(first, second, [FIRST_RECEIPT, SECOND_RECEIPT]),
      receipt(second, SECOND_RECEIPT),
      receipt(first, FIRST_RECEIPT),
    );
    for (const liquidity of [first, second]) {
      expect(settlementResult(tx, liquidity)).toEqual({
        actualLpBurned: '2',
        actualBaseOut: '1',
        actualQuoteOut: '2',
      });
    }
    const mismatched = transaction(
      batch(first, second, [SECOND_RECEIPT, FIRST_RECEIPT]),
      receipt(first, FIRST_RECEIPT),
      receipt(second, SECOND_RECEIPT),
    );
    expect(() => settlementResult(mismatched, first)).toThrow(RECEIPT_MISMATCH);
    const incomplete = transaction(batch(first, second, [FIRST_RECEIPT]), receipt(first, FIRST_RECEIPT));
    expect(() => settlementResult(incomplete, first)).toThrow('Withdrawal batch receipt count differs');
  });

  it('ignores another request with the same id and terms but different allocations', () => {
    for (const kind of KINDS) {
      const liquidity = request(kind);
      for (let index = 0; index < 3; index += 1) {
        const allocations = [...liquidity.allocationCids];
        allocations[index] = 'another-allocation';
        const tx = transaction(exercise(liquidity, allocations, false, 'receipt'), receipt(liquidity, 'receipt'));
        expect(settlementResult(tx, liquidity)).toBeUndefined();
      }
    }
  });

  it('requires the same signed terms even when the request id and allocations match', () => {
    for (const kind of KINDS) {
      const liquidity = request(kind);
      const tx = transaction(
        exercise(liquidity, liquidity.allocationCids, true, 'receipt'),
        receipt(liquidity, 'receipt'),
      );
      expect(settlementResult(tx, liquidity)).toBeUndefined();
    }
  });

  it('requires the receipt that the pool choice returned', () => {
    for (const kind of KINDS) {
      const liquidity = request(kind);
      expect(settlementResult(transaction(receipt(liquidity, 'receipt')), liquidity)).toBeUndefined();
      const tx = transaction(
        exercise(liquidity, liquidity.allocationCids, false, 'returned-receipt'),
        receipt(liquidity, 'other-receipt'),
      );
      expect(() => settlementResult(tx, liquidity)).toThrow('Liquidity settlement receipt is missing');
    }
  });

  it('a liquidity preview reports both withdrawal limits and the mint headroom', () => {
    const state: ProjectedPoolState = {
      baseReserve: '100',
      quoteReserve: '200',
      lpTokenSupply: '100',
      spotPrice: '2',
      invariant: '20000',
    };
    const withdrawal = request('WITHDRAW');
    const step = validStep(
      liquidityRequest(withdrawal),
      {
        requestId: withdrawal.requestId,
        actualLpBurned: '2',
        actualBaseOut: '1',
        actualQuoteOut: '2',
        type: 'withdraw',
      },
      [],
      state,
      state,
    );
    expect(step.outputs).toEqual([
      { instrument: withdrawal.terms.baseInstrument, amount: '1', minimum: '0.9', headroomBps: '1000' },
      { instrument: withdrawal.terms.quoteInstrument, amount: '2', minimum: '1.9', headroomBps: '500' },
    ]);
    const deposit = request('DEPOSIT');
    const minted = validStep(
      liquidityRequest(deposit),
      {
        requestId: deposit.requestId,
        actualBaseIn: '10',
        actualQuoteIn: '20',
        actualBaseRefund: '0',
        actualQuoteRefund: '0',
        actualLpOut: '14',
        type: 'deposit',
      },
      [],
      state,
      state,
    );
    expect(minted.outputs).toEqual([
      { instrument: deposit.terms.lpInstrument, amount: '14', minimum: '13', headroomBps: '714.2857' },
    ]);
  });
});
