import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExercisedEvent, Ledger, Transaction } from '../../../src/canton/ledger.js';
import { OperatorCommands, PreparationFailed } from '../../../src/canton/operator-commands.js';
import { AllocationInterface, byPackageId, DEX_PACKAGE_ID, PoolState } from '../../../src/canton/packages.js';
import { CantonSettlementLedger, inputsConsumed } from '../../../src/canton/settlement-ledger.js';
import type { CommandJournal, PreparedCommand } from '../../../src/operations/commands.js';
import { Conflict } from '../../../src/platform/errors.js';
import { swapRequest, type Pending } from '../../../src/settlements/model.js';
import { SettlementExcluded } from '../../../src/settlements/ports.js';
import type { Swap } from '../../../src/swaps/model.js';

const NOW = '2026-09-19T00:00:00Z';
const SILENT_LOG = { warn: () => undefined };
const WITHDRAWN = {
  output: { tag: 'AllocationResult_Withdrawn', value: {} },
  authorizerHoldingCids: {},
  meta: { values: {} },
};
const UNUSED = 'This test does not reach the participant';

/** An in-memory command journal; a save can be made to fail. */
class CommandsStore implements CommandJournal {
  readonly prepared = new Map<string, PreparedCommand>();
  saveFailure: Error | undefined;

  find(id: string): Promise<PreparedCommand | undefined> {
    return Promise.resolve(this.prepared.get(id));
  }

  storeOnce(id: string, _kind: string, command: PreparedCommand): Promise<PreparedCommand> {
    if (this.saveFailure) return Promise.reject(this.saveFailure);
    const existing = this.prepared.get(id) ?? command;
    this.prepared.set(id, existing);
    return Promise.resolve(existing);
  }
}

const unusedLedger: Pick<Ledger, 'submitStored'> = { submitStored: () => Promise.reject(new Error(UNUSED)) };

function stateConsumption(overrides: Partial<ExercisedEvent> = {}): ExercisedEvent {
  return {
    contractId: 'frozen-state',
    templateId: byPackageId(PoolState),
    choice: 'Archive',
    consuming: true,
    actingParties: ['dvo'],
    choiceArgument: {},
    exerciseResult: {},
    ...overrides,
  };
}

function withdrawal(allocation: string, trader: string, overrides: Partial<ExercisedEvent> = {}): ExercisedEvent {
  return {
    contractId: allocation,
    templateId: 'issuer-package:Issuer:Allocation',
    interfaceId: byPackageId(AllocationInterface),
    choice: 'Allocation_Withdraw',
    consuming: false,
    actingParties: [trader],
    choiceArgument: {},
    exerciseResult: WITHDRAWN,
    ...overrides,
  };
}

function transaction(exercised: ExercisedEvent): Transaction {
  return {
    updateId: 'update',
    commandId: 'another-command',
    offset: 43n,
    synchronizerId: 'synchronizer',
    recordTime: NOW,
    effectiveAt: NOW,
    events: [{ exercised }],
  };
}

function swap(name: string, sequence: bigint): Swap {
  return {
    swapId: randomUUID(),
    quoteId: randomUUID(),
    poolId: 'pool',
    poolName: 'Pool',
    trader: `${name}-trader`,
    direction: 'BaseToQuote',
    inputInstrument: { admin: 'issuer', id: 'BTC' },
    outputInstrument: { admin: 'issuer', id: 'USDC' },
    amountIn: '1',
    expectedOut: '10',
    feeAmount: '0.01',
    minOut: '9',
    settlementDeadline: NOW,
    status: 'SETTLING',
    arrivalSequence: sequence,
    createdAt: NOW,
    submittedAt: NOW,
    updatedAt: NOW,
    settlementId: null,
    amountOut: null,
    allocationCids: [`${name}-input`, `${name}-output`],
    updateId: 'submission',
    errorCode: null,
    error: null,
    canWithdraw: true,
  };
}

function pending(): Pending {
  const id = randomUUID();
  const swaps = [swap('first', 1n), swap('second', 2n)];
  return {
    settlement: {
      settlementId: id,
      poolId: 'pool',
      trigger: 'MANUAL',
      status: 'UNRESOLVED',
      requests: swaps.map((item) => ({ type: 'swap', requestId: item.swapId })),
      fills: [],
      before: { stateId: 'frozen-state', baseReserve: '100', quoteReserve: '200', spotPrice: '2', invariant: '20000' },
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
    stateVersion: 'frozen-state:config',
    selection: null,
  };
}

/** A settlement ledger whose pool reads fail, as the absent pools of the baseline test did. */
function settlementLedger(commands: OperatorCommands): CantonSettlementLedger {
  const unavailable = () => Promise.reject(new Error(UNUSED));
  return new CantonSettlementLedger(
    {
      activeInterfaceContracts: unavailable,
      primaryParty: unavailable,
      storedCommands: () => {
        throw new Error(UNUSED);
      },
      transactions: unavailable,
    },
    { access: unavailable, read: unavailable, settlementDisclosures: unavailable },
    commands,
    { inlineAllocation: unavailable, inlineSettlement: unavailable },
    { operations: unavailable },
  );
}

describe('settlement recovery', () => {
  it('a construction failure is durable and cannot be rebuilt after a restart', async () => {
    const store = new CommandsStore();
    const id = randomUUID();
    await expect(
      new OperatorCommands(unusedLedger, store, SILENT_LOG).submit(id, 'batch', () =>
        Promise.reject(new Conflict('Pool access was revoked', 'ACCESS_REQUIRED')),
      ),
    ).rejects.toThrow(PreparationFailed);
    const stored = await store.find(id);
    expect(stored && 'payload' in stored).toBe(false);
    await expect(
      new OperatorCommands(unusedLedger, store, SILENT_LOG).submit(id, 'batch', () =>
        Promise.reject(new Error('A failed durable command cannot be rebuilt')),
      ),
    ).rejects.toThrow(PreparationFailed);

    const batch = pending();
    const settlement = settlementLedger(new OperatorCommands(unusedLedger, store, SILENT_LOG));
    const excluded = await settlement.submit(batch).catch((error: unknown) => error);
    expect(excluded).toBeInstanceOf(SettlementExcluded);
    expect(excluded instanceof SettlementExcluded ? excluded.code : undefined).toBe('COMMAND_NOT_PREPARED');
  });

  it('a persistence failure does not prove that a command cannot be submitted', async () => {
    const store = new CommandsStore();
    store.saveFailure = new Error('database unavailable');
    const failure = await new OperatorCommands(unusedLedger, store, SILENT_LOG)
      .submit(randomUUID(), 'batch', () => Promise.reject(new Conflict('Pool access was revoked', 'ACCESS_REQUIRED')))
      .catch((error: unknown) => error);
    expect(failure).toBe(store.saveFailure);
    expect(store.prepared.size).toBe(0);
  });

  it('consumption of the frozen state excludes the batch', () => {
    expect(inputsConsumed([transaction(stateConsumption())], pending())).toBe(true);
  });

  it('unrelated state, nonconsuming and wrong-template events do not exclude the batch', () => {
    const invalid = [
      stateConsumption({ contractId: 'another-state' }),
      stateConsumption({ consuming: false }),
      stateConsumption({ templateId: 'other-package:Pool:PoolState' }),
      stateConsumption({ templateId: `${DEX_PACKAGE_ID}:OtherPool:PoolState` }),
      stateConsumption({ templateId: `${DEX_PACKAGE_ID}:Pool:PoolConfig` }),
    ];
    for (const exercised of invalid) {
      expect(inputsConsumed([transaction(exercised)], pending()), JSON.stringify(exercised)).toBe(false);
    }
  });

  it('withdrawal of even one required allocation excludes the entire atomic batch', () => {
    for (const allocation of ['first-input', 'first-output', 'second-input', 'second-output']) {
      const trader = allocation.startsWith('first') ? 'first-trader' : 'second-trader';
      expect(inputsConsumed([transaction(withdrawal(allocation, trader))], pending()), allocation).toBe(true);
    }
  });

  it('allocation evidence must match its own trader, interface, choice and result', () => {
    const interfaceId = byPackageId(AllocationInterface);
    const [packageId, module, entity] = interfaceId.split(':');
    const invalid = [
      withdrawal('unrelated-input', 'first-trader'),
      withdrawal('first-input', 'first-trader', { consuming: true }),
      withdrawal('first-input', 'first-trader', { choice: 'Allocation_Cancel' }),
      withdrawal('first-input', 'first-trader', { actingParties: [] }),
      withdrawal('first-input', 'other-trader'),
      withdrawal('first-input', 'second-trader'),
      withdrawal('first-input', 'first-trader', { interfaceId: `other-package:${String(module)}:${String(entity)}` }),
      withdrawal('first-input', 'first-trader', {
        interfaceId: `${String(packageId)}:OtherAllocation:${String(entity)}`,
      }),
      withdrawal('first-input', 'first-trader', {
        interfaceId: `${String(packageId)}:${String(module)}:OtherAllocation`,
      }),
    ];
    for (const exercised of invalid) {
      expect(inputsConsumed([transaction(exercised)], pending()), JSON.stringify(exercised)).toBe(false);
    }
  });

  it('an empty history and events without an exercise are not exclusion evidence', () => {
    expect(inputsConsumed([], pending())).toBe(false);
    const archived: Transaction = {
      ...transaction(stateConsumption()),
      events: [{ archived: { contractId: 'frozen-state', templateId: byPackageId(PoolState) } }],
    };
    expect(inputsConsumed([archived], pending())).toBe(false);
  });
});
