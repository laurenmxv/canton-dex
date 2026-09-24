import type { FastifyBaseLogger } from 'fastify';
import type { Account } from '../iam/accounts.js';
import { PartyAlreadyExists, type PartyPreparation } from '../onboarding/model.js';
import type { ExternalParties, Preparation } from '../onboarding/ports.js';
import { algorithm } from '../onboarding/signatures.js';
import { AccessDenied, InvalidRequest } from '../platform/errors.js';
import { epochNanos } from '../platform/time.js';
import type { components } from './generated/ledger-api.js';
import { array, optionalString, record, repeated, string, strings } from './decode.js';
import { alreadyExists, GRPC, LedgerRejected, type LedgerHttp, type Query } from './http.js';
import { DEX_PACKAGE_ID } from './packages.js';

type Schemas = components['schemas'];

const QUICK_TIMEOUT_MS = 10_000;
const PARTY_TIMEOUT_MS = 60_000;
const PARTY_EXISTS_CODE = 'EXTERNAL_PARTY_ALREADY_EXISTS';
/** Canton 3.5 may wrap the conflict in INVALID_ARGUMENT, keeping only its cause text. */
const NESTED_PARTY_EXISTS = /\bEXTERNAL_PARTY_ALREADY_EXISTS\(\d+,[^)]*\):/s;
const PARTY_EXISTS_CAUSE =
  /^(?:(?:INVALID_ARGUMENT\(\d+,[^)]*\): )?The submitted request has invalid arguments: )?Party \S+ already exists on synchronizer \S+$/;

function base64(value: string): string {
  return Buffer.from(value, 'base64').toString('base64');
}

function partyAlreadyExists(failure: LedgerRejected): boolean {
  if (failure.code === PARTY_EXISTS_CODE) return true;
  return (
    (failure.grpcCode === GRPC.ALREADY_EXISTS || failure.grpcCode === GRPC.INVALID_ARGUMENT) &&
    (NESTED_PARTY_EXISTS.test(failure.reason) || PARTY_EXISTS_CAUSE.test(failure.reason))
  );
}

function authorizationRejected(failure: LedgerRejected): boolean {
  return (
    failure.status === 401 ||
    failure.status === 403 ||
    failure.grpcCode === GRPC.UNAUTHENTICATED ||
    failure.grpcCode === GRPC.PERMISSION_DENIED
  );
}

/**
 * External-party registration with the caller's own token. The backend has no registration
 * credentials: every call relays the validated caller token, and nothing is cached.
 */
export class CantonExternalParties implements ExternalParties {
  constructor(
    private readonly http: LedgerHttp,
    private readonly identityProviderId: string,
    private readonly issuer: string,
    private readonly log: Pick<FastifyBaseLogger, 'info'>,
  ) {}

  private call(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    timeoutMs: number,
    options: { query?: Query; body?: unknown } = {},
  ): Promise<unknown> {
    return this.http.call({ method, path, token, timeoutMs, ...options });
  }

  async enableUser(operator: Account, accessToken: string, account: Account): Promise<void> {
    if (operator.role !== 'OPERATOR') throw new AccessDenied('An operator enables users');
    if (operator.issuer !== this.issuer) throw new InvalidRequest('Unexpected operator issuer');
    if (account.role !== 'TRADER') throw new AccessDenied('Only traders register parties');
    if (account.issuer !== this.issuer) throw new InvalidRequest('Unexpected identity issuer');
    const request: Schemas['CreateUserRequest'] = {
      user: { id: account.subject, identityProviderId: this.identityProviderId },
    };
    try {
      await this.call(accessToken, 'POST', '/v2/users', QUICK_TIMEOUT_MS, { body: request });
    } catch (error) {
      if (!alreadyExists(error)) throw error;
      await this.call(accessToken, 'GET', `/v2/users/${encodeURIComponent(account.subject)}`, QUICK_TIMEOUT_MS, {
        query: { 'identity-provider-id': this.identityProviderId },
      });
    }
  }

  async prepare(
    accessToken: string,
    hint: string,
    publicKey: string,
    synchronizer: string,
    participantId: string,
  ): Promise<Preparation> {
    const secp256k1 = algorithm(publicKey) === 'SECP256K1';
    const request: Schemas['GenerateExternalPartyTopologyRequest'] = {
      synchronizer,
      partyHint: hint,
      publicKey: {
        format: 'CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO',
        keyData: base64(publicKey),
        keySpec: secp256k1 ? 'SIGNING_KEY_SPEC_EC_SECP256K1' : 'SIGNING_KEY_SPEC_EC_CURVE25519',
      },
    };
    const response = record(
      await this.call(accessToken, 'POST', '/v2/parties/external/generate-topology', PARTY_TIMEOUT_MS, {
        body: request,
      }),
      'generated topology',
    );
    const partyId = string(response.partyId, 'partyId');
    const fingerprint = string(response.publicKeyFingerprint, 'publicKeyFingerprint');
    const multiHash = optionalString(response.multiHash, 'multiHash') ?? '';
    const transactions = strings(response.topologyTransactions, 'topologyTransactions');
    if (transactions.length === 0 || multiHash === '' || partyId !== `${hint}::${fingerprint}`) {
      throw new Error('Invalid generated external topology');
    }
    return {
      partyId,
      fingerprint,
      multiHash: base64(multiHash),
      transactions: transactions.map(base64),
      participantId,
    };
  }

  async allocate(
    caller: Account,
    accessToken: string,
    party: PartyPreparation,
    transactions: readonly string[],
    signature: string,
  ): Promise<void> {
    if (caller.role !== 'TRADER') throw new AccessDenied('Only traders register parties');
    if (caller.issuer !== this.issuer) throw new InvalidRequest('Unexpected identity issuer');
    const secp256k1 = algorithm(party.publicKey) === 'SECP256K1';
    const request: Schemas['AllocateExternalPartyRequest'] = {
      synchronizer: party.synchronizerId,
      onboardingTransactions: transactions.map((transaction) => ({ transaction })),
      multiHashSignatures: [
        {
          format: secp256k1 ? 'SIGNATURE_FORMAT_DER' : 'SIGNATURE_FORMAT_CONCAT',
          signature,
          signedBy: party.publicKeyFingerprint,
          signingAlgorithmSpec: secp256k1 ? 'SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256' : 'SIGNING_ALGORITHM_SPEC_ED25519',
        },
      ],
      identityProviderId: this.identityProviderId,
      waitForAllocation: true,
      userId: caller.subject,
    };
    let allocated: string;
    try {
      const response = record(
        await this.call(accessToken, 'POST', '/v2/parties/external/allocate', PARTY_TIMEOUT_MS, { body: request }),
        'allocated party',
      );
      allocated = string(response.partyId, 'partyId');
    } catch (error) {
      if (error instanceof LedgerRejected && authorizationRejected(error)) {
        throw new AccessDenied('User registration authorization was rejected', { cause: error });
      }
      if (error instanceof LedgerRejected && partyAlreadyExists(error)) {
        this.log.info({ party: party.partyId, code: error.code }, 'External party allocation conflict');
        throw new PartyAlreadyExists();
      }
      throw error;
    }
    if (allocated !== party.partyId) throw new Error('Allocated party differs from the signed preparation');
  }

  /**
   * The party is usable once this participant hosts it locally with confirmation rights on the
   * prepared synchronizer, and the DEX package is uploaded and vetted there now.
   */
  async confirmed(accessToken: string, party: PartyPreparation): Promise<boolean> {
    const participant = string(
      record(await this.call(accessToken, 'GET', '/v2/parties/participant-id', PARTY_TIMEOUT_MS), 'participant')
        .participantId,
      'participantId',
    );
    if (participant !== party.participantId) return false;
    const details = record(
      await this.call(accessToken, 'GET', `/v2/parties/${encodeURIComponent(party.partyId)}`, PARTY_TIMEOUT_MS, {
        query: { 'identity-provider-id': this.identityProviderId },
      }),
      'parties',
    );
    const local = array(details.partyDetails, 'partyDetails', record).some(
      (item) => item.party === party.partyId && item.isLocal === true,
    );
    if (!local) return false;
    const hosts = record(
      await this.call(accessToken, 'GET', '/v2/state/connected-synchronizers', QUICK_TIMEOUT_MS, {
        query: { party: party.partyId, identityProviderId: this.identityProviderId },
      }),
      'connected synchronizers',
    );
    const confirming = repeated(hosts.connectedSynchronizers, 'connectedSynchronizers', record).some(
      (host) =>
        host.synchronizerId === party.synchronizerId && host.permission === 'PARTICIPANT_PERMISSION_CONFIRMATION',
    );
    if (!confirming) return false;
    const status = record(
      await this.call(accessToken, 'GET', `/v2/packages/${DEX_PACKAGE_ID}/status`, QUICK_TIMEOUT_MS),
      'package status',
    );
    if (status.packageStatus !== 'PACKAGE_STATUS_REGISTERED') return false;
    return this.vettedNow(accessToken, participant, party.synchronizerId);
  }

  private async vettedNow(accessToken: string, participant: string, synchronizer: string): Promise<boolean> {
    const request: Schemas['ListVettedPackagesRequest'] = {
      packageMetadataFilter: { packageIds: [DEX_PACKAGE_ID] },
      topologyStateFilter: { participantIds: [participant], synchronizerIds: [synchronizer] },
    };
    const vetted = record(
      await this.call(accessToken, 'POST', '/v2/package-vetting/list', QUICK_TIMEOUT_MS, { body: request }),
      'vetted packages',
    );
    const now = BigInt(Date.now()) * 1_000_000n;
    return repeated(vetted.vettedPackages, 'vettedPackages', record)
      .filter((entry) => entry.participantId === participant && entry.synchronizerId === synchronizer)
      .flatMap((entry) => repeated(entry.packages, 'packages', record))
      .some((item) => {
        const from = optionalString(item.validFromInclusive, 'validFromInclusive');
        const until = optionalString(item.validUntilExclusive, 'validUntilExclusive');
        return (
          item.packageId === DEX_PACKAGE_ID &&
          (from === undefined || now >= epochNanos(from)) &&
          (until === undefined || now < epochNanos(until))
        );
      });
  }
}
