import { describe, expect, it } from 'vitest';
import { createDexClient } from '../../client.js';
import { DexClientError } from '../../errors.js';
import { BALANCES, FAUCET_PREPARATION, jsonResponse, recordFetch } from '../../test-support.js';

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

describe('balances', () => {
  it('reads the caller’s own holdings, with locked funds kept apart from available', async () => {
    const { client, calls } = clientWith(BALANCES);

    const held = await client.tokens.balances();

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE}/v1/balances`);
    const usdc = held.balances.find((balance) => balance.symbol === 'USDC');
    expect(usdc).toEqual({
      instrument: { admin: 'issuer::1220iss', id: 'USDC' },
      symbol: 'USDC',
      decimals: 6,
      available: '9500',
      locked: '500',
      total: '10000',
    });
    expect(held.asOfOffset).toBe(4821);
  });
});

describe('the development faucet', () => {
  it('reads the claim’s standing without asking for anything', async () => {
    const { client, calls } = clientWith({
      status: 'AVAILABLE',
      updateId: null,
      errorCode: null,
      error: null,
    });

    const result = await client.tokens.faucetStatus();

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE}/v1/dev/faucet`);
    expect(result.status).toBe('AVAILABLE');
  });

  it('prepares with no body, and is told exactly which amounts the claim grants', async () => {
    const { client, calls } = clientWith(FAUCET_PREPARATION);

    const prepared = await client.tokens.prepareFaucetClaim();

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE}/v1/dev/faucet/prepare`);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers['content-type']).toBeUndefined();
    expect(prepared.amounts.map((amount) => `${amount.amount} ${amount.symbol}`)).toEqual([
      '10000 USDC',
      '0.1 BTC',
    ]);
    expect(prepared.hashEncoding).toBe('base64');
  });

  it('submits the signature the wallet produced, and nothing about the key', async () => {
    const { client, calls } = clientWith({
      status: 'SUBMITTING',
      updateId: null,
      errorCode: null,
      error: null,
    });

    const result = await client.tokens.submitFaucetClaim({
      preparationId: FAUCET_PREPARATION.preparationId,
      signature: SIGNATURE,
    });

    expect(calls[0]?.url).toBe(`${BASE}/v1/dev/faucet/submit`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      preparationId: FAUCET_PREPARATION.preparationId,
      signature: SIGNATURE,
    });
    expect(result.status).toBe('SUBMITTING');
  });

  it('reports a second claim as the conflict the venue answers, since the bundle is granted once', async () => {
    const { client } = clientWith(
      { status: 409, detail: 'This account already received its test tokens' },
      409,
    );

    const failure = (await client.tokens
      .prepareFaucetClaim()
      .catch((error: unknown) => error)) as DexClientError;

    expect(failure.status).toBe(409);
    expect(failure.problem?.detail).toBe('This account already received its test tokens');
  });

  it('reports a deployment without development tokens as the 404 it answers', async () => {
    const { client } = clientWith({ status: 404, detail: 'Resource not found' }, 404);

    const failure = (await client.tokens
      .faucetStatus()
      .catch((error: unknown) => error)) as DexClientError;

    expect(failure.status).toBe(404);
  });
});
