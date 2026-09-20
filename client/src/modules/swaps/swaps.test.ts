import { describe, expect, it } from 'vitest';
import { createDexClient } from '../../client.js';
import { DexClientError } from '../../errors.js';
import {
  QUEUED_SWAP,
  SWAP_PREPARATION,
  SWAP_QUOTE,
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
  return { client, calls: recorder.calls };
}

describe('quoting a swap', () => {
  it('sends the exact terms to price, with amounts as decimal strings', async () => {
    const { client, calls } = clientWith(SWAP_QUOTE);

    const quote = await client.swaps.quote({
      poolId: '00pool0001',
      direction: 'BaseToQuote',
      amountIn: '0.05',
      slippageBps: 50,
    });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE}/v1/swaps/quote`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      poolId: '00pool0001',
      direction: 'BaseToQuote',
      amountIn: '0.05',
      slippageBps: 50,
    });
    expect(quote).toEqual(SWAP_QUOTE);
  });

  it('reports an expired quote as the conflict it is, keeping the venue’s own code', async () => {
    const { client } = clientWith(
      { status: 409, detail: 'Request a new quote', code: 'QUOTE_EXPIRED' },
      409,
    );

    const failure = await client.swaps
      .prepare({
        quoteId: SWAP_QUOTE.quoteId,
        minOut: SWAP_QUOTE.minOut,
        settlementDeadline: SWAP_QUOTE.settlementDeadline,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DexClientError);
    expect((failure as DexClientError).status).toBe(409);
    expect((failure as DexClientError).problem?.code).toBe('QUOTE_EXPIRED');
  });

  it('reports a participant that is temporarily unavailable, so the read can be retried', async () => {
    const { client } = clientWith(
      { status: 503, detail: 'The participant is temporarily unavailable; try again', code: 'LEDGER_UNAVAILABLE' },
      503,
    );

    const failure = (await client.swaps.get(QUEUED_SWAP.swapId).catch((error: unknown) => error)) as
      DexClientError;

    expect(failure.status).toBe(503);
    expect(failure.problem?.code).toBe('LEDGER_UNAVAILABLE');
  });
});

describe('preparing and submitting a swap', () => {
  it('approves the quoted minimum and deadline, and sends nothing else', async () => {
    const { client, calls } = clientWith(SWAP_PREPARATION);

    const prepared = await client.swaps.prepare({
      quoteId: SWAP_QUOTE.quoteId,
      minOut: SWAP_QUOTE.minOut,
      settlementDeadline: SWAP_QUOTE.settlementDeadline,
    });

    expect(calls[0]?.url).toBe(`${BASE}/v1/swaps/prepare`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      quoteId: SWAP_QUOTE.quoteId,
      minOut: SWAP_QUOTE.minOut,
      settlementDeadline: SWAP_QUOTE.settlementDeadline,
    });
    // The wallet needs the hash, its encoding and the key that must sign it.
    expect(prepared.preparedTransactionHash).toBe(SWAP_PREPARATION.preparedTransactionHash);
    expect(prepared.hashEncoding).toBe('base64');
    expect(prepared.hashingSchemeVersion).toBe(3);
    expect(prepared.publicKeyFingerprint).toBe(SWAP_PREPARATION.publicKeyFingerprint);
  });

  it('puts the preparation and the signature on the wire, and no transaction of its own', async () => {
    const { client, calls } = clientWith({ ...QUEUED_SWAP, status: 'SUBMITTING' });

    const swap = await client.swaps.submit({
      preparationId: SWAP_PREPARATION.preparationId,
      signature: SIGNATURE,
    });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE}/v1/swaps/submit`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      preparationId: SWAP_PREPARATION.preparationId,
      signature: SIGNATURE,
    });
    // Accepting a signature is not settling: the request is on its way.
    expect(swap.status).toBe('SUBMITTING');
    expect(swap.amountOut).toBeNull();
  });

  it('passes a status the ledger already confirmed straight through', async () => {
    // The participant can confirm within the call, so the answer is not always
    // SUBMITTING and the client must not decide otherwise.
    const { client } = clientWith({ ...QUEUED_SWAP, status: 'READY' });

    expect((await client.swaps.submit({ preparationId: 'p', signature: SIGNATURE })).status).toBe(
      'READY',
    );

    const withdrawn = clientWith({ ...QUEUED_SWAP, status: 'WITHDRAWN' });
    expect(
      (
        await withdrawn.client.swaps.submitCancellation(QUEUED_SWAP.swapId, {
          preparationId: 'p',
          signature: SIGNATURE,
        })
      ).status,
    ).toBe('WITHDRAWN');
  });

  it('sends one attempt only, because a lost reply leaves the outcome unknown', async () => {
    const recorder = recordFetch(() => Promise.reject(new TypeError('connection reset')));
    const client = createDexClient({
      baseUrl: BASE,
      getAccessToken: () => 'token',
      fetchImpl: recorder.fetchImpl,
    });

    await expect(
      client.swaps.submit({ preparationId: SWAP_PREPARATION.preparationId, signature: SIGNATURE }),
    ).rejects.toBeInstanceOf(DexClientError);
    expect(recorder.calls).toHaveLength(1);
  });
});

describe('reclaiming an expired request', () => {
  it('prepares the withdrawal on the request’s own path, encoded', async () => {
    const { client, calls } = clientWith({ ...SWAP_PREPARATION, action: 'WITHDRAW' });

    const prepared = await client.swaps.prepareCancellation('a b/c');

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE}/v1/swaps/a%20b%2Fc/cancel/prepare`);
    expect(calls[0]?.body).toBeUndefined();
    expect(prepared.action).toBe('WITHDRAW');
  });

  it('submits the signed withdrawal and reports it as in progress, not released', async () => {
    const { client, calls } = clientWith({ ...QUEUED_SWAP, status: 'WITHDRAWING' });

    const swap = await client.swaps.submitCancellation(QUEUED_SWAP.swapId, {
      preparationId: SWAP_PREPARATION.preparationId,
      signature: SIGNATURE,
    });

    expect(calls[0]?.url).toBe(`${BASE}/v1/swaps/${QUEUED_SWAP.swapId}/cancel/submit`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      preparationId: SWAP_PREPARATION.preparationId,
      signature: SIGNATURE,
    });
    expect(swap.status).toBe('WITHDRAWING');
  });
});

describe('the trader’s own history', () => {
  it('asks for swaps, and leaves every filter the caller did not set to the route', async () => {
    const { client, calls } = clientWith({ items: [QUEUED_SWAP], nextCursor: null });

    const page = await client.swaps.activity();

    expect(calls[0]?.url).toBe(`${BASE}/v1/activity?type=swap`);
    expect(page.items).toEqual([QUEUED_SWAP]);
    expect(page.nextCursor).toBeNull();
  });

  it('carries the status, the page size and the cursor it was given', async () => {
    const { client, calls } = clientWith({ items: [], nextCursor: null });

    await client.swaps.activity({ status: 'SETTLED', limit: 25, cursor: QUEUED_SWAP.swapId });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/activity');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: 'swap',
      status: 'SETTLED',
      limit: '25',
      cursor: QUEUED_SWAP.swapId,
    });
  });

  it('reads one request by its own identifier', async () => {
    const { client, calls } = clientWith(QUEUED_SWAP);

    const swap = await client.swaps.get(QUEUED_SWAP.swapId);

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE}/v1/swaps/${QUEUED_SWAP.swapId}`);
    expect(swap).toEqual(QUEUED_SWAP);
  });
});
