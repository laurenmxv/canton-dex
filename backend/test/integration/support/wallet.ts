import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { holdingView } from '../../../src/canton/contracts.js';
import { array, offset, record, repeated, string } from '../../../src/canton/decode.js';
import { InteractiveTransactions } from '../../../src/canton/interactive.js';
import {
  EMPTY_EXTRA_ARGS,
  exercise,
  exercisedEvents,
  transactionFilter,
  type Command,
  type Ledger,
  type Transaction,
} from '../../../src/canton/ledger.js';
import { AllocationInterface, byPackageId, TokenHolding } from '../../../src/canton/packages.js';
import { numericUnits } from '../../../src/platform/decimal.js';
import { clockNanos, epochNanos, instantText } from '../../../src/platform/time.js';
import type { PartyPreparation } from '../../../src/onboarding/model.js';
import { at } from '../../support/json.js';
import type { KeyPair } from './backend.js';
import type { DevelopmentFixtures } from './fixtures.js';
import { TokenAllocation, tokenAllocation } from './swap-ledger.js';
import { until, walletSignature } from './traders.js';

const TRADER_IDENTITY_PROVIDER = 'dex-users';
const QUICK_TIMEOUT_MS = 10_000;
/** The signing window of a direct wallet command: 45 s in nanoseconds. */
export const SIGNING_WINDOW = 45_000_000_000n;
const RECORD_TIME_TIMEOUT_MS = 60_000;
const RECORD_TIME_POLL_MS = 500;

/** The trader's own view of its holdings and of the named allocations. */
export interface Snapshot {
  readonly activeAllocationIds: ReadonlySet<string>;
  readonly fundedAllocationIds: ReadonlySet<string>;
  /** Instrument id to units. */
  readonly available: ReadonlyMap<string, bigint>;
  readonly locked: ReadonlyMap<string, bigint>;
}

async function authenticatedUser(caller: Ledger) {
  const response = record(
    await caller.call('GET', '/v2/authenticated-user', QUICK_TIMEOUT_MS, {
      query: { 'identity-provider-id': TRADER_IDENTITY_PROVIDER },
    }),
    'authenticated user',
  );
  return record(response.user, 'user');
}

/** The caller token belongs to a trader of the DEX identity provider that may act only as `party`. */
async function requireTrader(caller: Ledger, party: string): Promise<string> {
  const user = await authenticatedUser(caller);
  expect(user.identityProviderId).toBe(TRADER_IDENTITY_PROVIDER);
  const userId = string(user.id, 'user.id');
  const rights = record(
    await caller.call('GET', `/v2/users/${encodeURIComponent(userId)}/rights`, QUICK_TIMEOUT_MS),
    'rights',
  );
  expect(repeated(rights.rights, 'rights', record)).toEqual([{ kind: { CanActAs: { value: { party } } } }]);
  return userId;
}

function callerLedger(fixtures: DevelopmentFixtures, token: string): Ledger {
  return fixtures.operatorLedger().forCaller(token);
}

/** The ledger user id of the caller token in the DEX identity provider. */
export async function traderUserId(fixtures: DevelopmentFixtures, token: string): Promise<string> {
  return string((await authenticatedUser(callerLedger(fixtures, token))).id, 'user.id');
}

export async function snapshot(
  fixtures: DevelopmentFixtures,
  token: string,
  party: string,
  allocationCids: readonly string[],
): Promise<Snapshot> {
  const caller = callerLedger(fixtures, token);
  await requireTrader(caller, party);
  expect(new Set(allocationCids).size).toBe(allocationCids.length);
  const end = await caller.ledgerEnd();
  const account = { owner: party, provider: null, id: '' };
  const available = new Map<string, bigint>();
  const locked = new Map<string, bigint>();
  const lockedHoldingIds = new Set<string>();
  for (const event of await caller.activeContracts(party, TokenHolding, end)) {
    expect(event.templateId).toBe(byPackageId(TokenHolding));
    const holding = holdingView(record(event.createArgument, 'TokenHolding').holding);
    if (holding.account.owner !== party || holding.account.provider !== null || holding.account.id !== '') continue;
    const amount = numericUnits(holding.amount);
    expect(amount > 0n).toBe(true);
    const totals = holding.locked ? locked : available;
    totals.set(holding.instrumentId.id, (totals.get(holding.instrumentId.id) ?? 0n) + amount);
    if (holding.locked) lockedHoldingIds.add(event.contractId);
  }
  const active = new Set<string>();
  const funded = new Set<string>();
  for (const event of await caller.activeContracts(party, TokenAllocation, end)) {
    if (!allocationCids.includes(event.contractId)) continue;
    expect(event.templateId).toBe(byPackageId(TokenAllocation));
    const allocation = tokenAllocation(event);
    expect(allocation.allocation.authorizer).toEqual(account);
    active.add(event.contractId);
    if (allocation.lockedHoldingCids.length > 0) {
      funded.add(event.contractId);
      for (const cid of allocation.lockedHoldingCids) expect(lockedHoldingIds.has(cid)).toBe(true);
    }
  }
  return { activeAllocationIds: active, fundedAllocationIds: funded, available, locked };
}

async function execute(
  fixtures: DevelopmentFixtures,
  token: string,
  userId: string,
  signer: PartyPreparation,
  key: KeyPair,
  command: Command,
): Promise<Transaction> {
  const interactive = new InteractiveTransactions(fixtures.http);
  const prepared = await interactive.prepare(
    randomUUID(),
    userId,
    token,
    signer,
    command,
    [],
    instantText(clockNanos() + SIGNING_WINDOW),
  );
  const signature = walletSignature(key, Buffer.from(prepared.preparedTransactionHash, 'base64'));
  return interactive.execute(randomUUID(), prepared, signature, signer, token, userId);
}

/** The trader withdraws one expired allocation through the token standard, without the backend. */
export async function withdraw(
  fixtures: DevelopmentFixtures,
  token: string,
  userId: string,
  signer: PartyPreparation,
  key: KeyPair,
  allocationCid: string,
): Promise<Transaction> {
  const caller = callerLedger(fixtures, token);
  expect(await requireTrader(caller, signer.partyId)).toBe(userId);
  const matches = (await caller.activeContracts(signer.partyId, TokenAllocation)).filter(
    (event) => event.contractId === allocationCid,
  );
  expect(matches).toHaveLength(1);
  const [event] = matches;
  if (!event) throw new Error('No allocation');
  expect(event.templateId).toBe(byPackageId(TokenAllocation));
  const allocation = tokenAllocation(event);
  expect(allocation.allocation.authorizer).toEqual({ owner: signer.partyId, provider: null, id: '' });
  expect(allocation.allocation.committed).toBe(true);
  const deadline = allocation.allocation.settlementDeadline;
  if (deadline === null) throw new Error('The allocation has no settlement deadline');
  // A local precondition; the standard choice independently requires ledger time after the deadline.
  expect(clockNanos() > epochNanos(deadline)).toBe(true);
  const command = exercise(AllocationInterface, allocationCid, 'Allocation_Withdraw', {
    actors: [signer.partyId],
    extraArgs: EMPTY_EXTRA_ARGS,
  });
  const transaction = await execute(fixtures, token, userId, signer, key, command);
  expect(
    exercisedEvents(transaction).some(
      (exercised) =>
        exercised.templateId === byPackageId(TokenAllocation) &&
        exercised.contractId === allocationCid &&
        exercised.choice === 'Allocation_Withdraw' &&
        !exercised.consuming &&
        exercised.actingParties.length === 1 &&
        exercised.actingParties[0] === signer.partyId,
    ),
  ).toBe(true);
  return transaction;
}

async function recordTimeAfter(caller: Ledger, signer: PartyPreparation, expiresAt: bigint): Promise<boolean> {
  const end = await caller.ledgerEnd();
  if (end === 0n) return false;
  const response = await caller.call('POST', '/v2/updates', QUICK_TIMEOUT_MS, {
    query: { stream_idle_timeout_ms: QUICK_TIMEOUT_MS },
    body: {
      beginExclusive: end - 1n,
      endInclusive: end,
      updateFormat: {
        includeTransactions: {
          eventFormat: { filtersByParty: { [signer.partyId]: transactionFilter() }, verbose: true },
          transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
        },
      },
    },
  });
  let observed = false;
  for (const item of array(response, 'updates', (value, what) => record(value, what))) {
    const update = record(item.update, 'update');
    const tx = at(update, 'Transaction', 'value');
    if (tx !== undefined) {
      expect(offset(at(tx, 'offset'), 'offset') <= end).toBe(true);
      const recordTime = at(tx, 'recordTime');
      if (at(tx, 'synchronizerId') === signer.synchronizerId && typeof recordTime === 'string') {
        observed ||= epochNanos(recordTime) > expiresAt;
      }
    }
    const checkpoint = at(update, 'OffsetCheckpoint', 'value');
    if (checkpoint !== undefined && offset(at(checkpoint, 'offset'), 'checkpoint.offset') <= end) {
      for (const time of repeated(at(checkpoint, 'synchronizerTimes'), 'synchronizerTimes', record)) {
        if (time.synchronizerId === signer.synchronizerId && typeof time.recordTime === 'string') {
          observed ||= epochNanos(time.recordTime) > expiresAt;
        }
      }
    }
  }
  return observed;
}

/** Waits for participant evidence that a signed transaction's record-time limit has passed. */
export async function awaitRecordTimeAfter(
  fixtures: DevelopmentFixtures,
  token: string,
  signer: PartyPreparation,
  expiresAt: string,
): Promise<void> {
  const caller = callerLedger(fixtures, token);
  await requireTrader(caller, signer.partyId);
  await until(
    () => recordTimeAfter(caller, signer, epochNanos(expiresAt)),
    RECORD_TIME_TIMEOUT_MS,
    RECORD_TIME_POLL_MS,
  );
}
