import { CantonAdmin } from '../../../src/canton/admin.js';
import { ServiceCredentials } from '../../../src/canton/credentials.js';
import { LedgerHttp } from '../../../src/canton/http.js';
import { Ledger } from '../../../src/canton/ledger.js';
import { loadConfig, type Config, type ServiceIdentity } from '../../../src/platform/config.js';
import { createDatabase, type Db } from '../../../src/platform/database.js';

const REQUEST_TIMEOUT_MS = 10_000;
const DEX_REALM = 'Dex';
const DIRECT_GRANT_CLIENT = 'backend-tests';
const OPERATOR = 'operator';
const OPERATOR_PASSWORD = 'operator';
const TRADER_PASSWORD = 'test-password';

export function env(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing configuration: ${name}`);
  return value;
}

function accessToken(payload: unknown): string {
  const token =
    typeof payload === 'object' && payload !== null && 'access_token' in payload ? payload.access_token : undefined;
  if (typeof token !== 'string') throw new Error('Keycloak response has no access token');
  return token;
}

async function passwordToken(url: string, form: Record<string, string>): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error(`Token request returned HTTP ${String(response.status)}`);
  return accessToken(await response.json());
}

/**
 * The development environment of the integration scenarios: the application database, the
 * participant administrator, the operator identity and the test Keycloak realm.
 */
export class DevelopmentFixtures {
  readonly config: Config = loadConfig(process.env);
  readonly db: Db = createDatabase(this.config.database, (error) => {
    console.warn('Idle PostgreSQL connection failed', error);
  });
  readonly http = new LedgerHttp(this.config.ledgerApiUrl);
  readonly administrator: ServiceIdentity = {
    userId: env('DEX_BOOTSTRAP_LEDGER_USER_ID'),
    clientId: env('DEX_BOOTSTRAP_LEDGER_CLIENT_ID'),
    clientSecret: env('DEX_BOOTSTRAP_LEDGER_CLIENT_SECRET'),
  };
  readonly admin = new CantonAdmin(
    Ledger.service(this.http, new ServiceCredentials(this.config.ledgerTokenUrl, this.administrator)),
  );
  private readonly keycloakUrl = env('DEX_BOOTSTRAP_KEYCLOAK_URL').replace(/\/+$/, '');

  /** A fresh ledger connection with the operator's own service identity. */
  operatorLedger(): Ledger {
    return Ledger.service(this.http, new ServiceCredentials(this.config.ledgerTokenUrl, this.config.operator));
  }

  /** The operator's service token, for assertions through its own Ledger API rights. */
  operatorToken(): Promise<string> {
    return new ServiceCredentials(this.config.ledgerTokenUrl, this.config.operator).token();
  }

  private adminToken(): Promise<string> {
    return passwordToken(`${this.keycloakUrl}/realms/master/protocol/openid-connect/token`, {
      client_id: 'admin-cli',
      grant_type: 'password',
      username: env('DEX_BOOTSTRAP_KEYCLOAK_USERNAME'),
      password: env('DEX_BOOTSTRAP_KEYCLOAK_PASSWORD'),
    });
  }

  /** A trader in the Dex realm: an enabled user with a verified email and the fixture password. */
  async createTrader(name: string): Promise<void> {
    const response = await fetch(`${this.keycloakUrl}/admin/realms/${DEX_REALM}/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.adminToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: name,
        enabled: true,
        firstName: name,
        lastName: 'Fixture',
        email: `${name}@example.test`,
        emailVerified: true,
        credentials: [{ type: 'password', value: TRADER_PASSWORD, temporary: false }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 201) throw new Error(`Creating trader returned HTTP ${String(response.status)}`);
  }

  /** A Dex access token through the direct-grant test client. */
  userToken(name: string): Promise<string> {
    return passwordToken(`${this.keycloakUrl}/realms/${DEX_REALM}/protocol/openid-connect/token`, {
      client_id: DIRECT_GRANT_CLIENT,
      grant_type: 'password',
      username: name,
      password: name === OPERATOR ? OPERATOR_PASSWORD : TRADER_PASSWORD,
    });
  }

  keycloakDiscovery(): Promise<Response> {
    return fetch(`${this.keycloakUrl}/realms/${DEX_REALM}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}
