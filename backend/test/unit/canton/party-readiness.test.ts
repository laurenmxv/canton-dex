import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CantonExternalParties } from '../../../src/canton/external-parties.js';
import { LedgerHttp, LedgerRejected } from '../../../src/canton/http.js';
import { DEX_PACKAGE_ID } from '../../../src/canton/packages.js';
import type { PartyPreparation } from '../../../src/onboarding/model.js';
import { at } from '../../support/json.js';
import { cantonError, fakeParticipant, type FakeParticipant } from '../support/participant.js';

const PARTICIPANT = 'venue::participant';
const SYNCHRONIZER = 'local::synchronizer';
const PARTY = 'david::key';
const METHODS: Readonly<Record<string, string>> = {
  '/v2/parties/participant-id': 'GetParticipantId',
  [`/v2/parties/${encodeURIComponent(PARTY)}`]: 'GetParties',
  '/v2/state/connected-synchronizers': 'GetConnectedSynchronizers',
  [`/v2/packages/${DEX_PACKAGE_ID}/status`]: 'GetPackageStatus',
  '/v2/package-vetting/list': 'ListVettedPackages',
};

function vetting(pkg: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { participantId: PARTICIPANT, synchronizerId: SYNCHRONIZER, packages: [pkg], topologySerial: 1, ...overrides };
}

function preparation(): PartyPreparation {
  return {
    preparationId: randomUUID(),
    partyId: PARTY,
    confirmed: false,
    publicKey: 'key',
    publicKeyFingerprint: 'fingerprint',
    multiHash: 'hash',
    synchronizerId: SYNCHRONIZER,
    status: 'PREPARED',
    participantId: PARTICIPANT,
    topologyTransactions: ['AQID'],
  };
}

const iso = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1_000).toISOString();

describe('party readiness', () => {
  let participant: FakeParticipant;
  let parties: CantonExternalParties;
  let servingParticipant: string;
  let local: boolean;
  let denyPartyRead: boolean;
  let permission: string;
  let packageStatus: string;
  let vetted: Record<string, unknown>;

  beforeEach(async () => {
    servingParticipant = PARTICIPANT;
    local = true;
    denyPartyRead = false;
    permission = 'PARTICIPANT_PERMISSION_CONFIRMATION';
    packageStatus = 'PACKAGE_STATUS_REGISTERED';
    vetted = vetting({ packageId: DEX_PACKAGE_ID });
    participant = await fakeParticipant({
      'GET /v2/parties/participant-id': () => ({ body: { participantId: servingParticipant } }),
      [`GET /v2/parties/${encodeURIComponent(PARTY)}`]: (exchange) => {
        expect(exchange.query.get('identity-provider-id')).toBe('dex-users');
        if (denyPartyRead) return cantonError(403, 7, 'A security-sensitive error has been received');
        return { body: { partyDetails: [{ party: PARTY, isLocal: local }] } };
      },
      'GET /v2/state/connected-synchronizers': (exchange) => {
        expect(exchange.query.get('party')).toBe(PARTY);
        expect(exchange.query.get('identityProviderId')).toBe('dex-users');
        return {
          body: { connectedSynchronizers: [{ synchronizerAlias: 'local', synchronizerId: SYNCHRONIZER, permission }] },
        };
      },
      [`GET /v2/packages/${DEX_PACKAGE_ID}/status`]: () => ({ body: { packageStatus } }),
      'POST /v2/package-vetting/list': (exchange) => {
        expect(at(exchange.body, 'packageMetadataFilter', 'packageIds')).toEqual([DEX_PACKAGE_ID]);
        expect(at(exchange.body, 'topologyStateFilter', 'participantIds')).toEqual([PARTICIPANT]);
        expect(at(exchange.body, 'topologyStateFilter', 'synchronizerIds')).toEqual([SYNCHRONIZER]);
        return { body: { vettedPackages: [vetted] } };
      },
    });
    // No token endpoint exists: readiness must exclusively relay the supplied caller token.
    parties = new CantonExternalParties(new LedgerHttp(participant.url), 'dex-users', 'https://identity.test', {
      info: () => undefined,
    });
  });
  afterEach(() => participant.close());

  const methods = () => participant.exchanges.map((exchange) => METHODS[exchange.path]);
  const tokens = () => participant.exchanges.map((exchange) => exchange.authorization);

  it('uses a fresh caller token for every read of a confirmed party', async () => {
    expect(await parties.confirmed('first-token', preparation())).toBe(true);
    expect(await parties.confirmed('fresh-token', preparation())).toBe(true);
    expect(tokens()).toEqual([
      ...Array<string>(5).fill('Bearer first-token'),
      ...Array<string>(5).fill('Bearer fresh-token'),
    ]);
    const sequence = [
      'GetParticipantId',
      'GetParties',
      'GetConnectedSynchronizers',
      'GetPackageStatus',
      'ListVettedPackages',
    ];
    expect(methods()).toEqual([...sequence, ...sequence]);
  });

  it('never lets another serving participant confirm the preparation', async () => {
    servingParticipant = 'other::participant';
    expect(await parties.confirmed('david-token', preparation())).toBe(false);
    expect(methods()).toEqual(['GetParticipantId']);
  });

  it('requires the package to be uploaded even if it is vetted', async () => {
    packageStatus = 'PACKAGE_STATUS_UNSPECIFIED';
    expect(await parties.confirmed('david-token', preparation())).toBe(false);
    expect(methods()).not.toContain('ListVettedPackages');
  });

  it('requires vetting that is effective now', async () => {
    vetted = vetting({ packageId: DEX_PACKAGE_ID, validFromInclusive: iso(120) });
    expect(await parties.confirmed('david-token', preparation())).toBe(false);
    vetted = vetting({ packageId: DEX_PACKAGE_ID, validUntilExclusive: iso(-120) });
    expect(await parties.confirmed('david-token', preparation())).toBe(false);
    vetted = vetting({ packageId: DEX_PACKAGE_ID, validFromInclusive: iso(-120), validUntilExclusive: iso(120) });
    expect(await parties.confirmed('david-token', preparation())).toBe(true);
  });

  it('requires vetting of the exact participant, synchronizer and package', async () => {
    vetted = vetting({ packageId: DEX_PACKAGE_ID }, { participantId: 'other::participant' });
    expect(await parties.confirmed('david-token', preparation())).toBe(false);
    vetted = vetting({ packageId: DEX_PACKAGE_ID }, { synchronizerId: 'other::synchronizer' });
    expect(await parties.confirmed('david-token', preparation())).toBe(false);
    vetted = vetting({ packageId: 'another-package' });
    expect(await parties.confirmed('david-token', preparation())).toBe(false);
  });

  it('requires local confirmation hosting', async () => {
    local = false;
    expect(await parties.confirmed('david-token', preparation())).toBe(false);
    local = true;
    permission = 'PARTICIPANT_PERMISSION_SUBMISSION';
    expect(await parties.confirmed('david-token', preparation())).toBe(false);
    permission = 'PARTICIPANT_PERMISSION_OBSERVATION';
    expect(await parties.confirmed('david-token', preparation())).toBe(false);
  });

  it('never turns a denied caller read into a confirmation or uses another identity', async () => {
    denyPartyRead = true;
    const error = await parties.confirmed('david-token', preparation()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LedgerRejected);
    expect(error instanceof LedgerRejected ? error.grpcCode : undefined).toBe(7);
    expect(tokens()).toEqual(['Bearer david-token', 'Bearer david-token']);
  });
});
