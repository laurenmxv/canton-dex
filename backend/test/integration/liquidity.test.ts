import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { divideFloor, numericText, numericUnits } from '../../src/platform/decimal.js';
import { at, items, text } from '../support/json.js';
import { withBackend, type BackendFixture } from './support/backend.js';
import { restoreAccess, revokeAccess, withdrawAllocation } from './support/liquidity-ledger.js';
import { backing } from './support/pool-ledger.js';
import { scenario } from './support/scenario.js';
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
  until,
  type Trader,
} from './support/traders.js';

const RECOVERY_TIMEOUT_MS = 55_000;
const RECOVERY_POLL_MS = 1_000;
const DEPOSIT_FIELDS = ['actualBaseIn', 'actualQuoteIn', 'actualBaseRefund', 'actualQuoteRefund', 'actualLpOut'];

function requestStatus(test: BackendFixture, token: string, kind: string, id: string, expected: string) {
  return status(test, `/v1/lp/${kind}/${id}`, token, expected);
}

async function deposit(test: BackendFixture, trader: Trader, pool: string, deadline?: string): Promise<unknown> {
  const token = await test.token(trader.name);
  const quote = await test.request(
    'POST',
    '/v1/lp/deposit/quote',
    token,
    { poolId: pool, maxBaseAmount: '0.005', maxQuoteAmount: '1000', slippageBps: 100 },
    200,
  );
  const preparation = await test.request(
    'POST',
    '/v1/lp/deposit/prepare',
    token,
    {
      quoteId: text(quote, 'quoteId'),
      minLpOut: text(quote, 'minLpOut'),
      minRatio: text(quote, 'minRatio'),
      maxRatio: text(quote, 'maxRatio'),
      settlementDeadline: deadline ?? text(quote, 'settlementDeadline'),
    },
    200,
  );
  await test.request('POST', '/v1/lp/deposit/submit', token, sign(trader.key, preparation), 202);
  return requestStatus(test, token, 'deposit', text(preparation, 'requestId'), 'READY');
}

async function settle(test: BackendFixture, operator: string, pool: string, type: string, requestId: string) {
  const batch = await test.request(
    'POST',
    `/v1/admin/pools/${pool}/settlements`,
    operator,
    { idempotencyKey: randomUUID() },
    202,
  );
  const result = await status(test, `/v1/admin/settlements/${text(batch, 'settlementId')}`, operator, 'CONFIRMED');
  expect(items(result, 'requests')).toHaveLength(1);
  expect(at(result, 'requests', 0, 'type')).toBe(type);
  expect(at(result, 'requests', 0, 'requestId')).toBe(requestId);
  return result;
}

async function position(test: BackendFixture, token: string, pool: string): Promise<unknown> {
  const found = items(await test.request('GET', '/v1/lp/positions', token, undefined, 200), 'items').find(
    (item) => at(item, 'poolId') === pool,
  );
  if (found === undefined) throw new Error('LP position missing');
  return found;
}

describe.runIf(scenario('liquidity'))('liquidity', () => {
  it('liquidity requires access and a partial recovery returns the remaining funds', async () => {
    await withBackend(async (f) => {
      const ledger = f.fixtures.operatorLedger();
      const { rows } = await sql<{ pool_id: string }>`
        SELECT pool_id FROM test_token_pools WHERE pair='BTC/USDC'`.execute(f.fixtures.db);
      const pool = rows[0]?.pool_id ?? '';
      expect(rows).toHaveLength(1);
      const operator = await f.token('operator');
      const monitor = () => f.request('GET', `/v1/admin/monitoring?poolId=${pool}`, operator, undefined, 200);
      const policy = await f.request(
        'GET',
        `/v1/admin/pools/${pool}/settlement-policy/deposit`,
        operator,
        undefined,
        200,
      );
      expect(at(policy, 'automaticEnabled')).toBe(false);
      expect(
        await f.request('GET', `/v1/admin/settlement-requests?poolId=${pool}&status=active`, operator, undefined, 200),
      ).toEqual([]);
      const trader = await onboard(f, 'liquidity', [pool]);
      await faucet(f, trader);
      const token = await f.token(trader.name);
      const before = await balances(f, token);
      const beforePool = at(await monitor(), 'pool');
      let deposited = await deposit(f, trader, pool);
      const terms = at(deposited, 'terms');
      expect(at(terms, 'mode')).toBe('PROPORTIONAL');
      expect(
        numericUnits(text(terms, 'expectedBaseRefund')) + numericUnits(text(terms, 'expectedQuoteRefund')),
      ).toBeGreaterThan(0n);
      expect(items(deposited, 'allocationCids')).toHaveLength(3);
      const depositSettlement = await settle(f, operator, pool, 'deposit', text(deposited, 'requestId'));
      deposited = await requestStatus(f, token, 'deposit', text(deposited, 'requestId'), 'SETTLED');
      const result = at(deposited, 'result');
      expect(result).not.toBeNull();
      for (const field of DEPOSIT_FIELDS) {
        expect(at(result, field)).toEqual(at(depositSettlement, 'fills', 0, field));
      }
      expectAmount(plus(text(result, 'actualBaseIn'), text(result, 'actualBaseRefund')), text(terms, 'maxBaseAmount'));
      expectAmount(
        plus(text(result, 'actualQuoteIn'), text(result, 'actualQuoteRefund')),
        text(terms, 'maxQuoteAmount'),
      );
      const afterDeposit = await balances(f, token);
      expectAmount(
        balance(afterDeposit, 'BTC', 'available'),
        minus(balance(before, 'BTC', 'available'), text(result, 'actualBaseIn')),
      );
      expectAmount(
        balance(afterDeposit, 'USDC', 'available'),
        minus(balance(before, 'USDC', 'available'), text(result, 'actualQuoteIn')),
      );
      expectAmount(text(await position(f, token, pool), 'availableLp'), text(result, 'actualLpOut'));
      expectAmount(
        text(await monitor(), 'pool', 'lpTokenSupply'),
        plus(text(beforePool, 'lpTokenSupply'), text(result, 'actualLpOut')),
      );
      await backing(ledger, pool);

      const expiring = await deposit(f, trader, pool, secondsFromNow(45));
      const expiredId = text(expiring, 'requestId');
      let access = await revokeAccess(ledger, trader.party, pool);
      // Half of the minted LP, rounded down at scale 10 and written with all ten digits.
      const lpAmount = numericText(divideFloor(numericUnits(text(result, 'actualLpOut')), numericUnits('2')));
      const refused = await f.request(
        'POST',
        '/v1/lp/withdraw/quote',
        token,
        { poolId: pool, lpAmount, slippageBps: 100 },
        409,
      );
      expect(at(refused, 'code')).toBe('POOL_ACCESS_REQUIRED');
      await restoreAccess(ledger, access);
      const quote = await f.request(
        'POST',
        '/v1/lp/withdraw/quote',
        token,
        { poolId: pool, lpAmount, slippageBps: 100 },
        200,
      );
      const prepared = await f.request(
        'POST',
        '/v1/lp/withdraw/prepare',
        token,
        {
          quoteId: text(quote, 'quoteId'),
          minBaseOut: text(quote, 'minBaseOut'),
          minQuoteOut: text(quote, 'minQuoteOut'),
          settlementDeadline: text(quote, 'settlementDeadline'),
        },
        200,
      );
      await f.request('POST', '/v1/lp/withdraw/submit', token, sign(trader.key, prepared), 202);
      const withdrawalId = text(prepared, 'requestId');
      await requestStatus(f, token, 'withdraw', withdrawalId, 'READY');
      await settle(f, operator, pool, 'withdraw', withdrawalId);
      const withdrawal = at(await requestStatus(f, token, 'withdraw', withdrawalId, 'SETTLED'), 'result');
      expectAmount(text(withdrawal, 'actualLpBurned'), lpAmount);
      expectAmount(text(await position(f, token, pool), 'availableLp'), minus(text(result, 'actualLpOut'), lpAmount));
      await backing(ledger, pool);

      await until(
        async () => {
          await monitor();
          return (
            at(await f.request('GET', `/v1/lp/deposit/${expiredId}`, token, undefined, 200), 'canRecover') === true
          );
        },
        RECOVERY_TIMEOUT_MS,
        RECOVERY_POLL_MS,
      );
      const baseAllocation = text(expiring, 'allocationCids', 0);
      await withdrawAllocation(f.fixtures, token, trader.party, trader.key, baseAllocation);
      access = await revokeAccess(ledger, trader.party, pool);
      const blocked = await f.request('POST', `/v1/lp/deposit/${expiredId}/cancel/prepare`, token, undefined, 409);
      expect(at(blocked, 'code')).toBe('POOL_ACCESS_REQUIRED');
      await restoreAccess(ledger, access);
      const recovery = await f.request('POST', `/v1/lp/deposit/${expiredId}/cancel/prepare`, token, undefined, 200);
      const effects = items(recovery, 'recoveryEffects');
      expect(effects).toHaveLength(2);
      expect(effects.some((effect) => at(effect, 'allocationCid') === baseAllocation)).toBe(false);
      expect(effects.some((effect) => at(effect, 'kind') === 'RETURN_FUNDS')).toBe(true);
      expect(effects.some((effect) => at(effect, 'kind') === 'RELEASE_PERMISSION')).toBe(true);
      await f.request('POST', `/v1/lp/deposit/${expiredId}/cancel/submit`, token, sign(trader.key, recovery), 202);
      await requestStatus(f, token, 'deposit', expiredId, 'RECOVERED');
      const after = await balances(f, token);
      expectAmount(
        balance(after, 'BTC', 'available'),
        plus(balance(afterDeposit, 'BTC', 'available'), text(withdrawal, 'actualBaseOut')),
      );
      expectAmount(
        balance(after, 'USDC', 'available'),
        plus(balance(afterDeposit, 'USDC', 'available'), text(withdrawal, 'actualQuoteOut')),
      );
      expectAmount(balance(after, 'BTC', 'locked'), '0');
      expectAmount(balance(after, 'USDC', 'locked'), '0');
      expectAmount(text(await position(f, token, pool), 'allocatedLp'), '0');
      await backing(ledger, pool);
      const activity = items(await f.request('GET', '/v1/activity?type=all', token, undefined, 200), 'items');
      expect(activity).toHaveLength(3);
      expect(activity.some((item) => at(item, 'type') === 'withdraw')).toBe(true);
      expect(activity.some((item) => at(item, 'request', 'status') === 'RECOVERED')).toBe(true);
    });
  });
});
