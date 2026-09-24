import type { ServiceIdentity } from '../platform/config.js';

const REQUEST_TIMEOUT_MS = 10_000;
const LEDGER_REALM = 'AppProvider';
const USER_REALM = 'Dex';
/** The user realm's public direct-grant client, with the API audience. */
const DIRECT_GRANT_CLIENT = 'backend-tests';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`Keycloak response has no ${what}`);
  return value;
}

/** The client secret of a fixture actor's ledger identity in the development realm. */
export function fixtureClientSecret(name: string): string {
  return `local-fixture-${name}`;
}

/** Service identities and realm settings in the isolated development Keycloak. */
export class KeycloakFixtures {
  constructor(
    private readonly baseUrl: URL,
    private readonly username: string,
    private readonly password: string,
  ) {}

  private async adminToken(): Promise<string> {
    const response = await fetch(new URL('/realms/master/protocol/openid-connect/token', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'admin-cli',
        grant_type: 'password',
        username: this.username,
        password: this.password,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 200)
      throw new Error(`Keycloak admin token request returned HTTP ${String(response.status)}`);
    return text(field(await response.json(), 'access_token'), 'access token');
  }

  private async request(method: string, path: string, body: unknown, expected: number): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: { authorization: `Bearer ${await this.adminToken()}`, 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== expected) {
      throw new Error(
        `Keycloak fixture request ${method} ${new URL(path, this.baseUrl).pathname} returned HTTP ${String(response.status)}`,
      );
    }
    const payload = await response.text();
    const parsed: unknown = payload.trim() === '' ? null : JSON.parse(payload);
    return parsed;
  }

  /** The client-credentials identity of one fixture actor, created or refreshed idempotently. */
  async ledgerIdentity(name: string): Promise<ServiceIdentity> {
    const clientId = `dex-fixture-${name}`;
    const clientSecret = fixtureClientSecret(name);
    const client = {
      clientId,
      enabled: true,
      secret: clientSecret,
      publicClient: false,
      clientAuthenticatorType: 'client-secret',
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      protocol: 'openid-connect',
      defaultClientScopes: ['audience_canton_network', 'basic'],
    };
    const lookup = `/admin/realms/${LEDGER_REALM}/clients?clientId=${encodeURIComponent(clientId)}`;
    let existing = await this.request('GET', lookup, undefined, 200);
    if (!Array.isArray(existing) || existing.length === 0) {
      await this.request('POST', `/admin/realms/${LEDGER_REALM}/clients`, client, 201);
      existing = await this.request('GET', lookup, undefined, 200);
    }
    const id = text(field(Array.isArray(existing) ? existing[0] : undefined, 'id'), 'client id');
    await this.request('PUT', `/admin/realms/${LEDGER_REALM}/clients/${id}`, client, 204);
    const user = await this.request(
      'GET',
      `/admin/realms/${LEDGER_REALM}/clients/${id}/service-account-user`,
      undefined,
      200,
    );
    return { userId: text(field(user, 'id'), 'service account user'), clientId, clientSecret };
  }

  /** A user's own access token in the user realm. */
  async userToken(username: string, password: string): Promise<string> {
    const response = await fetch(new URL(`/realms/${USER_REALM}/protocol/openid-connect/token`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DIRECT_GRANT_CLIENT, grant_type: 'password', username, password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 200)
      throw new Error(`Keycloak user token request returned HTTP ${String(response.status)}`);
    return text(field(await response.json(), 'access_token'), 'access token');
  }

  /** Lets traders create their own Keycloak accounts. */
  async enableRegistration(): Promise<void> {
    const realm = await this.request('GET', `/admin/realms/${USER_REALM}`, undefined, 200);
    if (!isRecord(realm)) throw new Error('Keycloak realm response is not an object');
    await this.request('PUT', `/admin/realms/${USER_REALM}`, { ...realm, registrationAllowed: true }, 204);
  }
}
