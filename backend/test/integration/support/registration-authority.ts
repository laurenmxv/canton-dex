import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { LedgerRejected, type LedgerHttp } from '../../../src/canton/http.js';
import { at, items, text } from '../../support/json.js';

const TIMEOUT_MS = 10_000;
const ALLOCATION_TIMEOUT_MS = 60_000;
const IDENTITY_PROVIDER = 'dex-users';
const GRPC_PERMISSION_DENIED = 7;
const IDENTITY_PROVIDER_ADMIN = { kind: { IdentityProviderAdmin: { value: {} } } };

type Method = 'GET' | 'POST' | 'PATCH';

/** Caller rights, asserted through the caller's own token, never the fixture administrator. */
export class RegistrationAuthority {
  constructor(private readonly http: LedgerHttp) {}

  private call(
    token: string,
    method: Method,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<unknown> {
    return this.http.call({ method, path, token, timeoutMs: TIMEOUT_MS, body, ...(query ? { query } : {}) });
  }

  private async denied(action: Promise<unknown>): Promise<void> {
    const failure = await action.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LedgerRejected);
    expect(failure instanceof LedgerRejected ? failure.grpcCode : undefined).toBe(GRPC_PERMISSION_DENIED);
  }

  private async authenticatedUser(token: string, identityProvider?: string): Promise<unknown> {
    const query = identityProvider === undefined ? undefined : { 'identity-provider-id': identityProvider };
    return at(await this.call(token, 'GET', '/v2/authenticated-user', undefined, query), 'user');
  }

  /** The JSON API omits an empty rights list. */
  private async rights(token: string, userId: string): Promise<unknown[]> {
    const rights = at(await this.call(token, 'GET', `/v2/users/${encodeURIComponent(userId)}/rights`), 'rights');
    return rights === undefined ? [] : items(rights);
  }

  async browserOperatorScope(token: string): Promise<void> {
    const user = await this.authenticatedUser(token, IDENTITY_PROVIDER);
    expect(at(user, 'identityProviderId')).toBe(IDENTITY_PROVIDER);
    expect(await this.rights(token, text(user, 'id'))).toEqual([IDENTITY_PROVIDER_ADMIN]);
    await this.denied(
      this.call(token, 'POST', '/v2/users', {
        user: { id: `must-not-exist-${randomUUID()}`, identityProviderId: 'foreign-idp' },
      }),
    );
    // A missing target prevents any privilege mutation even if this authorization check regresses.
    const missing = `must-not-exist-${randomUUID()}`;
    await this.denied(
      this.call(token, 'POST', `/v2/users/${missing}/rights`, {
        userId: missing,
        identityProviderId: IDENTITY_PROVIDER,
        rights: [{ kind: { ParticipantAdmin: { value: {} } } }],
      }),
    );
    // Empty IDP fields normally infer the caller's IDP; reassignment names the source explicitly.
    const moved = `must-not-exist-${randomUUID()}`;
    await this.denied(
      this.call(token, 'PATCH', `/v2/users/${moved}/identity-provider-id`, {
        userId: moved,
        sourceIdentityProviderId: '',
        targetIdentityProviderId: IDENTITY_PROVIDER,
      }),
    );
  }

  async serviceOnlyActsAsVenue(serviceToken: string, davidParty: string): Promise<void> {
    const user = await this.authenticatedUser(serviceToken);
    expect(at(user, 'identityProviderId') ?? '').toBe('');
    const primaryParty = text(user, 'primaryParty');
    expect(primaryParty).not.toBe('');
    expect(primaryParty).not.toBe(davidParty);
    const rights = await this.rights(serviceToken, text(user, 'id'));
    // Existing development volumes may retain read-only governance access from older fixtures.
    expect(rights.filter((right) => at(right, 'kind', 'CanActAs') !== undefined)).toEqual([
      { kind: { CanActAs: { value: { party: primaryParty } } } },
    ]);
    expect(
      rights.some(
        (right) =>
          at(right, 'kind', 'ParticipantAdmin') !== undefined ||
          at(right, 'kind', 'IdentityProviderAdmin') !== undefined,
      ),
    ).toBe(false);
    expect(rights.some((right) => at(right, 'kind', 'CanReadAs', 'value', 'party') === davidParty)).toBe(false);
  }

  private allocation(ownerSubject: string, party: unknown, signature: string): unknown {
    return {
      userId: ownerSubject,
      identityProviderId: IDENTITY_PROVIDER,
      synchronizer: text(party, 'synchronizerId'),
      waitForAllocation: true,
      multiHashSignatures: [
        {
          format: 'SIGNATURE_FORMAT_CONCAT',
          signature,
          signedBy: text(party, 'publicKeyFingerprint'),
          signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519',
        },
      ],
      onboardingTransactions: items(party, 'topologyTransactions').map((transaction) => ({ transaction })),
    };
  }

  async cannotAllocateForAnotherUser(
    token: string,
    ownerSubject: string,
    party: unknown,
    signature: string,
  ): Promise<void> {
    await this.denied(
      this.call(token, 'POST', '/v2/parties/external/allocate', this.allocation(ownerSubject, party, signature)),
    );
  }

  async allocateBeforeBackendSubmission(
    token: string,
    ownerSubject: string,
    party: unknown,
    signature: string,
  ): Promise<void> {
    const response = await this.http.call({
      method: 'POST',
      path: '/v2/parties/external/allocate',
      token,
      timeoutMs: ALLOCATION_TIMEOUT_MS,
      body: this.allocation(ownerSubject, party, signature),
    });
    expect(at(response, 'partyId')).toBe(text(party, 'partyId'));
  }

  async ordinaryUser(token: string, subject: string, party: string | null): Promise<void> {
    const user = await this.authenticatedUser(token, IDENTITY_PROVIDER);
    expect(at(user, 'id')).toBe(subject);
    expect(at(user, 'identityProviderId')).toBe(IDENTITY_PROVIDER);
    const rights = await this.rights(token, subject);
    expect(rights).toEqual(party === null ? [] : [{ kind: { CanActAs: { value: { party } } } }]);
    await this.denied(
      this.call(token, 'POST', `/v2/users/${encodeURIComponent(subject)}/rights`, {
        userId: subject,
        identityProviderId: IDENTITY_PROVIDER,
        rights: [IDENTITY_PROVIDER_ADMIN],
      }),
    );
    await this.denied(
      this.call(token, 'POST', '/v2/users', {
        user: { id: `must-not-exist-${randomUUID()}`, identityProviderId: IDENTITY_PROVIDER },
      }),
    );
  }
}
