import { expect } from 'vitest';
import { allocationSpecification, MIN_OUT_KEY, type AllocationSpecification } from '../../../src/canton/allocations.js';
import { int64, pool } from '../../../src/canton/contracts.js';
import { optionalString, record, string, strings } from '../../../src/canton/decode.js';
import { createdEvents, exercisedEvents, type CreatedEvent, type Ledger } from '../../../src/canton/ledger.js';
import {
  DEX_PACKAGE_ID,
  packageOf,
  Pool,
  PoolState,
  sameEntity,
  SwapReceipt,
  TOKEN_PACKAGE_ID,
  type DamlName,
} from '../../../src/canton/packages.js';
import { swapReceipt } from '../../../src/canton/swap-ledger.js';
import { numericUnits, trimmedText } from '../../../src/platform/decimal.js';
import { epochMicros, epochNanos } from '../../../src/platform/time.js';
import { at, items, text } from '../../support/json.js';

/** The test token's allocation template; the backend itself reads only the standard interface. */
export const TokenAllocation: DamlName = {
  packageName: 'openzeppelin-tokenCIP112-v1',
  packageId: TOKEN_PACKAGE_ID,
  module: 'OpenZeppelin.TokenCIP112V1.Allocation',
  entity: 'TokenAllocation',
};

export interface TokenAllocationValue {
  readonly executors: readonly string[];
  readonly settlementId: string;
  readonly settlementCid: string | null;
  readonly allocation: AllocationSpecification;
  readonly lockedHoldingCids: readonly string[];
  readonly numIterations: bigint;
}

export function tokenAllocation(event: CreatedEvent): TokenAllocationValue {
  const fields = record(event.createArgument, 'TokenAllocation');
  const settlement = record(fields.settlement, 'TokenAllocation.settlement');
  return {
    executors: strings(settlement.executors, 'settlement.executors'),
    settlementId: string(settlement.id, 'settlement.id'),
    settlementCid: optionalString(settlement.cid, 'settlement.cid') ?? null,
    allocation: allocationSpecification(fields.allocation),
    lockedHoldingCids: strings(fields.lockedHoldingCids, 'TokenAllocation.lockedHoldingCids'),
    numIterations: int64(fields.numIterations, 'TokenAllocation.numIterations'),
  };
}

function allocationIds(swap: unknown): string[] {
  return items(swap, 'allocationCids').map((id) => text(id));
}

/** The caller sees only its own allocations and receipts, never those of another trader. */
export async function privateSwapContracts(
  ledger: Ledger,
  callerToken: string,
  party: string,
  own: unknown,
  foreign: unknown,
  settled: boolean,
): Promise<void> {
  const caller = ledger.forCaller(callerToken);
  const offset = await caller.ledgerEnd();
  const ownAllocations = new Set(allocationIds(own));
  const foreignAllocations = new Set(allocationIds(foreign));
  expect(ownAllocations.size).toBe(2);
  expect(foreignAllocations.size).toBe(2);
  const visible = (await caller.activeContracts(party, TokenAllocation, offset)).map((event) => event.contractId);
  expect(new Set(visible)).toEqual(settled ? new Set() : ownAllocations);
  expect(visible.filter((id) => foreignAllocations.has(id))).toEqual([]);

  const receipts = (await caller.activeContracts(party, SwapReceipt, offset)).map((event) =>
    swapReceipt(event.createArgument),
  );
  for (const receipt of receipts) {
    expect(receipt.trader).toBe(party);
    expect(receipt.terms.requestId).not.toBe(text(foreign, 'swapId'));
    expect([receipt.inputAllocation, receipt.outputAllocation].filter((id) => foreignAllocations.has(id))).toEqual([]);
  }
  const ownReceipts = receipts.filter((receipt) => receipt.terms.requestId === text(own, 'swapId'));
  expect(ownReceipts).toHaveLength(settled ? 1 : 0);
  for (const receipt of ownReceipts) {
    expect(new Set([receipt.inputAllocation, receipt.outputAllocation])).toEqual(ownAllocations);
    expect(receipt.poolCid).toBe(text(own, 'poolId'));
    expect(receipt.terms.requestId).toBe(text(own, 'swapId'));
    expect(receipt.terms.amountIn).toBe(numericUnits(text(own, 'amountIn')));
    expect(receipt.terms.minOut).toBe(numericUnits(text(own, 'minOut')));
  }
}

/** The swap's two allocations, bound to its pool, deadline, terms and executors, or none. */
export async function allocations(
  ledger: Ledger,
  token: string,
  party: string,
  swap: unknown,
  active: boolean,
): Promise<void> {
  const contracts = await ledger.forCaller(token).activeContracts(party, TokenAllocation);
  const ids = new Set(allocationIds(swap));
  expect(ids.size).toBe(2);
  const matched = contracts.filter((event) => ids.has(event.contractId));
  expect(matched).toHaveLength(active ? 2 : 0);
  if (!active) return;
  const poolId = text(swap, 'poolId');
  const poolEvent = (await ledger.activeContracts(await ledger.primaryParty(), Pool)).find(
    (event) => event.contractId === poolId,
  );
  if (!poolEvent) throw new Error(`Pool ${poolId} is not active`);
  const value = pool(poolEvent.createArgument);
  const [inputCid] = allocationIds(swap);
  const deadline = text(swap, 'settlementDeadline');
  const settlementId = [
    'swap',
    text(swap, 'swapId'),
    text(swap, 'direction'),
    String(numericUnits(text(swap, 'amountIn'))),
    String(numericUnits(text(swap, 'minOut'))),
    String(epochMicros(deadline)),
  ].join(':');
  for (const event of matched) {
    const allocation = tokenAllocation(event);
    const input = event.contractId === inputCid;
    const instrument = at(swap, input ? 'inputInstrument' : 'outputInstrument');
    const spec = allocation.allocation;
    expect(spec.authorizer).toEqual({ owner: party, provider: null, id: '' });
    expect(spec.admin).toBe(text(instrument, 'admin'));
    expect(spec.committed).toBe(true);
    expect(spec.settlementDeadline === null ? null : epochNanos(spec.settlementDeadline)).toBe(epochNanos(deadline));
    expect(allocation.numIterations).toBe(0n);
    expect(allocation.settlementId).toBe(settlementId);
    expect(allocation.settlementCid).toBe(poolId);
    expect(allocation.executors).toEqual([value.dvo, value.venueOperator]);
    expect(allocation.executors).not.toContain(party);
    const funding = spec.nextIterationFunding;
    if (funding === null) throw new Error('The allocation has no next iteration funding');
    if (input) {
      expect([...funding.keys()]).toEqual([text(instrument, 'id')]);
      expect(funding.get(text(instrument, 'id'))).toBe(numericUnits(text(swap, 'amountIn')));
      expect(spec.meta).toEqual({ [MIN_OUT_KEY]: trimmedText(numericUnits(text(swap, 'minOut'))) });
    } else {
      expect(funding.size).toBe(0);
      expect(spec.meta).toEqual({});
    }
    expect(spec.transferLegSides).toEqual([]);
  }
}

/** One transaction settles the batch: its receipts in order, one state replacement and one swap. */
export async function atomicBatch(ledger: Ledger, beginOffset: bigint, batch: unknown): Promise<void> {
  const transactions = (await ledger.transactions(beginOffset, await ledger.primaryParty())).filter(
    (tx) => tx.updateId === text(batch, 'updateId'),
  );
  expect(transactions).toHaveLength(1);
  const [tx] = transactions;
  if (!tx) throw new Error('No batch transaction');
  const receiptEvents = createdEvents(tx).filter((event) => sameEntity(event.templateId, SwapReceipt));
  for (const event of receiptEvents) {
    expect(packageOf(event.templateId), 'Settlement receipts must use the current application package').toBe(
      DEX_PACKAGE_ID,
    );
  }
  const receipts = receiptEvents.map((event) => swapReceipt(event.createArgument));
  const expected = items(batch, 'requests').map((ref) => {
    expect(at(ref, 'type')).toBe('swap');
    return text(ref, 'requestId');
  });
  expect(receipts.map((receipt) => receipt.terms.requestId)).toEqual(expected);
  receipts.forEach((receipt, index) => {
    expect(receipt.poolCid).toBe(text(batch, 'poolId'));
    expect(receipt.batchId).toBe(text(batch, 'settlementId'));
    expect(receipt.amountOut > 0n).toBe(true);
    expect(receipt.amountOut).toBe(numericUnits(text(batch, 'fills', index, 'amountOut')));
  });
  const states = createdEvents(tx).filter((event) => sameEntity(event.templateId, PoolState));
  expect(states).toHaveLength(1);
  expect(
    packageOf(states[0]?.templateId ?? ''),
    'Settlement must replace pool state through the current application package',
  ).toBe(DEX_PACKAGE_ID);
  const exercised = exercisedEvents(tx);
  const consumedStates = exercised.filter(
    (event) => event.consuming && event.contractId === text(batch, 'before', 'stateId'),
  );
  expect(consumedStates).toHaveLength(1);
  expect(consumedStates[0]?.choice).toBe('Archive');
  expect(packageOf(consumedStates[0]?.templateId ?? '')).toBe(DEX_PACKAGE_ID);
  const poolSwaps = exercised.filter((event) => event.choice === 'Pool_Swap');
  expect(poolSwaps).toHaveLength(1);
  expect(poolSwaps[0]?.consuming).toBe(false);
  expect(poolSwaps[0]?.contractId).toBe(text(batch, 'poolId'));
}
