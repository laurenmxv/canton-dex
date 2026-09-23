import { describe, expect, it } from 'vitest';
import { createDexClient } from './client.js';
import { DexClientError } from './errors.js';
import { COMPLETED_ONBOARDING, jsonResponse, recordFetch } from './test-support.js';

describe('the client surface', () => {
  it('offers the operations the backend serves, and nothing else', () => {
    const client = createDexClient({
      baseUrl: '/api',
      getAccessToken: () => 'token',
      fetchImpl: recordFetch(() => jsonResponse(200, COMPLETED_ONBOARDING)).fetchImpl,
    });

    expect(Object.keys(client).sort()).toEqual([
      'activity',
      'admin',
      'lp',
      'me',
      'onboarding',
      'pools',
      'swaps',
      'tokens',
    ]);
    expect(Object.keys(client.lp).sort()).toEqual([
      'deposits',
      'getDeposit',
      'getWithdrawal',
      'positions',
      'prepareDeposit',
      'prepareDepositCancellation',
      'prepareWithdrawal',
      'prepareWithdrawalCancellation',
      'quoteDeposit',
      'quoteWithdrawal',
      'submitDeposit',
      'submitDepositCancellation',
      'submitWithdrawal',
      'submitWithdrawalCancellation',
      'withdrawals',
    ]);
    expect(Object.keys(client.onboarding).sort()).toEqual([
      'confirmParty',
      'get',
      'mine',
      'prepareParty',
      'submitApplication',
    ]);
    expect(Object.keys(client.pools).sort()).toEqual(['get', 'list']);
    expect(Object.keys(client.swaps).sort()).toEqual([
      'activity',
      'get',
      'prepare',
      'prepareCancellation',
      'quote',
      'submit',
      'submitCancellation',
    ]);
    expect(Object.keys(client.tokens).sort()).toEqual([
      'balances',
      'faucetStatus',
      'prepareFaucetClaim',
      'submitFaucetClaim',
    ]);
    expect(Object.keys(client.admin).sort()).toEqual([
      'createPoolProposal',
      'getPoolProposal',
      'listOnboardings',
      'listPoolProposals',
      'listPools',
      'poolCreationOptions',
      'reviewOnboarding',
      'settlements',
      'withdrawPoolProposal',
    ]);
    expect(Object.keys(client.admin.settlements).sort()).toEqual([
      'get',
      'history',
      'list',
      'monitoring',
      'policy',
      'preview',
      'requests',
      'run',
      'setDeferred',
      'updatePolicy',
    ]);
  });

  it('exposes no operation the backend does not serve', () => {
    const client = createDexClient({
      baseUrl: '/api',
      getAccessToken: () => 'token',
    }) as unknown as Record<string, unknown>;

    for (const absent of ['instruments', 'proposals', 'notifications', 'quotes', 'liquidity']) {
      expect(client[absent]).toBeUndefined();
    }
    const onboarding = client['onboarding'] as Record<string, unknown>;
    expect(onboarding['list']).toBeUndefined();
    const pools = client['pools'] as Record<string, unknown>;
    for (const absent of ['create', 'createProposal', 'listProposals', 'listInstruments']) {
      expect(pools[absent]).toBeUndefined();
    }
    // Signing belongs to the trader's wallet, and settling to the operator, so
    // the swap surface offers neither.
    const swaps = client['swaps'] as Record<string, unknown>;
    for (const absent of ['sign', 'execute', 'settle', 'cancel']) {
      expect(swaps[absent]).toBeUndefined();
    }
    // Pools are created through a proposal the dvo accepts, so no route here
    // creates one, approves one, or acts as anybody.
    const admin = client['admin'] as Record<string, unknown>;
    for (const absent of ['createPool', 'acceptPoolProposal', 'approvePoolProposal']) {
      expect(admin[absent]).toBeUndefined();
    }
  });
});

describe('two clients in one process', () => {
  it('authenticate independently, with no shared session', async () => {
    const alice = recordFetch(() => jsonResponse(200, COMPLETED_ONBOARDING));
    const operator = recordFetch(() => jsonResponse(200, [COMPLETED_ONBOARDING]));

    const traderClient = createDexClient({
      baseUrl: 'https://venue.example.com',
      getAccessToken: () => 'alice-token',
      fetchImpl: alice.fetchImpl,
    });
    const operatorClient = createDexClient({
      baseUrl: 'https://venue.example.com',
      getAccessToken: () => 'operator-token',
      fetchImpl: operator.fetchImpl,
    });

    await traderClient.onboarding.get('7f1c3d9e-0000-4000-8000-000000000001');
    await operatorClient.admin.listOnboardings();

    expect(alice.calls[0]?.headers['authorization']).toBe('Bearer alice-token');
    expect(operator.calls[0]?.headers['authorization']).toBe('Bearer operator-token');
    expect(alice.calls).toHaveLength(1);
    expect(operator.calls).toHaveLength(1);
  });

  it('do not let one signed-out client stop the other', async () => {
    const working = recordFetch(() => jsonResponse(200, [COMPLETED_ONBOARDING]));
    const signedOut = createDexClient({
      baseUrl: '/api',
      getAccessToken: () => null,
      fetchImpl: working.fetchImpl,
    });
    const signedIn = createDexClient({
      baseUrl: '/api',
      getAccessToken: () => 'token',
      fetchImpl: working.fetchImpl,
    });

    await expect(signedOut.admin.listOnboardings()).rejects.toBeInstanceOf(DexClientError);
    await expect(signedIn.admin.listOnboardings()).resolves.toHaveLength(1);
    // One request in total: the signed-out client sent none.
    expect(working.calls).toHaveLength(1);
  });

  it('reaches different deployments from the same process', async () => {
    const staging = recordFetch(() => jsonResponse(200, []));
    const local = recordFetch(() => jsonResponse(200, []));

    await createDexClient({
      baseUrl: 'https://staging.example.com/dex',
      getAccessToken: () => 'token',
      fetchImpl: staging.fetchImpl,
    }).admin.listOnboardings();
    await createDexClient({
      baseUrl: '/api',
      getAccessToken: () => 'token',
      fetchImpl: local.fetchImpl,
    }).admin.listOnboardings();

    expect(staging.calls[0]?.url).toBe('https://staging.example.com/dex/v1/admin/onboardings');
    expect(local.calls[0]?.url).toBe('/api/v1/admin/onboardings');
  });
});
