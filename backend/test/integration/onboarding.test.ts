import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ed25519KeyPair, publicKey, signParty, withBackend } from './support/backend.js';
import { at, items, text } from '../support/json.js';
import { completedOnboarding } from './support/onboarding-ledger.js';
import { RegistrationAuthority } from './support/registration-authority.js';
import { scenario } from './support/scenario.js';

describe.runIf(scenario('onboarding'))('onboarding', () => {
  it('answers an existing party with a conflict and never binds or issues contracts', () =>
    withBackend(async (test) => {
      const authority = new RegistrationAuthority(test.fixtures.http);
      const token = await test.token(await test.trader('existing-party'));
      const created = await test.create(token);
      const id = text(created, 'id');
      const path = `/v1/onboardings/${id}`;
      await test.approve(id);
      const key = ed25519KeyPair();
      const key64 = { publicKey: publicKey(key) };
      const prepared = await test.request('POST', `${path}/party/prepare`, token, key64, 200);
      const submission = signParty(key, at(prepared, 'party'));
      // Register through another user first: the local quota permits one allocation per user.
      const existingOwnerToken = await test.token(await test.trader('existing-party-owner'));
      const existingOwner = await test.create(existingOwnerToken);
      await test.approve(text(existingOwner, 'id'));
      const subject = await test.subject(text(existingOwner, 'accountId'));
      await authority.allocateBeforeBackendSubmission(
        existingOwnerToken,
        subject,
        at(prepared, 'party'),
        submission.signature,
      );
      const error = await test.request('POST', `${path}/party/submit`, token, submission, 409);
      expect(at(error, 'code')).toBe('PARTY_ALREADY_EXISTS');
      expect(at(error, 'detail')).toBe('This party already exists. Registration was stopped.');
      const conflict = await test.request('GET', '/v1/onboardings/mine', token, undefined, 200);
      expect(at(conflict, 'status')).toBe('PARTY_CONFLICT');
      expect(at(conflict, 'party', 'status')).toBe('CONFLICT');
      expect(at(conflict, 'party', 'confirmed')).toBe(false);
      expect(items(conflict, 'ledgerSteps')).toEqual([]);
      await test.request('POST', `${path}/party/prepare`, token, key64, 409);
      await test.request('POST', `${path}/party/submit`, token, submission, 409);
      expect(await test.request('GET', path, token, undefined, 200)).toEqual(conflict);
      expect(at(await test.request('GET', '/v1/me', token, undefined, 200), 'partyId')).toBeNull();
    }));

  it('registers an approved new external party with a valid signature and a confirmed ledger receipt', () =>
    withBackend(async (test) => {
      const authority = new RegistrationAuthority(test.fixtures.http);
      const name = await test.trader('david');
      const token = await test.token(name);
      const created = await test.create(token);
      const id = text(created, 'id');
      const path = `/v1/onboardings/${id}`;
      const key = ed25519KeyPair();
      const key64 = { publicKey: publicKey(key) };
      await test.request('POST', `${path}/party/prepare`, token, key64, 409);
      const review = { decision: 'APPROVED', approvedPoolIds: [await test.poolId()], partyHint: 'dex_david_test' };
      const reviewPath = `/v1/admin/onboardings/${id}/review`;
      const operator = await test.token('operator');
      await authority.browserOperatorScope(operator);
      await test.request('POST', reviewPath, token, review, 403);
      await test.request('POST', reviewPath, operator, { ...review, approvedPoolIds: ['fake-pool'] }, 400);
      await test.request('POST', reviewPath, operator, { ...review, partyHint: 'bad name' }, 400);
      await test.approve(id);
      const subject = await test.subject(text(created, 'accountId'));
      await authority.ordinaryUser(token, subject, null);
      const prep = await test.request('POST', `${path}/party/prepare`, token, key64, 200);
      expect(text(prep, 'party', 'partyId').startsWith('dex_david_test::')).toBe(true);
      expect(await test.request('POST', `${path}/party/prepare`, token, key64, 200)).toEqual(prep);
      await test.request('POST', `${path}/party/prepare`, token, { publicKey: publicKey(ed25519KeyPair()) }, 409);
      await test.request('POST', `${path}/party/submit`, token, signParty(ed25519KeyPair(), at(prep, 'party')), 400);
      await test.request(
        'POST',
        `${path}/party/submit`,
        token,
        { preparationId: randomUUID(), signature: Buffer.alloc(64).toString('base64') },
        409,
      );
      const prepared = at(prep, 'party');
      if (typeof prepared !== 'object' || prepared === null) throw new Error('No prepared party');
      const altered = { ...prepared, multiHash: Buffer.alloc(32).toString('base64') };
      await test.request('POST', `${path}/party/submit`, token, signParty(key, altered), 400);
      const submission = signParty(key, at(prep, 'party'));
      const foreignToken = await test.token(await test.trader('foreign-registration'));
      const foreign = await test.create(foreignToken);
      await test.approve(text(foreign, 'id'));
      await authority.cannotAllocateForAnotherUser(foreignToken, subject, at(prep, 'party'), submission.signature);
      await test.request('POST', `${path}/party/submit`, foreignToken, submission, 404);
      await test.request('POST', `${path}/party/submit`, token, submission, 200);
      const completed = await test.completed(token);
      const party = text(completed, 'party', 'partyId');
      await authority.ordinaryUser(await test.token(name), subject, party);
      await authority.serviceOnlyActsAsVenue(await test.fixtures.operatorToken(), party);
      await authority.browserOperatorScope(await test.token('operator'));
      await completedOnboarding(test.fixtures, completed, [await test.poolId()]);
      expect(await test.request('POST', `${path}/party/submit`, token, submission, 200)).toEqual(completed);
      expect(await test.request('POST', reviewPath, operator, review, 200)).toEqual(completed);
      await test.request('POST', reviewPath, operator, { decision: 'REJECTED', approvedPoolIds: [] }, 409);
      expect(await test.request('GET', '/v1/onboardings/mine', await test.token(name), undefined, 200)).toEqual(
        completed,
      );
      expect(at(await test.request('GET', '/v1/me', token, undefined, 200), 'partyId')).toBe(party);
      await completedOnboarding(test.fixtures, completed, [await test.poolId()]);
    }));

  it('never registers or emits for a rejected new account', () =>
    withBackend(async (test) => {
      const name = await test.trader('rejected');
      const token = await test.token(name);
      const created = await test.create(token);
      const id = text(created, 'id');
      const result = await test.request(
        'POST',
        `/v1/admin/onboardings/${id}/review`,
        await test.token('operator'),
        { decision: 'REJECTED', approvedPoolIds: [] },
        200,
      );
      expect(at(result, 'status')).toBe('REJECTED');
      expect(at(result, 'party')).toBeNull();
      expect(items(result, 'ledgerSteps')).toEqual([]);
      await test.request(
        'POST',
        `/v1/onboardings/${id}/party/prepare`,
        token,
        { publicKey: publicKey(ed25519KeyPair()) },
        409,
      );
      expect(await test.request('GET', '/v1/onboardings/mine', await test.token(name), undefined, 200)).toEqual(result);
      const { count } = await test.fixtures.db
        .selectFrom('onboarding_steps')
        .select((row) => row.fn.countAll<bigint>().as('count'))
        .where('onboarding_id', '=', id)
        .executeTakeFirstOrThrow();
      expect(count).toBe(0n);
      expect(at(await test.request('GET', '/v1/me', token, undefined, 200), 'partyId')).toBeNull();
    }));
});
