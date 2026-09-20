import { describe, expect, it } from 'vitest';
import { createDexClient } from '../../../client.js';
import { DexClientError } from '../../../errors.js';
import {
  CONFIRMED_SETTLEMENT,
  MONITORING,
  QUEUED_SWAP,
  SETTLEMENT_POLICY,
  jsonResponse,
  recordFetch,
} from '../../../test-support.js';

const BASE = 'https://venue.example.com';
const POOL = '00pool0001';

function clientWith(body: unknown, status = 200) {
  const recorder = recordFetch(() => jsonResponse(status, body));
  const client = createDexClient({
    baseUrl: BASE,
    getAccessToken: () => 'token',
    fetchImpl: recorder.fetchImpl,
  });
  return { client: client.admin.settlements, calls: recorder.calls };
}

describe('one pool’s queue', () => {
  it('asks for the pool alone and lets the route apply its ready default', async () => {
    const { client, calls } = clientWith([QUEUED_SWAP]);

    const queue = await client.requests(POOL);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/admin/settlement-requests');
    expect(Object.fromEntries(url.searchParams)).toEqual({ poolId: POOL });
    expect(queue).toEqual([QUEUED_SWAP]);
  });

  it('asks for the whole outstanding queue when the dashboard needs the blocked entries too', async () => {
    const { client, calls } = clientWith([]);

    await client.requests(POOL, 'active');

    const url = new URL(calls[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({ poolId: POOL, status: 'active' });
  });

  it('reports the counts, the wait and the blocked head the venue observed', async () => {
    const { client, calls } = clientWith({
      ...MONITORING,
      blockedSwapId: QUEUED_SWAP.swapId,
      blockedReason: 'Output below the signed minimum at the current reserves',
    });

    const monitoring = await client.monitoring(POOL);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/admin/monitoring');
    expect(Object.fromEntries(url.searchParams)).toEqual({ poolId: POOL });
    expect(monitoring.readyCount).toBe(3);
    expect(monitoring.pendingCount).toBe(4);
    expect(monitoring.blockedSwapId).toBe(QUEUED_SWAP.swapId);
    expect(monitoring.pool?.health).toBe('READY');
    expect(monitoring.pool?.ledgerOffset).toBe(4821);
  });
});

describe('one pool’s settings', () => {
  it('reads them from the venue, which is what survives a reload', async () => {
    const { client, calls } = clientWith(SETTLEMENT_POLICY);

    const policy = await client.policy(POOL);

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pools/${POOL}/settlement-policy`);
    expect(policy).toEqual(SETTLEMENT_POLICY);
  });

  it('saves them with the version it last read, on the pool’s own path', async () => {
    const { client, calls } = clientWith({
      ...SETTLEMENT_POLICY,
      automaticEnabled: true,
      batchSize: 3,
      version: 5,
    });

    const saved = await client.updatePolicy(POOL, {
      automaticEnabled: true,
      batchSize: 3,
      expectedVersion: 4,
    });

    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pools/${POOL}/settlement-policy`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      automaticEnabled: true,
      batchSize: 3,
      expectedVersion: 4,
    });
    // What the venue committed, not what the form hoped for.
    expect(saved.version).toBe(5);
    expect(saved.batchSize).toBe(3);
  });

  it('reports a stale save as the conflict it is, leaving the caller to re-read', async () => {
    const { client } = clientWith({ status: 409, detail: 'Settings changed elsewhere' }, 409);

    const failure = (await client
      .updatePolicy(POOL, { automaticEnabled: false, batchSize: 9, expectedVersion: 1 })
      .catch((error: unknown) => error)) as DexClientError;

    expect(failure.status).toBe(409);
  });

  it('encodes a pool identifier rather than letting it change the path', async () => {
    const { client, calls } = clientWith(SETTLEMENT_POLICY);

    await client.policy('a b/c');

    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pools/a%20b%2Fc/settlement-policy`);
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
    expect(batch.fills).toEqual([
      {
        swapId: QUEUED_SWAP.swapId,
        amountOut: '2961.474103',
        outputInstrument: { admin: 'issuer::1220iss', id: 'USDC' },
      },
    ]);
  });
});
