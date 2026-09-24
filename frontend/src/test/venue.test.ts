import { DexClientError as ApiError, type DexClient as ApiClient } from '@canton-dex/client';
import { describe, expect, it } from 'vitest';
import { errorCode } from '../lib/api/types';
import { venueClient } from '../lib/api/venue';

const ID = '7f1c3d9e-0000-4000-8000-000000000001';

/** A venue that refuses every call the same way, so only the seam is under test. */
function refusing(error: unknown): ApiClient {
  const fail = () => Promise.reject(error);
  return {
    me: fail,
    onboarding: {
      mine: fail,
      submitApplication: fail,
      get: fail,
      prepareParty: fail,
      confirmParty: fail,
    },
    pools: { list: fail },
    admin: { listOnboardings: fail, reviewOnboarding: fail },
  } as unknown as ApiClient;
}

describe('the rules a screen can act on', () => {
  it.each([
    [400, 'VALIDATION'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
  ])('turns HTTP %i into %s, with the venue’s own wording', async (status, code) => {
    const client = venueClient(
      refusing(
        new ApiError('http', `HTTP ${status}`, {
          status,
          problem: { status, detail: 'The venue said no' },
        }),
      ),
    );

    const error = (await client.pools.list().catch((cause: unknown) => cause)) as Error;
    expect(errorCode(error)).toBe(code);
    expect(error.message).toBe('The venue said no');
  });

  it('falls back to its own words when the venue sends no detail', async () => {
    const client = venueClient(refusing(new ApiError('http', 'HTTP 404', { status: 404 })));

    const error = (await client.onboarding.get(ID).catch((cause: unknown) => cause)) as Error;
    expect(errorCode(error)).toBe('NOT_FOUND');
    expect(error.message).toBe('The venue reported an error (HTTP 404).');
  });
});

describe('a failure with no rule to name', () => {
  it.each([
    ['authentication', 'Your session has no access token. Sign in again.'],
    ['network', 'The venue could not be reached.'],
    ['response', 'The venue sent a reply this app could not read.'],
  ] as const)('explains a %s failure in its own words', async (kind, message) => {
    const client = venueClient(refusing(new ApiError(kind, 'internal wording')));

    const error = (await client.me().catch((cause: unknown) => cause)) as Error;
    expect(error.message).toBe(message);
    expect(errorCode(error)).toBeUndefined();
  });

  it('tells an operator whose session expired what to do about it', async () => {
    const client = venueClient(refusing(new ApiError('http', 'HTTP 401', { status: 401 })));

    const error = (await client.admin.listOnboardings().catch((cause: unknown) => cause)) as Error;
    expect(error.message).toBe('Your session is no longer valid. Sign in again.');
  });

  it('keeps an unmapped status in the message a reader sees', async () => {
    const client = venueClient(
      refusing(
        new ApiError('http', 'HTTP 500', {
          status: 500,
          problem: { status: 500, detail: 'The request could not be completed' },
        }),
      ),
    );

    const error = (await client.me().catch((cause: unknown) => cause)) as Error;
    expect(error.message).toBe('The request could not be completed (HTTP 500)');
    expect(errorCode(error)).toBeUndefined();
  });

  it('keeps the SDK error as the cause, so its kind and status survive a log', async () => {
    const sdkError = new ApiError('http', 'HTTP 409', { status: 409 });
    const client = venueClient(refusing(sdkError));

    const error = (await client.pools.list().catch((cause: unknown) => cause)) as Error;
    expect(error.cause).toBe(sdkError);
  });

  it('lets a cancellation through untouched, so it never reads as a failure', async () => {
    const abort = new DOMException('The operation was aborted', 'AbortError');
    const client = venueClient(refusing(abort));

    await expect(client.pools.list()).rejects.toBe(abort);
  });
});

describe('what the adapter forwards', () => {
  it('passes every argument and the abort signal straight through', async () => {
    const calls: unknown[][] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        calls.push([name, ...args]);
        return Promise.resolve(null);
      };
    const api = {
      me: record('me'),
      onboarding: {
        mine: record('mine'),
        submitApplication: record('submitApplication'),
        get: record('get'),
        prepareParty: record('prepareParty'),
        confirmParty: record('confirmParty'),
      },
      pools: { list: record('pools.list') },
      admin: {
        listOnboardings: record('listOnboardings'),
        reviewOnboarding: record('reviewOnboarding'),
      },
    } as unknown as ApiClient;
    const signal = new AbortController().signal;
    const client = venueClient(api);

    await client.me({ signal });
    await client.onboarding.mine({ signal });
    await client.onboarding.get(ID, { signal });
    await client.onboarding.prepareParty(ID, { publicKey: 'key' }, { signal });
    await client.onboarding.confirmParty(ID, { preparationId: 'p', signature: 's' }, { signal });
    await client.pools.list({ signal });
    await client.admin.listOnboardings({ signal });
    await client.admin.reviewOnboarding(
      ID,
      { decision: 'REJECTED', approvedPoolIds: [], partyHint: null },
      { signal },
    );

    expect(calls).toEqual([
      ['me', { signal }],
      ['mine', { signal }],
      ['get', ID, { signal }],
      ['prepareParty', ID, { publicKey: 'key' }, { signal }],
      ['confirmParty', ID, { preparationId: 'p', signature: 's' }, { signal }],
      ['pools.list', { signal }],
      ['listOnboardings', { signal }],
      [
        'reviewOnboarding',
        ID,
        { decision: 'REJECTED', approvedPoolIds: [], partyHint: null },
        { signal },
      ],
    ]);
  });

  it('exposes nothing the venue does not serve', () => {
    const client = venueClient(refusing(new Error('unused'))) as unknown as Record<string, unknown>;

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
    for (const absent of ['instruments', 'proposals', 'liquidity', 'treasury']) {
      expect(client[absent]).toBeUndefined();
    }
  });

  it('forwards the liquidity routes with their identifiers, inputs and signal', async () => {
    const calls: unknown[][] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        calls.push([name, ...args]);
        return Promise.resolve(null);
      };
    const client = venueClient({
      lp: {
        submitDeposit: record('submitDeposit'),
        prepareWithdrawalCancellation: record('prepareWithdrawalCancellation'),
        deposits: record('deposits'),
      },
    } as unknown as ApiClient);
    const signal = new AbortController().signal;

    await client.lp.submitDeposit({ preparationId: 'p', signature: 's' }, { signal });
    await client.lp.prepareWithdrawalCancellation(ID, { signal });
    await client.lp.deposits({ status: 'EXPIRED' }, { signal });

    expect(calls).toEqual([
      ['submitDeposit', { preparationId: 'p', signature: 's' }, { signal }],
      ['prepareWithdrawalCancellation', ID, { signal }],
      ['deposits', { status: 'EXPIRED' }, { signal }],
    ]);
  });

  it('forwards the previews, the hold, the history and one queue’s settings with every argument', async () => {
    const calls: unknown[][] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        calls.push([name, ...args]);
        return Promise.resolve(null);
      };
    const client = venueClient({
      admin: {
        settlements: {
          preview: record('preview'),
          previewRequest: record('previewRequest'),
          setDeferred: record('setDeferred'),
          history: record('history'),
          policy: record('policy'),
          updatePolicy: record('updatePolicy'),
        },
      },
    } as unknown as ApiClient);
    const signal = new AbortController().signal;
    const request = { type: 'withdraw', requestId: ID } as const;
    const settings = { automaticEnabled: true, batchSize: 3, expectedVersion: 2 };

    await client.admin.settlements.preview('pool', 'withdraw', 'batch-0001', { signal });
    await client.admin.settlements.previewRequest('pool', request, { signal });
    await client.admin.settlements.setDeferred('pool', request, false, { signal });
    await client.admin.settlements.history('pool', { status: 'REJECTED', before: 'cursor' }, { signal });
    await client.admin.settlements.policy('pool', 'deposit', { signal });
    await client.admin.settlements.updatePolicy('pool', 'deposit', settings, { signal });

    expect(calls).toEqual([
      ['preview', 'pool', 'withdraw', 'batch-0001', { signal }],
      ['previewRequest', 'pool', request, { signal }],
      ['setDeferred', 'pool', request, false, { signal }],
      ['history', 'pool', { status: 'REJECTED', before: 'cursor' }, { signal }],
      ['policy', 'pool', 'deposit', { signal }],
      ['updatePolicy', 'pool', 'deposit', settings, { signal }],
    ]);
  });
});
