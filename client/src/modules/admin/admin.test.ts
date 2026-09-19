import { describe, expect, it } from 'vitest';
import { createDexClient } from '../../client.js';
import { COMPLETED_ONBOARDING, NEW_ONBOARDING, jsonResponse, recordFetch } from '../../test-support.js';

const ID = '7f1c3d9e-0000-4000-8000-000000000007';

function clientWith(body: unknown, status = 200) {
  const recorder = recordFetch(() => jsonResponse(status, body));
  const client = createDexClient({
    baseUrl: 'https://venue.example.com',
    getAccessToken: () => 'token',
    fetchImpl: recorder.fetchImpl,
  });
  return { client, calls: recorder.calls };
}

describe('the operator queue', () => {
  it('reads every request as a bare array, not a paged envelope', async () => {
    const { client, calls } = clientWith([NEW_ONBOARDING, COMPLETED_ONBOARDING]);

    const list = await client.admin.listOnboardings();

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://venue.example.com/v1/admin/onboardings');
    expect(calls[0]?.body).toBeUndefined();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toEqual([NEW_ONBOARDING, COMPLETED_ONBOARDING]);
  });

  it('reads an empty queue as an empty array', async () => {
    const { client } = clientWith([]);
    await expect(client.admin.listOnboardings()).resolves.toEqual([]);
  });

  it('gives back complete records, not summaries', async () => {
    const { client } = clientWith([COMPLETED_ONBOARDING]);
    const [first] = await client.admin.listOnboardings();

    expect(first?.application.documentReferences).toEqual(
      COMPLETED_ONBOARDING.application.documentReferences,
    );
    expect(first?.ledgerSteps).toHaveLength(2);
  });
});

describe('an operator decision', () => {
  it('approves with the pools it was given', async () => {
    const { client, calls } = clientWith(COMPLETED_ONBOARDING);

    await client.admin.reviewOnboarding(ID, {
      decision: 'APPROVED',
      approvedPoolIds: ['pool-usdc-eurc', 'pool-tbill-usdc'],
      partyHint: 'sullivan_capital',
    });

    const sent = calls[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(`https://venue.example.com/v1/admin/onboardings/${ID}/review`);
    expect(JSON.parse(sent.body!)).toEqual({
      decision: 'APPROVED',
      approvedPoolIds: ['pool-usdc-eurc', 'pool-tbill-usdc'],
      partyHint: 'sullivan_capital',
    });
  });

  it('rejects with no pools and no hint, and sends no reviewer of its own', async () => {
    const { client, calls } = clientWith({ ...NEW_ONBOARDING, status: 'REJECTED' });

    await client.admin.reviewOnboarding(ID, {
      decision: 'REJECTED',
      approvedPoolIds: [],
      partyHint: null,
    });

    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(body).toEqual({ decision: 'REJECTED', approvedPoolIds: [], partyHint: null });
    expect(Object.keys(body)).not.toContain('reviewedBy');
    expect(Object.keys(body)).not.toContain('accountId');
  });

  it('returns the reviewed record with the operator the backend recorded', async () => {
    const { client } = clientWith(COMPLETED_ONBOARDING);

    const reviewed = await client.admin.reviewOnboarding(ID, {
      decision: 'APPROVED',
      approvedPoolIds: ['pool-usdc-eurc'],
      partyHint: 'sullivan_capital',
    });

    expect(reviewed.review).toEqual(COMPLETED_ONBOARDING.review);
  });

  it('reports a clashing second decision as the conflict it is', async () => {
    const { client, calls } = clientWith(
      { status: 409, detail: 'This request already has a different review' },
      409,
    );

    await expect(
      client.admin.reviewOnboarding(ID, {
        decision: 'REJECTED',
        approvedPoolIds: [],
        partyHint: null,
      }),
    ).rejects.toMatchObject({ kind: 'http', status: 409 });
    expect(calls).toHaveLength(1);
  });

  it('reports an unknown pool as the bad request it is', async () => {
    const { client } = clientWith({ status: 400, detail: 'Invalid request fields or request body' }, 400);

    await expect(
      client.admin.reviewOnboarding(ID, {
        decision: 'APPROVED',
        approvedPoolIds: ['nope'],
        partyHint: 'acme_trading',
      }),
    ).rejects.toMatchObject({ kind: 'http', status: 400 });
  });

  it('reports a trader token as the forbidden answer the backend gives', async () => {
    const { client } = clientWith(
      { status: 403, detail: 'This account cannot perform that operation' },
      403,
    );

    await expect(client.admin.listOnboardings()).rejects.toMatchObject({
      kind: 'http',
      status: 403,
    });
  });
});

describe('the party hint an operator settles on', () => {
  it('carries the edited hint, not the one the venue suggested', async () => {
    const { client, calls } = clientWith(COMPLETED_ONBOARDING);

    await client.admin.reviewOnboarding(ID, {
      decision: 'APPROVED',
      approvedPoolIds: ['pool-usdc-eurc'],
      partyHint: 'edited_by_operator',
    });

    expect((JSON.parse(calls[0]!.body!) as { partyHint: string }).partyHint).toBe(
      'edited_by_operator',
    );
    expect(NEW_ONBOARDING.suggestedPartyHint).not.toBe('edited_by_operator');
  });

  it('reports a malformed hint as the bad request the venue answers', async () => {
    const { client } = clientWith({ status: 400, detail: 'Invalid request fields or request body' }, 400);

    await expect(
      client.admin.reviewOnboarding(ID, {
        decision: 'APPROVED',
        approvedPoolIds: ['pool-usdc-eurc'],
        partyHint: 'Not A Hint',
      }),
    ).rejects.toMatchObject({ kind: 'http', status: 400 });
  });
});
