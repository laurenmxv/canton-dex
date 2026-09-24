import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import type { PartyPreparation } from '../../../src/onboarding/model.js';
import { numericUnits, trimmedText } from '../../../src/platform/decimal.js';
import { epochNanos } from '../../../src/platform/time.js';
import { at, items, text } from '../../support/json.js';
import type { BackendFixture, KeyPair } from './backend.js';
import { DevelopmentFixtures, env } from './fixtures.js';
import { backing } from './pool-ledger.js';
import { faucet, onboard, secondsFromNow, sign, swapStatus, until, type Trader } from './traders.js';
import { awaitRecordTimeAfter, snapshot, traderUserId, withdraw, type Snapshot } from './wallet.js';

const BACKEND_PROBE_MS = 2_000;
const DEADLINE_TIMEOUT_MS = 60_000;
const DEADLINE_POLL_MS = 250;
const SETTLED_TIMEOUT_MS = 60_000;
const SETTLED_POLL_MS = 500;
const SIGNED_DEADLINE_SECONDS = 45;
const IN_FLIGHT = new Set(['SUBMITTING', 'UNRESOLVED', 'SETTLING', 'WITHDRAWING', 'WITHDRAWAL_UNRESOLVED']);

export interface SavedPolicy {
  readonly poolId: string;
  readonly automaticEnabled: boolean;
  readonly batchSize: number;
  readonly writtenVersion: number;
  readonly original: unknown;
}

/** The trader wallet of the swap phases; its private key exists only in the owner-only state file. */
export interface SwapWallet {
  readonly name: string;
  readonly privateKey: string;
  readonly party: PartyPreparation;
  readonly poolId: string;
  readonly requests: unknown[];
  userId?: string;
  availableBefore?: Record<string, string>;
  reservesBefore?: unknown;
  fullWithdrawalUpdateId?: string;
  offlineWithdrawalsConfirmed?: boolean;
  fundedRequestsResolved?: boolean;
}

export interface RestartState {
  readonly name: string;
  readonly onboarding: unknown;
  readonly poolId: string;
  readonly settlementPolicies: readonly SavedPolicy[];
  swapWallet?: SwapWallet;
}

export function loadState(): RestartState {
  return JSON.parse(readFileSync(env('DEX_RESTART_STATE'), 'utf8')) as RestartState;
}

/** Replaces the state file atomically; the replacement is owner-only from its creation. */
export function saveState(state: RestartState): void {
  const target = env('DEX_RESTART_STATE');
  const replacement = join(dirname(target), `restart-state-${randomUUID()}.tmp`);
  try {
    writeFileSync(replacement, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    renameSync(replacement, target);
  } finally {
    rmSync(replacement, { force: true });
  }
}

function allocationIds(request: unknown): string[] {
  return items(request, 'allocationCids').map((cid) => text(cid));
}

function walletKey(wallet: SwapWallet): KeyPair {
  return {
    privateKey: createPrivateKey({ key: Buffer.from(wallet.privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: Buffer.from(wallet.party.publicKey, 'base64'), format: 'der', type: 'spki' }),
  };
}

function walletTrader(wallet: SwapWallet): Trader {
  return { name: wallet.name, key: walletKey(wallet), party: wallet.party.partyId };
}

function walletSnapshot(fixtures: DevelopmentFixtures, token: string, wallet: SwapWallet): Promise<Snapshot> {
  return snapshot(fixtures, token, wallet.party.partyId, wallet.requests.flatMap(allocationIds));
}

function assertAvailableRestored(current: Snapshot, wallet: SwapWallet): void {
  for (const [id, amount] of Object.entries(wallet.availableBefore ?? {})) {
    expect(current.available.get(id) ?? 0n, id).toBe(numericUnits(amount));
  }
  for (const amount of current.locked.values()) expect(amount).toBe(0n);
}

/** Waits until one second after the latest settlement deadline of `requests`. */
async function waitForDeadline(requests: readonly unknown[]): Promise<void> {
  const latest = requests.reduce<bigint>((deadline, request) => {
    const value = epochNanos(text(request, 'settlementDeadline'));
    return value > deadline ? value : deadline;
  }, 0n);
  const afterDeadline = latest + 1_000_000_000n;
  await until(
    () => Promise.resolve(BigInt(Date.now()) * 1_000_000n > afterDeadline),
    DEADLINE_TIMEOUT_MS,
    DEADLINE_POLL_MS,
  );
}

async function reserves(test: BackendFixture, pool: string): Promise<unknown> {
  const monitoring = await test.request(
    'GET',
    `/v1/admin/monitoring?poolId=${pool}`,
    await test.token('operator'),
    undefined,
    200,
  );
  return at(monitoring, 'pool', 'reserves');
}

/** No backend answer is acceptable; the participant and identity provider stay online. */
async function assertBackendStopped(): Promise<void> {
  const answered = await fetch(`${env('DEX_TEST_BASE_URL')}/actuator/health/readiness`, {
    signal: AbortSignal.timeout(BACKEND_PROBE_MS),
  }).then(
    () => true,
    () => false,
  );
  expect(answered, 'The venue backend must be stopped during direct withdrawal').toBe(false);
}

async function prepareRequest(test: BackendFixture, state: RestartState, trader: Trader, amount: string) {
  const wallet = present(state.swapWallet);
  const token = await test.token(trader.name);
  const quote = await test.request(
    'POST',
    '/v1/swaps/quote',
    token,
    { poolId: wallet.poolId, direction: 'QuoteToBase', amountIn: amount, slippageBps: 100 },
    200,
  );
  const prepared = await test.request(
    'POST',
    '/v1/swaps/prepare',
    token,
    {
      quoteId: text(quote, 'quoteId'),
      minOut: text(quote, 'minOut'),
      settlementDeadline: secondsFromNow(SIGNED_DEADLINE_SECONDS),
    },
    200,
  );
  const index = wallet.requests.length;
  wallet.requests.push(prepared);
  // Preserve the request id before a submission can commit with a lost response.
  saveState(state);
  await test.request('POST', '/v1/swaps/submit', token, sign(trader.key, prepared), 202);
  wallet.requests[index] = await swapStatus(test, trader, text(prepared, 'swapId'), 'READY');
  saveState(state);
}

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('The restart state has no swap wallet');
  return value;
}

/** Two funded swaps on the pool of the second saved policy, recorded before each submission. */
export async function prepareSwaps(test: BackendFixture, state: RestartState): Promise<void> {
  const poolId = present(state.settlementPolicies[1]).poolId;
  const trader = await onboard(test, 'restart-swaps', [poolId]);
  const wallet: SwapWallet = {
    name: trader.name,
    privateKey: trader.key.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    party: at(await test.completed(await test.token(trader.name)), 'party') as PartyPreparation,
    poolId,
    requests: [],
  };
  state.swapWallet = wallet;
  // The only private-key copy outside memory is this owner-only, temporary recovery file.
  saveState(state);
  await faucet(test, trader);
  const token = await test.token(trader.name);
  wallet.userId = await traderUserId(test.fixtures, token);
  const available = (await walletSnapshot(test.fixtures, token, wallet)).available;
  wallet.availableBefore = Object.fromEntries([...available].map(([id, units]) => [id, trimmedText(units)]));
  wallet.reservesBefore = await reserves(test, poolId);
  saveState(state);
  await prepareRequest(test, state, trader, '25');
  await prepareRequest(test, state, trader, '30');
  const locked = await walletSnapshot(test.fixtures, await test.token(trader.name), wallet);
  expect(locked.activeAllocationIds.size).toBe(4);
  expect(locked.fundedAllocationIds.size).toBe(2);
  expect(locked.locked.get('USDC')).toBe(numericUnits('55'));
}

/** With the backend stopped, the wallet withdraws one swap completely and the other partially. */
export async function withdrawWhileStopped(state: RestartState): Promise<void> {
  await assertBackendStopped();
  const wallet = present(state.swapWallet);
  expect(wallet.requests).toHaveLength(2);
  const key = walletKey(wallet);
  const userId = wallet.userId ?? '';
  const fixtures = new DevelopmentFixtures();
  try {
    const token = await fixtures.userToken(wallet.name);
    const before = await walletSnapshot(fixtures, token, wallet);
    expect(before.activeAllocationIds.size).toBe(4);
    await waitForDeadline(wallet.requests);
    const [full, partial] = wallet.requests;
    for (const cid of allocationIds(full)) {
      const tx = await withdraw(fixtures, token, userId, wallet.party, key, cid);
      wallet.fullWithdrawalUpdateId = tx.updateId;
      saveState(state);
    }
    const partialIds = allocationIds(partial).filter((id) => before.fundedAllocationIds.has(id));
    expect(partialIds).toHaveLength(1);
    await withdraw(fixtures, token, userId, wallet.party, key, partialIds[0] ?? '');
    const after = await walletSnapshot(fixtures, token, wallet);
    expect(after.activeAllocationIds.size).toBe(1);
    for (const id of after.activeAllocationIds) expect(allocationIds(partial)).toContain(id);
    expect(after.fundedAllocationIds.size).toBe(0);
    assertAvailableRestored(after, wallet);
    wallet.offlineWithdrawalsConfirmed = true;
    saveState(state);
  } finally {
    await fixtures.close();
  }
  await assertBackendStopped();
}

/** After the restart, the backend reports the offline withdrawal and releases the partial remainder. */
export async function verifySwaps(test: BackendFixture, state: RestartState): Promise<void> {
  const wallet = present(state.swapWallet);
  expect(wallet.offlineWithdrawalsConfirmed).toBe(true);
  const trader = walletTrader(wallet);
  const fullId = text(wallet.requests[0], 'swapId');
  const full = await swapStatus(test, trader, fullId, 'WITHDRAWN');
  expect(text(full, 'updateId')).toBe(wallet.fullWithdrawalUpdateId);
  const partialId = text(wallet.requests[1], 'swapId');
  const token = await test.token(trader.name);
  const partial = await test.request('GET', `/v1/swaps/${partialId}`, token, undefined, 200);
  expect(['SETTLED', 'WITHDRAWN', 'FAILED']).not.toContain(at(partial, 'status'));
  expect(at(partial, 'canWithdraw')).toBe(true);
  const remaining = await walletSnapshot(test.fixtures, token, wallet);
  expect(remaining.activeAllocationIds.size).toBe(1);
  expect(remaining.fundedAllocationIds.size).toBe(0);
  const prepared = await test.request('POST', `/v1/swaps/${partialId}/cancel/prepare`, token, undefined, 200);
  await test.request('POST', `/v1/swaps/${partialId}/cancel/submit`, token, sign(trader.key, prepared), 202);
  await swapStatus(test, trader, partialId, 'WITHDRAWN');
  const after = await walletSnapshot(test.fixtures, token, wallet);
  expect(after.activeAllocationIds.size).toBe(0);
  assertAvailableRestored(after, wallet);
  expect(await reserves(test, wallet.poolId)).toEqual(wallet.reservesBefore);
  await backing(test.fixtures.operatorLedger(), wallet.poolId);
  wallet.fundedRequestsResolved = true;
  saveState(state);
}

/** Cleanup after an interrupted restart: every funded request ends withdrawn or settled. */
export async function restoreSwaps(test: BackendFixture, state: RestartState): Promise<void> {
  const wallet = state.swapWallet;
  if (!wallet) return;
  const trader = walletTrader(wallet);
  const token = await test.token(trader.name);
  for (const saved of wallet.requests) {
    const id = text(saved, 'swapId');
    let current: unknown;
    await until(
      async () => {
        current = await test.request('GET', `/v1/swaps/${id}`, token, undefined, 200);
        return !IN_FLIGHT.has(text(current, 'status'));
      },
      SETTLED_TIMEOUT_MS,
      SETTLED_POLL_MS,
    );
    let status = text(current, 'status');
    if (status === 'PREPARED') {
      // A timed-out submit handler may still send its transaction. Preserve the wallet until a
      // participant watermark proves that the signed transaction cannot commit.
      await awaitRecordTimeAfter(test.fixtures, token, wallet.party, text(saved, 'expiresAt'));
      current = await test.request('GET', `/v1/swaps/${id}`, token, undefined, 200);
      status = text(current, 'status');
    }
    if (['PREPARED', 'FAILED', 'SETTLED'].includes(status)) continue;
    const ids = allocationIds(current);
    expect(ids).toHaveLength(2);
    if (status !== 'WITHDRAWN') {
      await waitForDeadline([current]);
      const remaining = await snapshot(test.fixtures, token, trader.party, ids);
      for (const cid of remaining.activeAllocationIds) {
        await withdraw(test.fixtures, token, wallet.userId ?? '', wallet.party, trader.key, cid);
      }
      await swapStatus(test, trader, id, 'WITHDRAWN', 'SETTLED');
    }
    expect((await snapshot(test.fixtures, token, trader.party, ids)).activeAllocationIds.size).toBe(0);
  }
  for (const amount of (await snapshot(test.fixtures, token, trader.party, [])).locked.values()) {
    expect(amount).toBe(0n);
  }
  wallet.fundedRequestsResolved = true;
  saveState(state);
}
