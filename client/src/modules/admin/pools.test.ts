import { describe, expect, it, vi } from 'vitest';
import { createDexClient } from '../../client.js';
import { DexClientError } from '../../errors.js';
import {
  CREATED_PROPOSAL,
  PENDING_PROPOSAL,
  POOL_DETAIL,
  POOL_TERMS,
  jsonResponse,
  recordFetch,
} from '../../test-support.js';
import type { CreatePoolProposal } from '../../types/pool.js';

const PROPOSAL_ID = 'a7c9e1f3-0000-4000-8000-00000000000b';
const BASE = 'https://venue.example.com';

function clientWith(body: unknown, status = 200, contentType = 'application/json') {
  const recorder = recordFetch(() => jsonResponse(status, body, contentType));
  const client = createDexClient({
    baseUrl: BASE,
    getAccessToken: () => 'token',
    fetchImpl: recorder.fetchImpl,
  });
  return { client, calls: recorder.calls };
}

const PROPOSED: CreatePoolProposal = {
  name: 'USDC / EURC',
  baseInstrumentId: POOL_TERMS.baseInstrumentId,
  quoteInstrumentId: POOL_TERMS.quoteInstrumentId,
  feeBps: '30',
};

describe('the pool proposal queue', () => {
  it('reads every proposal from one route, newest first as the venue sent them', async () => {
    const { client, calls } = clientWith([CREATED_PROPOSAL, PENDING_PROPOSAL]);

    const list = await client.admin.listPoolProposals();

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pool-proposals`);
    expect(calls[0]?.body).toBeUndefined();
    expect(list).toEqual([CREATED_PROPOSAL, PENDING_PROPOSAL]);
  });

  it('reads one proposal by its own identifier, encoded', async () => {
    const { client, calls } = clientWith(PENDING_PROPOSAL);

    await client.admin.getPoolProposal('a b/c');

    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pool-proposals/a%20b%2Fc`);
  });

  it('asks for what a proposal is built against, from the static route', async () => {
    const options = {
      factoryId: '00factory0001',
      dvo: 'dvo::1220dvo',
      venueOperator: 'venue-operator::1220beef',
      instruments: [
        { admin: 'issuer-usdc::1220usdc', id: 'USDC', symbol: 'USDC', decimals: 6 },
        { admin: 'issuer-eurc::1220eurc', id: 'EURC', symbol: 'EURC', decimals: 6 },
      ],
    };
    const { client, calls } = clientWith(options);

    await expect(client.admin.poolCreationOptions()).resolves.toEqual(options);
    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pool-proposals/options`);
  });

  it('sends the proposal as it was given, and nothing the venue assigns', async () => {
    const { client, calls } = clientWith(PENDING_PROPOSAL, 202);

    const created = await client.admin.createPoolProposal(PROPOSED);

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pool-proposals`);
    expect(JSON.parse(calls[0]!.body!)).toEqual(PROPOSED);
    // The fee stays a string on the wire, and the dvo configures what the pool holds.
    expect(JSON.parse(calls[0]!.body!).feeBps).toBe('30');
    expect(calls[0]!.body).not.toMatch(
      /"(dvo|factoryId|proposedBy|actAs|baseReserve|lpTokenSupply|lpTokenId|initialRatio)"/,
    );
    expect(created).toEqual(PENDING_PROPOSAL);
  });

  it('withdraws with an empty body, at the proposal’s own route', async () => {
    const { client, calls } = clientWith({ ...PENDING_PROPOSAL, status: 'WITHDRAWN' }, 202);

    const withdrawn = await client.admin.withdrawPoolProposal(PROPOSAL_ID);

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pool-proposals/${PROPOSAL_ID}/withdraw`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({});
    expect(withdrawn.status).toBe('WITHDRAWN');
  });

  it('carries a failure the venue reports, without reading it as an outcome', async () => {
    const failed = { ...PENDING_PROPOSAL, status: 'FAILED', error: 'DUPLICATE_KEY' };
    const { client } = clientWith([failed]);

    const [first] = await client.admin.listPoolProposals();

    expect(first?.status).toBe('FAILED');
    expect(first?.error).toBe('DUPLICATE_KEY');
    expect(first?.poolId).toBeNull();
  });
});

describe('the pools an operator sees', () => {
  it('reads the venue’s own pools with the contracts behind them', async () => {
    const { client, calls } = clientWith([POOL_DETAIL]);

    const pools = await client.admin.listPools();

    expect(calls[0]?.url).toBe(`${BASE}/v1/admin/pools`);
    expect(pools[0]?.configId).toBe('00config0001');
    expect(pools[0]?.stateId).toBe('00state0001');
    expect(pools[0]?.settings.baseAccount.provider).toBe('venue-operator::1220beef');
  });

  it('reads one pool from the route any caller may use', async () => {
    const { client, calls } = clientWith(POOL_DETAIL);

    await client.pools.get('00pool0001');

    expect(calls[0]?.url).toBe(`${BASE}/v1/pools/00pool0001`);
  });

  it('leaves the catalogue route alone', async () => {
    const { client, calls } = clientWith([{ poolId: '00pool0001', name: 'USDC / EURC' }]);

    await client.pools.list();

    expect(calls[0]?.url).toBe(`${BASE}/v1/pools`);
  });
});

describe('what the venue refuses', () => {
  it('reports a duplicate pair as a conflict, with the venue’s own detail', async () => {
    const { client } = clientWith(
      {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'A pool for USDC/EURC already exists',
      },
      409,
      'application/problem+json',
    );

    const error = (await client.admin
      .createPoolProposal(PROPOSED)
      .catch((cause: unknown) => cause)) as DexClientError;

    expect(error).toBeInstanceOf(DexClientError);
    expect(error.kind).toBe('http');
    expect(error.status).toBe(409);
    expect(error.problem?.detail).toBe('A pool for USDC/EURC already exists');
  });

  it.each([400, 403, 404, 503])('keeps status %s as the venue sent it', async (status) => {
    const { client } = clientWith({ title: 'Nope', status }, status, 'application/problem+json');

    const error = (await client.admin
      .listPoolProposals()
      .catch((cause: unknown) => cause)) as DexClientError;

    expect(error.status).toBe(status);
  });

  it('refuses an answer that is not the shape the route promises', async () => {
    const { client } = clientWith('not a proposal');

    await expect(client.admin.getPoolProposal(PROPOSAL_ID)).rejects.toMatchObject({
      kind: 'response',
    });
  });
});

describe('cancellation', () => {
  it('carries the caller’s signal, and never sends an already aborted read', async () => {
    const { client, calls } = clientWith([PENDING_PROPOSAL]);
    const controller = new AbortController();

    await client.admin.listPoolProposals({ signal: controller.signal });
    expect(calls[0]?.signal).toBe(controller.signal);

    controller.abort();
    await expect(
      client.admin.listPoolProposals({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
  });

  it('stops a write the caller gave up on', async () => {
    const controller = new AbortController();
    const recorder = recordFetch(() => {
      controller.abort();
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    const client = createDexClient({
      baseUrl: BASE,
      getAccessToken: () => 'token',
      fetchImpl: recorder.fetchImpl,
    });

    await expect(
      client.admin.createPoolProposal(PROPOSED, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('asks for a token immediately before each call, and never caches one', async () => {
    const getAccessToken = vi.fn(() => 'token');
    const recorder = recordFetch(() => jsonResponse(200, [PENDING_PROPOSAL]));
    const client = createDexClient({ baseUrl: BASE, getAccessToken, fetchImpl: recorder.fetchImpl });

    await client.admin.listPoolProposals();
    await client.admin.listPools();

    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(recorder.calls[0]?.headers['authorization']).toBe('Bearer token');
  });
});
