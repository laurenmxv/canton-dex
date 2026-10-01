import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { Ledger } from '../../src/canton/ledger.js';
import { compareDecimal, numericUnits } from '../../src/platform/decimal.js';
import { independently } from '../support/cleanup.js';
import { at, items, text } from '../support/json.js';
import { delay, ed25519KeyPair, secp256k1KeyPair, withBackend, type BackendFixture } from './support/backend.js';
import { backing } from './support/pool-ledger.js';
import { scenario } from './support/scenario.js';
import { allocations, atomicBatch, privateSwapContracts } from './support/swap-ledger.js';
import {
  balance,
  balances,
  expectAmount,
  faucet,
  minus,
  onboard,
  plus,
  secondsFromNow,
  sign,
  status,
  swapStatus,
  until,
  type Trader,
} from './support/traders.js';

const RECLAIM_TIMEOUT_MS = 55_000;
const RECLAIM_POLL_MS = 1_000;
/** A lone automatic swap must stay queued below the batch threshold for this long. */
const BELOW_THRESHOLD_MS = 5_000;
const BELOW_THRESHOLD_LIMIT_MS = 8_000;
const BELOW_THRESHOLD_POLL_MS = 400;

function policyPath(pool: string): string {
  return `/v1/admin/pools/${pool}/settlement-policy/swap`;
}

async function fixturePool(test: BackendFixture, pair: string): Promise<string> {
  const { rows } = await sql<{ pool_id: string }>`SELECT pool_id FROM test_token_pools WHERE pair=${pair}`.execute(
    test.fixtures.db,
  );
  const [row] = rows;
  if (rows.length !== 1 || !row) throw new Error(`Expected one ${pair} fixture pool`);
  return row.pool_id;
}

/** Passes once `check` has held for `durationMs` without interruption, within `limitMs`. */
async function holdsFor(check: () => Promise<boolean>, durationMs: number, limitMs: number, pollMs: number) {
  const deadline = Date.now() + limitMs;
  let since: number | undefined;
  for (;;) {
    const now = Date.now();
    if (await check()) {
      since ??= now;
      if (now - since >= durationMs) return;
    } else {
      since = undefined;
    }
    if (now > deadline) throw new Error(`Condition did not hold for ${String(durationMs)} ms`);
    await delay(pollMs);
  }
}

describe.runIf(scenario('swaps'))('swaps', () => {
  it('external signatures fund, lock, settle a batch and reclaim real tokens', async () => {
    await withBackend(async (f) => {
      const ledger: Ledger = f.fixtures.operatorLedger();
      const policyWrites = new Map<string, unknown>();
      const btc = await fixturePool(f, 'BTC/USDC');
      const eth = await fixturePool(f, 'ETH/USDC');
      const operator = await f.token('operator');
      const policy = (pool: string) => f.request('GET', policyPath(pool), operator, undefined, 200);
      const monitor = (pool: string) =>
        f.request('GET', `/v1/admin/monitoring?poolId=${pool}`, operator, undefined, 200);
      const queue = (pool: string) =>
        f.request('GET', `/v1/admin/settlement-requests?poolId=${pool}&status=active`, operator, undefined, 200);
      const updatePolicy = async (pool: string, automatic: boolean, size: number) => {
        const current = await policy(pool);
        policyWrites.set(
          pool,
          await f.request(
            'PUT',
            policyPath(pool),
            operator,
            { automaticEnabled: automatic, batchSize: size, expectedVersion: at(current, 'version') },
            200,
          ),
        );
      };
      const restorePolicy = async (pool: string, saved: unknown) => {
        const written = policyWrites.get(pool);
        if (written === undefined) return;
        await f.request(
          'PUT',
          policyPath(pool),
          operator,
          {
            automaticEnabled: at(saved, 'automaticEnabled'),
            batchSize: at(saved, 'batchSize'),
            expectedVersion: at(written, 'version'),
          },
          200,
        );
      };
      const swap = async (trader: Trader, id: string) =>
        f.request('GET', `/v1/swaps/${id}`, await f.token(trader.name), undefined, 200);
      const traderBalances = async (trader: Trader) => balances(f, await f.token(trader.name));

      const submit = async (trader: Trader, pool: string, direction: string, amount: string, deadline?: string) => {
        const token = await f.token(trader.name);
        const quote = await f.request(
          'POST',
          '/v1/swaps/quote',
          token,
          { poolId: pool, direction, amountIn: amount, slippageBps: 100 },
          200,
        );
        const prepared = await f.request(
          'POST',
          '/v1/swaps/prepare',
          token,
          {
            quoteId: text(quote, 'quoteId'),
            minOut: text(quote, 'minOut'),
            settlementDeadline: deadline ?? text(quote, 'settlementDeadline'),
          },
          200,
        );
        await f.request('POST', '/v1/swaps/submit', token, sign(ed25519KeyPair(), prepared), 400);
        await f.request('POST', '/v1/swaps/submit', token, sign(trader.key, prepared), 202);
        return swapStatus(f, trader, text(prepared, 'swapId'), 'READY', 'SETTLED');
      };

      const manual = async (pool: string) => {
        const started = await f.request(
          'POST',
          `/v1/admin/pools/${pool}/settlements`,
          operator,
          { idempotencyKey: randomUUID() },
          202,
        );
        expect(at(started, 'trigger')).toBe('MANUAL');
        return status(f, `/v1/admin/settlements/${text(started, 'settlementId')}`, operator, 'CONFIRMED');
      };

      const assertBatch = async (offset: bigint, batch: unknown, swaps: readonly unknown[]) => {
        const actualIds = items(batch, 'requests').map((ref) => {
          expect(at(ref, 'type')).toBe('swap');
          return text(ref, 'requestId');
        });
        expect(actualIds).toEqual(swaps.map((item) => text(item, 'swapId')));
        let base = numericUnits(text(batch, 'before', 'baseReserve'));
        let quote = numericUnits(text(batch, 'before', 'quoteReserve'));
        swaps.forEach((item, index) => {
          const fill = at(batch, 'fills', index);
          expect(at(fill, 'type')).toBe('swap');
          expect(at(fill, 'requestId')).toBe(at(item, 'swapId'));
          const input = numericUnits(text(item, 'amountIn'));
          const output = numericUnits(text(fill, 'amountOut'));
          expect(output >= numericUnits(text(item, 'minOut'))).toBe(true);
          if (text(item, 'direction') === 'QuoteToBase') {
            base -= output;
            quote += input;
          } else {
            base += input;
            quote -= output;
          }
        });
        expect(numericUnits(text(batch, 'after', 'baseReserve'))).toBe(base);
        expect(numericUnits(text(batch, 'after', 'quoteReserve'))).toBe(quote);
        expect(
          compareDecimal(text(batch, 'after', 'invariant'), text(batch, 'before', 'invariant')),
        ).toBeGreaterThanOrEqual(0);
        await atomicBatch(ledger, offset, batch);
        await backing(ledger, text(batch, 'poolId'));
      };

      const savedBtc = await policy(btc);
      const savedEth = await policy(eth);
      for (const pool of [btc, eth]) {
        expect(await queue(pool), 'Fixture pool must have no unrelated pending swaps').toEqual([]);
        expect(at(await monitor(pool), 'pool', 'health')).toBe('READY');
        expect(
          at(await policy(pool), 'automaticEnabled'),
          'Disable automatic settlement before running the isolated swap scenario',
        ).toBe(false);
      }
      try {
        const alice = await onboard(f, 'swap-alice', [btc, eth]);
        const bob = await onboard(f, 'swap-bob', [btc, eth], secp256k1KeyPair());
        await faucet(f, alice);
        await faucet(f, bob);
        await backing(ledger, btc);
        await backing(ledger, eth);
        const untouchedEth = at(await monitor(eth), 'pool', 'reserves');

        await updatePolicy(btc, false, 2);
        expect(await policy(eth)).toEqual(savedEth);
        const changed = await policy(btc);
        await f.request(
          'PUT',
          policyPath(btc),
          operator,
          { automaticEnabled: false, batchSize: 1, expectedVersion: at(savedBtc, 'version') },
          409,
        );
        expect(await policy(btc)).toEqual(changed);
        await f.request(
          'PUT',
          policyPath(btc),
          await f.token(alice.name),
          { automaticEnabled: true, batchSize: 1, expectedVersion: at(changed, 'version') },
          403,
        );

        const before = await traderBalances(alice);
        const first = await submit(alice, btc, 'QuoteToBase', '100');
        const locked = await traderBalances(alice);
        expectAmount(balance(locked, 'USDC', 'available'), minus(balance(before, 'USDC', 'available'), '100'));
        expectAmount(balance(locked, 'USDC', 'locked'), '100');
        expectAmount(balance(locked, 'USDC', 'total'), balance(before, 'USDC', 'total'));
        await allocations(ledger, await f.token(alice.name), alice.party, first, true);
        await f.request('GET', `/v1/swaps/${text(first, 'swapId')}`, await f.token(bob.name), undefined, 404);
        await f.request(
          'POST',
          `/v1/swaps/${text(first, 'swapId')}/cancel/prepare`,
          await f.token(alice.name),
          undefined,
          409,
        );
        const singleOffset = await ledger.ledgerEnd();
        const single = await manual(btc);
        expect(items(single, 'requests')).toHaveLength(1);
        await assertBatch(singleOffset, single, [first]);
        const firstSettled = await swapStatus(f, alice, text(first, 'swapId'), 'SETTLED');
        expectAmount(
          balance(await traderBalances(alice), 'BTC', 'available'),
          plus(balance(before, 'BTC', 'available'), text(firstSettled, 'amountOut')),
        );
        expectAmount(balance(await traderBalances(alice), 'USDC', 'locked'), '0');
        await allocations(ledger, await f.token(alice.name), alice.party, first, false);
        const market = await f.request(
          'GET',
          `/v1/pools/${btc}/market-data`,
          await f.token(alice.name),
          undefined,
          200,
        );
        expect(text(market, 'spotPrice')).not.toBe('');
        expect(numericUnits(text(market, 'baseVolume24h'))).toBeGreaterThan(0n);
        expect(numericUnits(text(market, 'quoteVolume24h'))).toBeGreaterThan(0n);
        expect(items(market, 'candles')).not.toHaveLength(0);
        expect(items(market, 'recentTrades')).toContainEqual(
          expect.objectContaining({ swapId: text(first, 'swapId'), direction: 'QuoteToBase' }),
        );
        await f.request(
          'POST',
          `/v1/admin/pools/${btc}/settlements`,
          operator,
          { idempotencyKey: text(single, 'settlementId') },
          202,
        );
        expect(at(await monitor(eth), 'pool', 'reserves')).toEqual(untouchedEth);

        const second = await submit(alice, btc, 'QuoteToBase', '200');
        const third = await submit(bob, btc, 'BaseToQuote', '0.001');
        expect(Number(at(second, 'arrivalSequence'))).toBeLessThan(Number(at(third, 'arrivalSequence')));
        await privateSwapContracts(ledger, await f.token(alice.name), alice.party, second, third, false);
        await privateSwapContracts(ledger, await f.token(bob.name), bob.party, third, second, false);
        const batchOffset = await ledger.ledgerEnd();
        const batch = await manual(btc);
        await assertBatch(batchOffset, batch, [second, third]);
        expect(at(await swapStatus(f, alice, text(second, 'swapId'), 'SETTLED'), 'updateId')).toBe(
          at(await swapStatus(f, bob, text(third, 'swapId'), 'SETTLED'), 'updateId'),
        );
        await privateSwapContracts(ledger, await f.token(alice.name), alice.party, second, third, true);
        await privateSwapContracts(ledger, await f.token(bob.name), bob.party, third, second, true);
        await backing(ledger, btc);

        const maximum = Number(at(await policy(btc), 'maxBatchSize'));
        await updatePolicy(btc, false, maximum);
        const maximumRequests: unknown[] = [];
        for (let index = 0; index < maximum; index += 1) {
          maximumRequests.push(await submit(index % 2 === 0 ? alice : bob, btc, 'QuoteToBase', '1'));
        }
        const maximumOffset = await ledger.ledgerEnd();
        await assertBatch(maximumOffset, await manual(btc), maximumRequests);
        await updatePolicy(btc, false, 2);
        const isolatedBtcPolicy = await policy(btc);

        await updatePolicy(eth, true, 2);
        const automaticOffset = await ledger.ledgerEnd();
        const fourth = await submit(alice, eth, 'QuoteToBase', '50');
        await holdsFor(
          async () => at(await swap(alice, text(fourth, 'swapId')), 'status') === 'READY',
          BELOW_THRESHOLD_MS,
          BELOW_THRESHOLD_LIMIT_MS,
          BELOW_THRESHOLD_POLL_MS,
        );
        const fifth = await submit(bob, eth, 'QuoteToBase', '75');
        const autoSettled = await swapStatus(f, alice, text(fourth, 'swapId'), 'SETTLED');
        await swapStatus(f, bob, text(fifth, 'swapId'), 'SETTLED');
        const automatic = await status(
          f,
          `/v1/admin/settlements/${text(autoSettled, 'settlementId')}`,
          operator,
          'CONFIRMED',
        );
        expect(at(automatic, 'trigger')).toBe('AUTOMATIC');
        await assertBatch(automaticOffset, automatic, [fourth, fifth]);
        await updatePolicy(eth, false, 2);
        expect(at(await policy(eth), 'automaticEnabled')).toBe(false);
        expect(await policy(btc)).toEqual(isolatedBtcPolicy);

        const reclaimBefore = await traderBalances(alice);
        const reclaimReserves = at(await monitor(eth), 'pool', 'reserves');
        const expiring = await submit(alice, eth, 'QuoteToBase', '25', secondsFromNow(42));
        const expiringId = text(expiring, 'swapId');
        await until(
          async () => {
            await monitor(eth);
            return at(await swap(alice, expiringId), 'canWithdraw') === true;
          },
          RECLAIM_TIMEOUT_MS,
          RECLAIM_POLL_MS,
        );
        const reclaim = await f.request(
          'POST',
          `/v1/swaps/${expiringId}/cancel/prepare`,
          await f.token(alice.name),
          undefined,
          200,
        );
        await f.request(
          'POST',
          `/v1/swaps/${expiringId}/cancel/submit`,
          await f.token(alice.name),
          sign(alice.key, reclaim),
          202,
        );
        await swapStatus(f, alice, expiringId, 'WITHDRAWN');
        expectAmount(
          balance(await traderBalances(alice), 'USDC', 'available'),
          balance(reclaimBefore, 'USDC', 'available'),
        );
        expectAmount(balance(await traderBalances(alice), 'USDC', 'locked'), '0');
        expect(at(await monitor(eth), 'pool', 'reserves')).toEqual(reclaimReserves);
        await allocations(ledger, await f.token(alice.name), alice.party, expiring, false);
        await backing(ledger, eth);
      } finally {
        await independently(
          'Restore each fixture setting independently',
          () => restorePolicy(btc, savedBtc),
          () => restorePolicy(eth, savedEth),
        );
      }
    });
  });
});
