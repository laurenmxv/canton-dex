import { createHash, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { publicKey, secp256k1KeyPair, withBackend, type KeyPair } from './support/backend.js';
import { at, text } from '../support/json.js';
import { completedOnboarding } from './support/onboarding-ledger.js';
import { RegistrationAuthority } from './support/registration-authority.js';
import { scenario } from './support/scenario.js';

/** The Snap's secp256k1 wire format: a DER ECDSA signature over SHA-256 of the given bytes. */
function snapSignature(key: KeyPair, party: unknown, hash: Buffer): { preparationId: string; signature: string } {
  return {
    preparationId: text(party, 'preparationId'),
    signature: sign('sha256', hash, { key: key.privateKey, dsaEncoding: 'der' }).toString('base64'),
  };
}

/** Exercises the Snap's secp256k1 wire format against the local participant, without a browser wallet. */
describe.runIf(scenario('onboarding'))('Snap onboarding', () => {
  it('registers a secp256k1 party as a trader and produces a confirmed receipt', () =>
    withBackend(async (test) => {
      const name = await test.trader('snap-david');
      const token = await test.token(name);
      const created = await test.create(token);
      const id = text(created, 'id');
      const path = `/v1/onboardings/${id}`;
      await test.approve(id);
      const key = secp256k1KeyPair();
      const input = { publicKey: publicKey(key) };
      const prepared = await test.request('POST', `${path}/party/prepare`, token, input, 200);
      const party = at(prepared, 'party');
      const hash = Buffer.from(text(party, 'multiHash'), 'base64');
      expect(hash).toHaveLength(34);
      expect([...hash.subarray(0, 2)]).toEqual([0x12, 0x20]);
      expect(await test.request('POST', `${path}/party/prepare`, token, input, 200)).toEqual(prepared);
      await test.request('POST', `${path}/party/prepare`, token, { publicKey: publicKey(secp256k1KeyPair()) }, 409);
      await test.request('POST', `${path}/party/submit`, token, snapSignature(secp256k1KeyPair(), party, hash), 400);
      await test.request(
        'POST',
        `${path}/party/submit`,
        token,
        snapSignature(key, party, createHash('sha256').update(hash).digest()),
        400,
      );
      const submission = snapSignature(key, party, hash);
      await test.request('POST', `${path}/party/submit`, token, submission, 200);
      const completed = await test.completed(token);
      expect(at(completed, 'party', 'publicKey')).toEqual(at(party, 'publicKey'));
      const subject = await test.subject(text(created, 'accountId'));
      const authority = new RegistrationAuthority(test.fixtures.http);
      const partyId = text(completed, 'party', 'partyId');
      await authority.ordinaryUser(await test.token(name), subject, partyId);
      await authority.serviceOnlyActsAsVenue(await test.fixtures.operatorToken(), partyId);
      await completedOnboarding(test.fixtures, completed, [await test.poolId()]);
      expect(await test.request('POST', `${path}/party/submit`, token, submission, 200)).toEqual(completed);
      expect(await test.request('GET', '/v1/onboardings/mine', await test.token(name), undefined, 200)).toEqual(
        completed,
      );
      await completedOnboarding(test.fixtures, completed, [await test.poolId()]);
    }));
});
