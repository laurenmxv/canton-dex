import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CantonExternalParties } from '../../../src/canton/external-parties.js';
import { LedgerHttp, LedgerRejected } from '../../../src/canton/http.js';
import type { Account } from '../../../src/iam/accounts.js';
import { PartyAlreadyExists, type PartyPreparation } from '../../../src/onboarding/model.js';
import { InvalidRequest, LedgerUnavailable } from '../../../src/platform/errors.js';
import { at } from '../../support/json.js';
import { cantonError, fakeParticipant, type Answer, type FakeParticipant } from '../support/participant.js';

const SILENT = { info: () => undefined };

describe('caller registration', () => {
  let participant: FakeParticipant | undefined;
  afterEach(async () => {
    await participant?.close();
    participant = undefined;
  });

  it('relays each caller token and never uses provisioner credentials', async () => {
    let failure: Answer | undefined;
    participant = await fakeParticipant({
      'POST /v2/parties/external/allocate': () => failure ?? { body: { partyId: 'david::key' } },
    });
    // There is no token endpoint: allocating must only use the supplied bearer.
    const parties = new CantonExternalParties(
      new LedgerHttp(participant.url),
      'dex-users',
      'https://identity.test',
      SILENT,
    );
    const caller: Account = {
      id: randomUUID(),
      issuer: 'https://identity.test',
      subject: 'david-user',
      displayName: 'David',
      role: 'TRADER',
    };
    const party: PartyPreparation = {
      preparationId: randomUUID(),
      partyId: 'david::key',
      confirmed: false,
      publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      publicKeyFingerprint: 'fingerprint',
      multiHash: 'hash',
      synchronizerId: 'synchronizer',
      status: 'PREPARED',
      participantId: 'participant',
      topologyTransactions: ['AQID'],
    };
    await parties.allocate(caller, 'first-token', party, party.topologyTransactions, 'AA==');
    await parties.allocate(caller, 'fresh-token', party, party.topologyTransactions, 'AA==');
    expect(participant.exchanges.map((exchange) => exchange.authorization)).toEqual([
      'Bearer first-token',
      'Bearer fresh-token',
    ]);
    for (const exchange of participant.exchanges) {
      expect(at(exchange.body, 'userId')).toBe(caller.subject);
      expect(at(exchange.body, 'identityProviderId')).toBe('dex-users');
      const transaction = at(exchange.body, 'onboardingTransactions', 0, 'transaction');
      expect([...Buffer.from(String(transaction), 'base64')]).toEqual([1, 2, 3]);
      expect(at(exchange.body, 'waitForAllocation')).toBe(true);
    }
    await expect(
      parties.allocate(
        { ...caller, issuer: 'https://foreign.test' },
        'foreign-token',
        party,
        party.topologyTransactions,
        'AA==',
      ),
    ).rejects.toBeInstanceOf(InvalidRequest);
    expect(participant.exchanges).toHaveLength(2);
    for (const duplicate of [
      cantonError(409, 6, 'EXTERNAL_PARTY_ALREADY_EXISTS(10,test): Party already exists'),
      cantonError(
        400,
        3,
        'INVALID_ARGUMENT(8,test): EXTERNAL_PARTY_ALREADY_EXISTS(10,test): Party already exists',
        'INVALID_ARGUMENT',
      ),
      cantonError(
        400,
        3,
        'The submitted request has invalid arguments: Party dex_david_test::1220fa7429be... already exists on synchronizer global-domain::12202c7087a9...',
        'INVALID_ARGUMENT',
      ),
      cantonError(409, 6, 'Party already exists', 'EXTERNAL_PARTY_ALREADY_EXISTS'),
    ]) {
      failure = duplicate;
      await expect(parties.allocate(caller, 'token', party, party.topologyTransactions, 'AA==')).rejects.toBeInstanceOf(
        PartyAlreadyExists,
      );
    }
    for (const [other, grpcCode] of [
      [cantonError(409, 6, 'Another resource already exists'), 6],
      [cantonError(400, 3, 'Invalid topology', 'INVALID_ARGUMENT'), 3],
    ] as const) {
      failure = other;
      const error = await parties
        .allocate(caller, 'token', party, party.topologyTransactions, 'AA==')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LedgerRejected);
      expect(error instanceof LedgerRejected ? error.grpcCode : undefined).toBe(grpcCode);
    }
    for (const transient of [cantonError(503, 14, 'Unavailable'), cantonError(504, 4, 'Deadline exceeded')]) {
      failure = transient;
      await expect(parties.allocate(caller, 'token', party, party.topologyTransactions, 'AA==')).rejects.toBeInstanceOf(
        LedgerUnavailable,
      );
    }
  });
});
