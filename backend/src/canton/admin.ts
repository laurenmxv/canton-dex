import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { components } from './generated/ledger-api.js';
import { array, optionalString, record, repeated, string, type JsonRecord } from './decode.js';
import { alreadyExists } from './http.js';
import type { Ledger } from './ledger.js';

type Schemas = components['schemas'];
export type Right = Schemas['Right'];

const QUICK_TIMEOUT_MS = 10_000;
const USER_TIMEOUT_MS = 30_000;
const PARTY_TIMEOUT_MS = 60_000;
const DAR_TIMEOUT_MS = 120_000;
const PARTY_PAGE_SIZE = 100;
const API_AUDIENCE = 'backend';
const IDENTITY_PROVIDER_ADMIN: Right = { kind: { IdentityProviderAdmin: { value: {} } } };

/** Development administration with the participant administrator. Never used by the API. */
export class CantonAdmin {
  constructor(private readonly admin: Ledger) {}

  /** Creates a resource; false when it already exists. */
  private async created(path: string, body: unknown, timeoutMs = QUICK_TIMEOUT_MS): Promise<boolean> {
    try {
      await this.admin.call('POST', path, timeoutMs, { body });
      return true;
    } catch (error) {
      if (!alreadyExists(error)) throw error;
      return false;
    }
  }

  async participantId(): Promise<string> {
    const response = record(
      await this.admin.call('GET', '/v2/parties/participant-id', QUICK_TIMEOUT_MS),
      'participant',
    );
    return string(response.participantId, 'participantId');
  }

  /**
   * The browser operator can provision ordinary users only within this identity provider. An
   * existing operator must have exactly that right; bootstrap never changes its rights.
   */
  async ensureBrowserOperator(
    id: string,
    issuer: string,
    jwksUrl: string,
    operatorSubject: string,
    operatorToken: string,
  ): Promise<void> {
    const desired = { identityProviderId: id, isDeactivated: false, issuer, jwksUrl, audience: API_AUDIENCE };
    const request: Schemas['CreateIdentityProviderConfigRequest'] = { identityProviderConfig: desired };
    if (!(await this.created('/v2/idps', request))) {
      const actual = record(
        record(await this.admin.call('GET', `/v2/idps/${encodeURIComponent(id)}`, QUICK_TIMEOUT_MS), 'idp')
          .identityProviderConfig,
        'identityProviderConfig',
      );
      const same =
        actual.identityProviderId === id &&
        (actual.isDeactivated ?? false) === false &&
        actual.issuer === issuer &&
        actual.jwksUrl === jwksUrl &&
        actual.audience === API_AUDIENCE;
      if (!same) throw new Error('Existing DEX identity provider differs from configuration');
    }
    const user: Schemas['CreateUserRequest'] = {
      user: { id: operatorSubject, identityProviderId: id },
      rights: [IDENTITY_PROVIDER_ADMIN],
    };
    await this.created('/v2/users', user);
    // The JSON Ledger API lists rights without an identity provider, so the operator, a user of
    // that provider, lists its own rights with its own token.
    const path = `/v2/users/${encodeURIComponent(operatorSubject)}/rights`;
    const response = record(await this.admin.forCaller(operatorToken).call('GET', path, QUICK_TIMEOUT_MS), 'rights');
    if (!isDeepStrictEqual(repeated(response.rights, 'rights', record), [IDENTITY_PROVIDER_ADMIN])) {
      throw new Error('Unexpected browser operator rights; inspect before changing them');
    }
  }

  /** The local party with this hint, allocated once. A party hosted elsewhere is not reused. */
  async ensureParty(hint: string): Promise<string> {
    const prefix = `${hint}::`;
    let pageToken = '';
    do {
      const response = record(
        await this.admin.call('GET', '/v2/parties', PARTY_TIMEOUT_MS, {
          query: { 'filter-party': prefix, pageSize: PARTY_PAGE_SIZE, pageToken: pageToken || undefined },
        }),
        'known parties',
      );
      const local = array(response.partyDetails, 'partyDetails', record).find(
        (party) => party.isLocal === true && typeof party.party === 'string' && party.party.startsWith(prefix),
      );
      if (local) return string(local.party, 'party');
      pageToken = optionalString(response.nextPageToken, 'nextPageToken') ?? '';
    } while (pageToken !== '');
    const allocated = record(
      await this.admin.call('POST', '/v2/parties', PARTY_TIMEOUT_MS, { body: { partyIdHint: hint } }),
      'allocated party',
    );
    return string(record(allocated.partyDetails, 'partyDetails').party, 'party');
  }

  async ensureUser(userId: string, party: string, readers: readonly string[]): Promise<void> {
    const rights: Right[] = [
      { kind: { CanActAs: { value: { party } } } },
      ...readers.map((reader): Right => ({ kind: { CanReadAs: { value: { party: reader } } } })),
    ];
    const create: Schemas['CreateUserRequest'] = { user: { id: userId, primaryParty: party }, rights };
    if (!(await this.created('/v2/users', create, USER_TIMEOUT_MS))) {
      const path = `/v2/users/${encodeURIComponent(userId)}`;
      await this.admin.call('PATCH', path, USER_TIMEOUT_MS, {
        body: { user: { id: userId, primaryParty: party }, updateMask: { paths: ['primary_party'] } },
      });
      await this.admin.call('POST', `${path}/rights`, USER_TIMEOUT_MS, { body: { userId, rights } });
    }
  }

  async uploadAndVet(darPath: string): Promise<void> {
    await this.admin.call('POST', '/v2/dars', DAR_TIMEOUT_MS, {
      query: { vetAllPackages: true },
      body: new Uint8Array(await readFile(darPath)),
    });
  }

  async rights(userId: string): Promise<JsonRecord[]> {
    const response = record(
      await this.admin.call('GET', `/v2/users/${encodeURIComponent(userId)}/rights`, QUICK_TIMEOUT_MS),
      'rights',
    );
    return repeated(response.rights, 'rights', record);
  }
}
