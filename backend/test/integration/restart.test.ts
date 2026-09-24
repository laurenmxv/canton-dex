import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { at, text } from '../support/json.js';
import { delay, withBackend, type BackendFixture } from './support/backend.js';
import { DevelopmentFixtures } from './support/fixtures.js';
import { completedOnboarding } from './support/onboarding-ledger.js';
import {
  loadState,
  prepareSwaps,
  restoreSwaps,
  saveState,
  verifySwaps,
  withdrawWhileStopped,
  type RestartState,
  type SavedPolicy,
} from './support/restart.js';
import { independently } from './support/traders.js';

/** Exceeds the submission's 30-second deduplication window before recovery is tested. */
const PAST_DEDUPLICATION_MS = 31_000;

/** `scripts/test-backend.sh` runs each phase by its exact name; `all` does not select a phase. */
function phase(name: string): boolean {
  return process.env.DEX_SCENARIO === name;
}

function policyPath(poolId: string): string {
  return `/v1/admin/pools/${poolId}/settlement-policy/swap`;
}

async function policy(test: BackendFixture, poolId: string): Promise<unknown> {
  return test.request('GET', policyPath(poolId), await test.token('operator'), undefined, 200);
}

async function writePolicy(test: BackendFixture, saved: SavedPolicy, values: unknown, version: unknown) {
  return test.request(
    'PUT',
    policyPath(saved.poolId),
    await test.token('operator'),
    { automaticEnabled: at(values, 'automaticEnabled'), batchSize: at(values, 'batchSize'), expectedVersion: version },
    200,
  );
}

async function savedPolicy(
  test: BackendFixture,
  pair: string,
  automaticEnabled: boolean,
  batchSize: number,
): Promise<SavedPolicy> {
  const { rows } = await sql<{ pool_id: string }>`SELECT pool_id FROM test_token_pools WHERE pair=${pair}`.execute(
    test.fixtures.db,
  );
  expect(rows).toHaveLength(1);
  const poolId = rows[0]?.pool_id ?? '';
  const operator = await test.token('operator');
  expect(
    await test.request('GET', `/v1/admin/settlement-requests?poolId=${poolId}&status=active`, operator, undefined, 200),
    `Restart policy coverage requires an empty fixture queue: ${pair}`,
  ).toEqual([]);
  const monitoring = await test.request('GET', `/v1/admin/monitoring?poolId=${poolId}`, operator, undefined, 200);
  expect(at(monitoring, 'activeSettlement')).toBeNull();
  const original = await policy(test, poolId);
  expect(Number(at(original, 'maxBatchSize'))).toBeGreaterThanOrEqual(batchSize);
  return { poolId, automaticEnabled, batchSize, writtenVersion: Number(at(original, 'version')) + 1, original };
}

/** Restores both policy changes independently; repeated cleanup needs no change. */
async function restorePolicies(test: BackendFixture, policies: readonly SavedPolicy[]): Promise<void> {
  await independently(
    'Restore both restart policy changes independently',
    ...policies.map((saved) => async () => {
      const current = await policy(test, saved.poolId);
      const original = saved.original;
      // Failed writes and repeated cleanup need no change when the original values remain.
      if (
        at(current, 'automaticEnabled') === at(original, 'automaticEnabled') &&
        at(current, 'batchSize') === at(original, 'batchSize')
      ) {
        return;
      }
      expect(at(current, 'automaticEnabled')).toBe(saved.automaticEnabled);
      expect(at(current, 'batchSize')).toBe(saved.batchSize);
      expect(Number(at(current, 'version'))).toBe(saved.writtenVersion);
      const restored = await writePolicy(test, saved, original, saved.writtenVersion);
      expect(at(restored, 'automaticEnabled')).toBe(at(original, 'automaticEnabled'));
      expect(at(restored, 'batchSize')).toBe(at(original, 'batchSize'));
    }),
  );
}

async function restoreAfterFailure(test: BackendFixture, policies: readonly SavedPolicy[], failure: unknown) {
  try {
    await restorePolicies(test, policies);
  } catch (cleanup) {
    throw new AggregateError([failure, cleanup], 'Restart phase and policy cleanup failed', { cause: cleanup });
  }
  throw failure;
}

describe('restart', () => {
  it.runIf(phase('restart-prepare'))('prepare', async () => {
    await withBackend(async (test) => {
      const name = await test.trader('restart');
      const token = await test.token(name);
      const id = text(await test.create(token), 'id');
      await test.approve(id);
      const completed = await test.register(id, token);
      await completedOnboarding(test.fixtures, completed, [await test.poolId()]);
      const policies = [await savedPolicy(test, 'BTC/USDC', true, 3), await savedPolicy(test, 'ETH/USDC', false, 7)];
      const state: RestartState = {
        name,
        onboarding: completed,
        poolId: await test.poolId(),
        settlementPolicies: policies,
      };
      // Save both original versions before the first write, including a possibly lost response.
      saveState(state);
      try {
        for (const saved of policies) await writePolicy(test, saved, saved, at(saved.original, 'version'));
        await prepareSwaps(test, state);
      } catch (failure) {
        await restoreAfterFailure(test, policies, failure);
      }
    });
  });

  it.runIf(phase('restart-mark-uncertain'))('mark uncertain while the backend is stopped', async () => {
    const state = loadState();
    await withdrawWhileStopped(state);
    await delay(PAST_DEDUPLICATION_MS);
    const fixtures = new DevelopmentFixtures();
    try {
      const result = await sql`UPDATE onboarding_steps SET
          status='SUBMITTING',contract_id=NULL,update_id=NULL,issuer=NULL
        WHERE onboarding_id=${text(state.onboarding, 'id')} AND step_key='attestation' AND status='CONFIRMED'`.execute(
        fixtures.db,
      );
      expect(result.numAffectedRows).toBe(1n);
    } finally {
      await fixtures.close();
    }
  });

  it.runIf(phase('restart-verify'))('verify', async () => {
    await withBackend(async (test) => {
      const state = loadState();
      const policies = state.settlementPolicies;
      try {
        const token = await test.token(state.name);
        const current = await test.completed(token);
        expect(current).toEqual(state.onboarding);
        await completedOnboarding(test.fixtures, current, [state.poolId]);
        await verifySwaps(test, state);
        expect(policies).toHaveLength(2);
        for (const expected of policies) {
          const actual = await policy(test, expected.poolId);
          expect(at(actual, 'automaticEnabled')).toBe(expected.automaticEnabled);
          expect(at(actual, 'batchSize')).toBe(expected.batchSize);
          expect(Number(at(actual, 'version'))).toBe(expected.writtenVersion);
        }
      } catch (failure) {
        await restoreAfterFailure(test, policies, failure);
      }
      await restorePolicies(test, policies);
    });
  });

  it.runIf(phase('restart-restore'))('restore policies after an interrupted restart', async () => {
    const state = loadState();
    await withBackend(async (test) => {
      await independently(
        'Reclaim funded requests and restore settings independently',
        () => restoreSwaps(test, state),
        () => restorePolicies(test, state.settlementPolicies),
      );
    });
  });
});
