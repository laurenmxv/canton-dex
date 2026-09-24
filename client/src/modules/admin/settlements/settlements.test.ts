import { describe, expect, it } from 'vitest';
import { createDexClient } from '../../../client.js';
import { DexClientError } from '../../../errors.js';
import {
  CONFIRMED_SETTLEMENT,
  DEPOSIT_POLICY,
  MONITORING,
  QUEUED_DEPOSIT,
  QUEUED_SWAP,
  SETTLED_WITHDRAWAL,
  SETTLEMENT_PREVIEW,
  SWAP_POLICY,
  jsonResponse,
  recordFetch,
} from '../../../test-support.js';

const BASE = 'https://venue.example.com';
const POOL = '00pool0001';

function clientAnswering(reply: () => Response) {
  const recorder = recordFetch(reply);
  const client = createDexClient({
    baseUrl: BASE,
    getAccessToken: () => 'token',
    fetchImpl: recorder.fetchImpl,
  });
  return { client: client.admin.settlements, calls: recorder.calls };
}

function clientWith(body: unknown, status = 200) {
  return clientAnswering(() => jsonResponse(status, body));
}

describe('one pool’s queue', () => {
  it('asks for the pool alone and lets the route apply its ready default', async () => {
    const entries = [
      { type: 'swap', request: QUEUED_SWAP },
      { type: 'deposit', request: QUEUED_DEPOSIT },
    ];
    const { client, calls } = clientWith(entries);

    const queue = await client.requests(POOL);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/admin/settlement-requests');
    expect(Object.fromEntries(url.searchParams)).toEqual({ poolId: POOL });
    // Each entry carries its kind, and the record the trader sees under it.
    expect(queue).toEqual(entries);
  });

  it('asks for the whole outstanding queue when the dashboard needs the blocked entries too', async () => {
    const { client, calls } = clientWith([]);

    await client.requests(POOL, 'active');

    const url = new URL(calls[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({ poolId: POOL, status: 'active' });
  });

  it('reports the counts, the wait and the blocked head the venue observed', async () => {
    const blockedRequest = { type: 'deposit', requestId: QUEUED_DEPOSIT.requestId };
    const { client, calls } = clientWith({
      ...MONITORING,
      blockedRequest,
      blockedReason: 'The deposit ratio is outside its signed bounds at the current reserves',
    });

    const monitoring = await client.monitoring(POOL);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/admin/monitoring');
    expect(Object.fromEntries(url.searchParams)).toEqual({ poolId: POOL });
    expect(monitoring.readyCount).toBe(3);
    expect(monitoring.pendingCount).toBe(4);
    expect(monitoring.blockedRequest).toEqual(blockedRequest);
    expect(monitoring.pool.health).toBe('READY');
    expect(monitoring.pool.ledgerOffset).toBe(4821);
    // Every queue carries its own settings and version; there is no pool-wide one.
    const queues = monitoring.policies.map(({ type, automaticEnabled, version }) => [type, automaticEnabled, version]);
    expect(queues).toEqual([
      ['deposit', true, 2],
      ['swap', false, 4],
      ['withdraw', false, 7],
    ]);
  });

  it('reads an empty pool as one waiting for its first deposit, with no price', async () => {
    const { client } = clientWith({
      ...MONITORING,
      pool: {
        ...MONITORING.pool,
        reserves: { ...MONITORING.pool.reserves, baseReserve: '0', quoteReserve: '0', spotPrice: null, invariant: '0' },
        lpTokenSupply: '0',
        health: 'EMPTY',
      },
    });

    const { pool } = await client.monitoring(POOL);

    expect(pool.health).toBe('EMPTY');
    expect(pool.reserves.spotPrice).toBeNull();
    expect(pool.initialRatio).toBe('60000');
  });

  it('carries each request’s hold apart from its status', async () => {
    const entries = [
      { type: 'swap', request: { ...QUEUED_SWAP, status: 'BLOCKED' }, deferred: true },
      { type: 'deposit', request: QUEUED_DEPOSIT, deferred: false },
    ];
    const { client } = clientWith(entries);

    const queue = await client.requests(POOL, 'active');

    expect(queue.map((entry) => [entry.request.status, entry.deferred])).toEqual([
      ['BLOCKED', true],
      ['READY', false],
    ]);
  });
});

describe('holding a request back', () => {
  const bodiless = () => new Response(null, { status: 204 });

  it('defers one request on its family’s path, and answers with nothing', async () => {
    const { client, calls } = clientAnswering(bodiless);

    const answer = await client.setDeferred(POOL, { type: 'deposit', requestId: QUEUED_DEPOSIT.requestId }, true);

    expect(answer).toBeUndefined();
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe(
      `${BASE}/v1/admin/pools/${POOL}/settlement-requests/deposit/${QUEUED_DEPOSIT.requestId}/deferred`,
    );
    expect(JSON.parse(calls[0]!.body!)).toEqual({ deferred: true });
  });

  it('returns a request to its queue through the same route', async () => {
    const { client, calls } = clientAnswering(bodiless);

    await client.setDeferred(POOL, { type: 'swap', requestId: 'a b/c' }, false);

    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pools/${POOL}/settlement-requests/swap/a%20b%2Fc/deferred`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ deferred: false });
  });

  it('reports a request that can no longer change as the conflict it is', async () => {
    const { client } = clientWith(
      { status: 409, code: 'REQUEST_NOT_READY', detail: 'Only unexpired ready or blocked requests can change' },
      409,
    );

    const failure = (await client
      .setDeferred(POOL, { type: 'swap', requestId: QUEUED_SWAP.swapId }, true)
      .catch((error: unknown) => error)) as DexClientError;

    expect(failure.status).toBe(409);
    expect(failure.problem?.code).toBe('REQUEST_NOT_READY');
  });
});

describe('the next batch of one queue', () => {
  it('previews one family on the pool’s own path, and names no retry unless asked', async () => {
    const { client, calls } = clientWith(SETTLEMENT_PREVIEW);

    const preview = await client.preview(POOL, 'swap');

    const url = new URL(calls[0]!.url);
    expect(calls[0]?.method).toBe('GET');
    expect(url.pathname).toBe(`/v1/admin/pools/${POOL}/settlement-preview`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ type: 'swap' });
    // A blocked step moves nothing, so it has no state after it.
    expect(preview.steps.map((step) => step.status)).toEqual(['VALID', 'BLOCKED']);
    expect(preview.steps[1]?.after).toBeNull();
    expect(preview.steps[0]?.outputs[0]?.headroomBps).toBe('50');
    expect(preview.executable).toBe(false);
  });

  it('previews what a rejected batch still has eligible when asked to retry it', async () => {
    const { client, calls } = clientWith({
      ...SETTLEMENT_PREVIEW,
      selection: { ...SETTLEMENT_PREVIEW.selection, type: 'deposit', retryOf: 'batch 0001' },
    });

    const preview = await client.preview('a b/c', 'deposit', 'batch 0001');

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/admin/pools/a%20b%2Fc/settlement-preview');
    expect(Object.fromEntries(url.searchParams)).toEqual({ type: 'deposit', retryOf: 'batch 0001' });
    expect(preview.selection.retryOf).toBe('batch 0001');
  });

  it('previews one request alone on the same route, by its kind and its id', async () => {
    const request = { type: 'withdraw', requestId: SETTLED_WITHDRAWAL.requestId } as const;
    const { client, calls } = clientWith({
      ...SETTLEMENT_PREVIEW,
      selection: { ...SETTLEMENT_PREVIEW.selection, type: 'withdraw', requests: [request] },
    });

    const preview = await client.previewRequest(POOL, request);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v1/admin/pools/${POOL}/settlement-preview`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ type: 'withdraw', requestId: request.requestId });
    // A batch of one, which is exactly what a run of that request sends.
    expect(preview.selection.requests).toEqual([request]);
    expect(preview.selection.retryOf).toBeNull();
  });

  it('runs exactly the membership the preview proposed, under the caller’s key', async () => {
    const key = '11111111-0000-4000-8000-000000000098';
    const { client, calls } = clientWith({ ...CONFIRMED_SETTLEMENT, status: 'PREPARING', settlementId: key });

    const batch = await client.run(POOL, { idempotencyKey: key, selection: SETTLEMENT_PREVIEW.selection });

    expect(JSON.parse(calls[0]!.body!)).toEqual({
      idempotencyKey: key,
      selection: SETTLEMENT_PREVIEW.selection,
    });
    expect(batch.settlementId).toBe(key);
  });

  it('reports a stale selection as the conflict the venue named', async () => {
    const { client } = clientWith(
      { status: 409, code: 'QUEUE_CHANGED', detail: 'Queue changed. Refresh the preview.' },
      409,
    );

    const failure = (await client
      .run(POOL, { idempotencyKey: '11111111-0000-4000-8000-000000000097', selection: SETTLEMENT_PREVIEW.selection })
      .catch((error: unknown) => error)) as DexClientError;

    expect(failure.status).toBe(409);
    expect(failure.problem?.code).toBe('QUEUE_CHANGED');
  });
});

describe('every batch a pool ran', () => {
  it('pages them with the filters and the cursor the venue applies', async () => {
    const page = {
      items: [{ ...CONFIRMED_SETTLEMENT, retryOf: 'ee444444-0000-4000-8000-000000000001' }],
      nextCursor: 'cursor-2',
    };
    const { client, calls } = clientWith(page);

    const history = await client.history(POOL, {
      type: 'swap',
      status: 'CONFIRMED',
      before: 'cursor-1',
      limit: 25,
    });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v1/admin/pools/${POOL}/settlement-history`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: 'swap',
      status: 'CONFIRMED',
      before: 'cursor-1',
      limit: '25',
    });
    expect(history.nextCursor).toBe('cursor-2');
    // A retry names the attempt it followed; that attempt is not rewritten.
    expect(history.items[0]?.retryOf).toBe('ee444444-0000-4000-8000-000000000001');
  });

  it('leaves every filter to the route when none is given', async () => {
    const { client, calls } = clientWith({ items: [], nextCursor: null });

    const history = await client.history(POOL);

    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pools/${POOL}/settlement-history`);
    expect(history.nextCursor).toBeNull();
  });
});

describe('one queue’s settings', () => {
  it('reads one queue on its own path, which is what survives a reload', async () => {
    const { client, calls } = clientWith(SWAP_POLICY);

    const policy = await client.policy(POOL, 'swap');

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pools/${POOL}/settlement-policy/swap`);
    expect(policy).toEqual(SWAP_POLICY);
  });

  it('saves one queue with the version it last read for that queue', async () => {
    const { client, calls } = clientWith({ ...DEPOSIT_POLICY, automaticEnabled: false, batchSize: 4, version: 3 });

    const saved = await client.updatePolicy(POOL, 'deposit', {
      automaticEnabled: false,
      batchSize: 4,
      expectedVersion: DEPOSIT_POLICY.version,
    });

    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pools/${POOL}/settlement-policy/deposit`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      automaticEnabled: false,
      batchSize: 4,
      expectedVersion: DEPOSIT_POLICY.version,
    });
    // What the venue committed for that queue, not what the form hoped for.
    expect(saved).toMatchObject({ type: 'deposit', batchSize: 4, version: 3 });
  });

  it('reports a stale save as the conflict it is, leaving the caller to re-read', async () => {
    const { client } = clientWith({ status: 409, detail: 'Settings changed elsewhere' }, 409);

    const failure = (await client
      .updatePolicy(POOL, 'withdraw', { automaticEnabled: false, batchSize: 9, expectedVersion: 1 })
      .catch((error: unknown) => error)) as DexClientError;

    expect(failure.status).toBe(409);
  });

  it('encodes a pool identifier rather than letting it change the path', async () => {
    const { client, calls } = clientWith(SWAP_POLICY);

    await client.policy('a b/c', 'withdraw');

    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pools/a%20b%2Fc/settlement-policy/withdraw`);
  });
});

describe('batches', () => {
  it('runs one with the caller’s idempotency key, so a repeat cannot start a second', async () => {
    const key = '11111111-0000-4000-8000-000000000099';
    const { client, calls } = clientWith({ ...CONFIRMED_SETTLEMENT, status: 'SUBMITTING' });

    const batch = await client.run(POOL, { idempotencyKey: key });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pools/${POOL}/settlements`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ idempotencyKey: key });
    expect(batch.status).toBe('SUBMITTING');
  });

  it('lists one pool’s batches, with the confirmed reserves on each side', async () => {
    const { client, calls } = clientWith([CONFIRMED_SETTLEMENT]);

    const batches = await client.list(POOL);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/admin/settlements');
    expect(Object.fromEntries(url.searchParams)).toEqual({ poolId: POOL });
    expect(batches[0]?.before?.baseReserve).toBe('5');
    expect(batches[0]?.after?.baseReserve).toBe('5.05');
  });

  it('lists every pool’s batches when no pool is named', async () => {
    const { client, calls } = clientWith([]);

    await client.list();

    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/settlements`);
  });

  it('reads one batch and its per-request fills', async () => {
    const { client, calls } = clientWith(CONFIRMED_SETTLEMENT);

    const batch = await client.get(CONFIRMED_SETTLEMENT.settlementId);

    expect(calls[0]?.url).toBe(
      `${BASE}/v1/admin/settlements/${CONFIRMED_SETTLEMENT.settlementId}`,
    );
    expect(batch.requests).toEqual([{ type: 'swap', requestId: QUEUED_SWAP.swapId }]);
    expect(batch.fills).toEqual([
      {
        type: 'swap',
        requestId: QUEUED_SWAP.swapId,
        amountOut: '2961.474103',
        outputInstrument: { admin: 'issuer::1220iss', id: 'USDC' },
      },
    ]);
  });

  it('reads an initial deposit, which settles in a batch of its own', async () => {
    const fill = {
      type: 'deposit',
      requestId: QUEUED_DEPOSIT.requestId,
      actualBaseIn: '5',
      actualQuoteIn: '300000',
      actualBaseRefund: '0',
      actualQuoteRefund: '0',
      actualLpOut: '1224.7448712915',
    };
    const { client } = clientWith({
      ...CONFIRMED_SETTLEMENT,
      requests: [{ type: 'deposit', requestId: QUEUED_DEPOSIT.requestId }],
      fills: [fill],
    });

    const batch = await client.get(CONFIRMED_SETTLEMENT.settlementId);

    expect(batch.fills).toEqual([fill]);
  });

  it('reads withdrawals settled together, and each fill names the request it paid', async () => {
    const fills = [
      {
        type: 'withdraw',
        requestId: SETTLED_WITHDRAWAL.requestId,
        actualLpBurned: '100',
        actualBaseOut: '0.4082482905',
        actualQuoteOut: '24494.8974278318',
      },
      {
        type: 'withdraw',
        requestId: 'ff000000-0000-4000-8000-000000000018',
        actualLpBurned: '40',
        actualBaseOut: '0.1632993162',
        actualQuoteOut: '9797.9589711327',
      },
    ];
    const requests = fills.map(({ type, requestId }) => ({ type, requestId }));
    const { client } = clientWith({ ...CONFIRMED_SETTLEMENT, requests, fills });

    const batch = await client.get(CONFIRMED_SETTLEMENT.settlementId);

    expect(batch.requests).toEqual(requests);
    expect(batch.fills).toEqual(fills);
  });
});
