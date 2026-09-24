import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ed25519KeyPair, publicKey, withBackend } from './support/backend.js';
import { at, findValues, text } from '../support/json.js';
import { scenario } from './support/scenario.js';

describe.runIf(scenario('iam'))('IAM', () => {
  it('provisions exactly one trader on concurrent first requests and isolates owners', () =>
    withBackend(async (test) => {
      const alice = await test.trader('iam');
      const bob = await test.trader('foreign');
      const token = await test.token(alice);
      const profiles = await Promise.all(
        Array.from({ length: 24 }, () => test.request('GET', '/v1/me', token, undefined, 200)),
      );
      const ids = new Set(profiles.map((profile) => text(profile, 'accountId')));
      for (const profile of profiles) {
        expect(at(profile, 'role')).toBe('TRADER');
        expect(at(profile, 'partyId')).toBeNull();
      }
      expect(ids.size).toBe(1);
      expect(await test.request('GET', '/v1/onboardings/mine', token, undefined, 200)).toBeNull();
      const onboarding = await test.create(token);
      const path = `/v1/onboardings/${text(onboarding, 'id')}`;
      expect(at(onboarding, 'partyMode')).toBe('external');
      expect(await test.request('GET', '/v1/onboardings/mine', await test.token(alice), undefined, 200)).toEqual(
        onboarding,
      );
      const account = await test.fixtures.db
        .selectFrom('accounts')
        .selectAll()
        .where('id', '=', [...ids][0] ?? '')
        .executeTakeFirstOrThrow();
      expect(account.role).toBe('TRADER');
      expect(account.party_id).toBeNull();
      const stored = await test.fixtures.db
        .selectFrom('onboardings')
        .select('application')
        .where('id', '=', text(onboarding, 'id'))
        .executeTakeFirstOrThrow();
      expect(JSON.parse(stored.application)).toEqual(at(onboarding, 'application'));
      const queue = await test.request('GET', '/v1/admin/onboardings', await test.token('operator'), undefined, 200);
      expect(findValues(queue, 'id')).toContain(text(onboarding, 'id'));
      await test.request('GET', path, undefined, undefined, 401);
      await test.request('GET', '/v1/me', 'invalid', undefined, 401);
      await test.request('GET', '/v1/admin/onboardings', token, undefined, 403);
      const foreign = await test.token(bob);
      await test.request('GET', path, foreign, undefined, 404);
      await test.request('POST', `${path}/party/prepare`, foreign, { publicKey: publicKey(ed25519KeyPair()) }, 404);
      await test.request(
        'POST',
        `${path}/party/submit`,
        foreign,
        { preparationId: randomUUID(), signature: Buffer.alloc(64).toString('base64') },
        404,
      );
      expect(await test.request('GET', '/v1/onboardings/mine', foreign, undefined, 200)).toBeNull();
      await test.request('POST', '/v1/onboardings', foreign, { legalName: '' }, 400);
      await test.request('POST', '/v1/onboardings', token, at(onboarding, 'application'), 409);
      console.log('PASS IAM: concurrent provisioning, persisted documents, fresh login and owner isolation.');
    }));

  it('requires simulated document metadata with integer sizes', () =>
    withBackend(async (test) => {
      const token = await test.token(await test.trader('documents'));
      const document: Record<string, unknown> = {
        id: randomUUID(),
        category: 'IDENTITY',
        fileName: 'test.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 1,
        simulated: false,
      };
      const request = { legalName: 'David Fixture', countryCode: 'AR', documents: [document] };
      await test.request('POST', '/v1/onboardings', token, request, 400);
      document.simulated = true;
      document.sizeBytes = 1.5;
      await test.request('POST', '/v1/onboardings', token, request, 400);
      document.sizeBytes = 10485761;
      await test.request('POST', '/v1/onboardings', token, request, 400);
      expect(await test.request('GET', '/v1/onboardings/mine', token, undefined, 200)).toBeNull();
    }));
});
