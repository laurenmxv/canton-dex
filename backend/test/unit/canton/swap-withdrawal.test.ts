import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExercisedEvent, Transaction } from '../../../src/canton/ledger.js';
import { AllocationInterface, byPackageId } from '../../../src/canton/packages.js';
import { withdrawalConfirmation } from '../../../src/canton/swap-ledger.js';
import type { Swap } from '../../../src/swaps/model.js';

const WITHDRAWN = {
  output: { tag: 'AllocationResult_Withdrawn', value: {} },
  authorizerHoldingCids: {},
  meta: { values: {} },
};

function withdrawal(allocation: string, overrides: Partial<ExercisedEvent> = {}): ExercisedEvent {
  return {
    contractId: allocation,
    templateId: 'issuer-package:Issuer:Allocation',
    interfaceId: byPackageId(AllocationInterface),
    choice: 'Allocation_Withdraw',
    consuming: false,
    actingParties: ['trader'],
    choiceArgument: {},
    exerciseResult: WITHDRAWN,
    ...overrides,
  };
}

function transaction(offset: number, exercised: ExercisedEvent): Transaction {
  return {
    updateId: `update-${String(offset)}`,
    commandId: '',
    offset: BigInt(offset),
    synchronizerId: 'synchronizer',
    recordTime: new Date(offset * 1_000).toISOString(),
    effectiveAt: new Date(offset * 1_000).toISOString(),
    events: [{ exercised }],
  };
}

function swap(): Swap {
  const now = '2026-09-19T00:00:00Z';
  return {
    swapId: randomUUID(),
    quoteId: randomUUID(),
    poolId: 'pool',
    poolName: 'Pool',
    trader: 'trader',
    direction: 'BaseToQuote',
    inputInstrument: { admin: 'issuer', id: 'BTC' },
    outputInstrument: { admin: 'issuer', id: 'USDC' },
    amountIn: '1',
    expectedOut: '10',
    feeAmount: '0.01',
    minOut: '9',
    settlementDeadline: now,
    status: 'WITHDRAWING',
    arrivalSequence: 1n,
    createdAt: now,
    submittedAt: now,
    updatedAt: now,
    settlementId: null,
    amountOut: null,
    allocationCids: ['input', 'output'],
    updateId: 'submission',
    errorCode: null,
    error: null,
    canWithdraw: false,
  };
}

describe('swap withdrawal evidence', () => {
  it('joins partial withdrawals and returns the transaction that releases the second allocation', () => {
    const history = [
      transaction(10, withdrawal('input')),
      transaction(20, withdrawal('unrelated')),
      transaction(30, withdrawal('output', { templateId: 'another-token-package:AnotherIssuer:PendingTransfer' })),
    ];
    const result = withdrawalConfirmation(history, swap(), 30n);
    expect(result?.status).toBe('WITHDRAWN');
    expect(result?.updateId).toBe('update-30');
    expect(result?.offset).toBe(30n);
    expect(result?.allocationCids).toEqual(['input', 'output']);
  });

  it('does not use a withdrawal after the confirmed transaction offset or count duplicates twice', () => {
    const history = [
      transaction(10, withdrawal('input')),
      transaction(20, withdrawal('input')),
      transaction(30, withdrawal('output')),
    ];
    expect(withdrawalConfirmation(history, swap(), 20n)).toBeUndefined();
  });

  it('requires the standard interface, a completed withdrawal, and the original trader and allocation', () => {
    const pending = {
      output: { tag: 'AllocationResult_Pending', value: { allocationCid: 'pending-output' } },
      authorizerHoldingCids: {},
      meta: { values: {} },
    };
    const history = [
      transaction(10, withdrawal('input')),
      transaction(18, withdrawal('output', { exerciseResult: undefined })),
      transaction(19, withdrawal('output', { interfaceId: undefined })),
      transaction(
        20,
        withdrawal('output', {
          interfaceId: byPackageId({ ...AllocationInterface, packageId: 'other-interface-package' }),
        }),
      ),
      transaction(21, withdrawal('output', { consuming: true })),
      transaction(22, withdrawal('output', { actingParties: ['other-trader'] })),
      transaction(23, withdrawal('output', { choice: 'Allocation_Cancel' })),
      transaction(24, withdrawal('other-output')),
      transaction(25, withdrawal('output', { exerciseResult: pending })),
    ];
    expect(withdrawalConfirmation(history, swap(), 25n)).toBeUndefined();
  });
});
