import { describe, expect, it } from 'vitest';
import { createDexClient } from '../../client.js';
import { DexClientError } from '../../errors.js';
import {
  DEPOSIT_PREPARATION,
  DEPOSIT_QUOTE,
  POSITIONS,
  QUEUED_DEPOSIT,
  SETTLED_WITHDRAWAL,
  WITHDRAWAL_PREPARATION,
  WITHDRAWAL_QUOTE,
  jsonResponse,
  recordFetch,
} from '../../test-support.js';

const BASE = 'https://venue.example.com';
const SIGNATURE = 'MEQCIBEiM0RVZneImaq7zN3u/wACIDNEVWZ3iJmqu8zd7v8AESIz';

function clientWith(body: unknown, status = 200) {
  const recorder = recordFetch(() => jsonResponse(status, body));
  const client = createDexClient({
    baseUrl: BASE,
    getAccessToken: () => 'token',
    fetchImpl: recorder.fetchImpl,
  });
  return { lp: client.lp, calls: recorder.calls };
}

function sent(calls: ReturnType<typeof clientWith>['calls']) {
  return { method: calls[0]?.method, url: calls[0]?.url, body: JSON.parse(calls[0]?.body ?? 'null') };
}

describe('a deposit, from quote to signed request', () => {
  it('prices the maximum amounts offered, as decimal strings', async () => {
    const { lp, calls } = clientWith(DEPOSIT_QUOTE);

    const quote = await lp.quoteDeposit({
      poolId: '00pool0001',
      maxBaseAmount: '5',
      maxQuoteAmount: '300000',
      slippageBps: 50,
    });

    expect(sent(calls)).toEqual({
      method: 'POST',
      url: `${BASE}/v1/lp/deposit/quote`,
      body: { poolId: '00pool0001', maxBaseAmount: '5', maxQuoteAmount: '300000', slippageBps: 50 },
    });
    // The venue's figures pass through untouched, including the locked minimum.
    expect(quote).toEqual(DEPOSIT_QUOTE);
    expect(quote.initialMinimumLp).toBe('0.0000001');
  });

  it('approves the quoted minimum, ratio bounds and deadline, and nothing else', async () => {
    const { lp, calls } = clientWith(DEPOSIT_PREPARATION);

    const prepared = await lp.prepareDeposit({
      quoteId: DEPOSIT_QUOTE.quoteId,
      minLpOut: DEPOSIT_QUOTE.minLpOut,
      minRatio: DEPOSIT_QUOTE.minRatio,
      maxRatio: DEPOSIT_QUOTE.maxRatio,
      settlementDeadline: DEPOSIT_QUOTE.settlementDeadline,
    });

    expect(sent(calls)).toEqual({
      method: 'POST',
      url: `${BASE}/v1/lp/deposit/prepare`,
      body: {
        quoteId: DEPOSIT_QUOTE.quoteId,
        minLpOut: DEPOSIT_QUOTE.minLpOut,
        minRatio: DEPOSIT_QUOTE.minRatio,
        maxRatio: DEPOSIT_QUOTE.maxRatio,
        settlementDeadline: DEPOSIT_QUOTE.settlementDeadline,
      },
    });
    expect(prepared.requestId).toBe(DEPOSIT_PREPARATION.requestId);
    expect(prepared.terms).not.toHaveProperty('kind');
    expect(prepared.recoveryEffects).toEqual([]);
  });

  it('submits the preparation and signature, and reads the nested request back', async () => {
    const { lp, calls } = clientWith(QUEUED_DEPOSIT, 202);

    const request = await lp.submitDeposit({
      preparationId: DEPOSIT_PREPARATION.preparationId,
      signature: SIGNATURE,
    });

    expect(sent(calls)).toEqual({
      method: 'POST',
      url: `${BASE}/v1/lp/deposit/submit`,
      body: { preparationId: DEPOSIT_PREPARATION.preparationId, signature: SIGNATURE },
    });
    expect(request.kind).toBe('DEPOSIT');
    expect(request.terms.minLpOut).toBe(DEPOSIT_QUOTE.minLpOut);
    expect(request.result).toBeNull();
  });

  it('sends one attempt only, because a lost reply leaves the outcome unknown', async () => {
    const recorder = recordFetch(() => Promise.reject(new TypeError('connection reset')));
    const client = createDexClient({
      baseUrl: BASE,
      getAccessToken: () => 'token',
      fetchImpl: recorder.fetchImpl,
    });

    await expect(
      client.lp.submitDeposit({ preparationId: 'p', signature: SIGNATURE }),
    ).rejects.toBeInstanceOf(DexClientError);
    await expect(
      client.lp.submitWithdrawal({ preparationId: 'p', signature: SIGNATURE }),
    ).rejects.toBeInstanceOf(DexClientError);
    expect(recorder.calls).toHaveLength(2);
  });

  it('keeps the venue’s own code on a refused preparation', async () => {
    const { lp } = clientWith(
      { status: 409, detail: 'This preparation has expired', code: 'PREPARATION_EXPIRED' },
      409,
    );

    const failure = (await lp
      .prepareDeposit({
        quoteId: DEPOSIT_QUOTE.quoteId,
        minLpOut: '1',
        minRatio: '1',
        maxRatio: '1',
        settlementDeadline: DEPOSIT_QUOTE.settlementDeadline,
      })
      .catch((error: unknown) => error)) as DexClientError;

    expect(failure.status).toBe(409);
    expect(failure.problem?.code).toBe('PREPARATION_EXPIRED');
  });
});

describe('a withdrawal, from quote to signed request', () => {
  it('prices the LP to redeem and approves the quoted minimums', async () => {
    const quoted = clientWith(WITHDRAWAL_QUOTE);
    await quoted.lp.quoteWithdrawal({ poolId: '00pool0001', lpAmount: '100', slippageBps: 50 });
    expect(sent(quoted.calls)).toEqual({
      method: 'POST',
      url: `${BASE}/v1/lp/withdraw/quote`,
      body: { poolId: '00pool0001', lpAmount: '100', slippageBps: 50 },
    });

    const prepared = clientWith(WITHDRAWAL_PREPARATION);
    await prepared.lp.prepareWithdrawal({
      quoteId: WITHDRAWAL_QUOTE.quoteId,
      minBaseOut: WITHDRAWAL_QUOTE.minBaseOut,
      minQuoteOut: WITHDRAWAL_QUOTE.minQuoteOut,
      settlementDeadline: WITHDRAWAL_QUOTE.settlementDeadline,
    });
    expect(sent(prepared.calls)).toEqual({
      method: 'POST',
      url: `${BASE}/v1/lp/withdraw/prepare`,
      body: {
        quoteId: WITHDRAWAL_QUOTE.quoteId,
        minBaseOut: WITHDRAWAL_QUOTE.minBaseOut,
        minQuoteOut: WITHDRAWAL_QUOTE.minQuoteOut,
        settlementDeadline: WITHDRAWAL_QUOTE.settlementDeadline,
      },
    });
  });

  it('reads a settled withdrawal with what it actually burned and paid', async () => {
    const { lp, calls } = clientWith(SETTLED_WITHDRAWAL);

    const request = await lp.getWithdrawal(SETTLED_WITHDRAWAL.requestId);

    expect(calls[0]?.url).toBe(`${BASE}/v1/lp/withdraw/${SETTLED_WITHDRAWAL.requestId}`);
    expect(request.kind).toBe('WITHDRAW');
    expect(request.result).toEqual({
      actualLpBurned: '100',
      actualBaseOut: '0.4082482905',
      actualQuoteOut: '24494.8974278318',
    });
  });
});

describe('recovering an expired request', () => {
  it.each([
    ['deposit', 'Deposit'],
    ['withdraw', 'Withdrawal'],
  ] as const)('prepares and submits a %s recovery on its own encoded path', async (path, name) => {
    const prepare = clientWith({ ...DEPOSIT_PREPARATION, action: 'RECOVER' });
    await prepare.lp[`prepare${name}Cancellation`]('a b/c');
    expect(prepare.calls[0]?.method).toBe('POST');
    expect(prepare.calls[0]?.url).toBe(`${BASE}/v1/lp/${path}/a%20b%2Fc/cancel/prepare`);
    expect(prepare.calls[0]?.body).toBeUndefined();

    const submit = clientWith({ ...QUEUED_DEPOSIT, status: 'RECOVERING' }, 202);
    const answer = await submit.lp[`submit${name}Cancellation`]('a b/c', {
      preparationId: 'p',
      signature: SIGNATURE,
    });
    expect(sent(submit.calls)).toEqual({
      method: 'POST',
      url: `${BASE}/v1/lp/${path}/a%20b%2Fc/cancel/submit`,
      body: { preparationId: 'p', signature: SIGNATURE },
    });
    // Recovering is not recovered: only the ledger's confirmation releases funds.
    expect(answer.status).toBe('RECOVERING');
  });

  it('passes each recovery effect through, funds and permissions apart', async () => {
    const effects = [
      { allocationCid: '00alloc0011', instrument: DEPOSIT_QUOTE.baseInstrument, amount: '5', kind: 'RETURN_FUNDS' },
      { allocationCid: '00alloc0013', instrument: DEPOSIT_QUOTE.lpInstrument, amount: '0', kind: 'RELEASE_PERMISSION' },
    ];
    const { lp } = clientWith({ ...DEPOSIT_PREPARATION, action: 'RECOVER', recoveryEffects: effects });

    const prepared = await lp.prepareDepositCancellation(QUEUED_DEPOSIT.requestId);

    expect(prepared.recoveryEffects).toEqual(effects);
  });
});

describe('the trader’s own liquidity', () => {
  it.each([
    ['deposits', 'deposit'],
    ['withdrawals', 'withdraw'],
  ] as const)('reads %s from the shared history, filtered by its own type', async (method, type) => {
    const { lp, calls } = clientWith({ items: [], nextCursor: null });

    await lp[method]();
    await lp[method]({ status: 'EXPIRED', limit: 20, cursor: 'next' });

    expect(calls[0]?.url).toBe(`${BASE}/v1/activity?type=${type}`);
    expect(Object.fromEntries(new URL(calls[1]!.url).searchParams)).toEqual({
      type,
      status: 'EXPIRED',
      limit: '20',
      cursor: 'next',
    });
  });

  it('reads every position, and one deposit by its own identifier', async () => {
    const positions = clientWith(POSITIONS);
    expect(await positions.lp.positions()).toEqual(POSITIONS);
    expect(positions.calls[0]?.url).toBe(`${BASE}/v1/lp/positions`);

    const deposit = clientWith(QUEUED_DEPOSIT);
    expect(await deposit.lp.getDeposit(QUEUED_DEPOSIT.requestId)).toEqual(QUEUED_DEPOSIT);
    expect(deposit.calls[0]?.url).toBe(`${BASE}/v1/lp/deposit/${QUEUED_DEPOSIT.requestId}`);
  });
});
