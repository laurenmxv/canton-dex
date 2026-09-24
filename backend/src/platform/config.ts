export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

/** A Ledger API user that authenticates with its own OAuth client credentials. */
export interface ServiceIdentity {
  readonly userId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface Config {
  readonly database: DatabaseConfig;
  readonly ledgerApiUrl: URL;
  readonly ledgerTokenUrl: URL;
  /** The operator identity; its primary party is the venue operator. */
  readonly operator: ServiceIdentity;
  readonly issuer: string;
  readonly jwkSetUri: URL;
  /** The Canton identity provider of self-registered traders. */
  readonly identityProviderId: string;
  /** Whether the development faucet routes exist. */
  readonly developmentTokens: boolean;
  /** The largest settlement batch that a family policy may configure. */
  readonly settlementMaxBatchSize: number;
}

export interface BootstrapConfig extends Config {
  readonly keycloakUrl: URL;
  readonly keycloakUsername: string;
  readonly keycloakPassword: string;
  /** The browser operator's password in the user realm, to read its own ledger rights. */
  readonly operatorPassword: string;
  /** The participant administrator used for DARs, parties, users and identity providers. */
  readonly administrator: ServiceIdentity;
  readonly darDirectory: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

function required(env: Environment, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new Error(`Missing required configuration ${name}`);
  return value;
}

function url(env: Environment, name: string): URL {
  const value = required(env, name);
  if (!URL.canParse(value)) throw new Error(`${name} must be a URL, not ${value}`);
  return new URL(value);
}

function port(env: Environment, name: string, fallback: number): number {
  const value = env[name] ?? String(fallback);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be a TCP port, not ${value}`);
  }
  return parsed;
}

/** The settlement batch limit: 10 by default, from 1 to 20. */
function settlementMaxBatchSize(env: Environment): number {
  const value = env.DEX_SETTLEMENTS_MAX_BATCH_SIZE ?? '10';
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < 1 || parsed > 20) {
    throw new Error(`DEX_SETTLEMENTS_MAX_BATCH_SIZE must be between 1 and 20, not ${value}`);
  }
  return parsed;
}

function identity(env: Environment, prefix: string): ServiceIdentity {
  return {
    userId: required(env, `${prefix}_USER_ID`),
    clientId: required(env, `${prefix}_CLIENT_ID`),
    clientSecret: required(env, `${prefix}_CLIENT_SECRET`),
  };
}

/** The database and ledger endpoints that the DVO decision command uses with its own identity. */
export type DecisionConfig = Pick<Config, 'database' | 'ledgerApiUrl' | 'ledgerTokenUrl'>;

export function loadDecisionConfig(env: Environment): DecisionConfig {
  return {
    database: {
      host: required(env, 'DEX_DATABASE_HOST'),
      port: port(env, 'DEX_DATABASE_PORT', 5432),
      database: required(env, 'DEX_DATABASE_NAME'),
      user: required(env, 'DEX_DATABASE_USER'),
      password: required(env, 'DEX_DATABASE_PASSWORD'),
    },
    ledgerApiUrl: url(env, 'DEX_LEDGER_API_URL'),
    ledgerTokenUrl: url(env, 'DEX_CANTON_TOKEN_URL'),
  };
}

export function loadConfig(env: Environment): Config {
  return {
    ...loadDecisionConfig(env),
    operator: identity(env, 'DEX_CANTON'),
    issuer: required(env, 'DEX_IAM_ISSUER'),
    jwkSetUri: url(env, 'DEX_IAM_JWK_SET_URI'),
    identityProviderId: required(env, 'DEX_REGISTRATION_IDENTITY_PROVIDER_ID'),
    developmentTokens: env.DEX_DEVELOPMENT_TOKENS_ENABLED?.toLowerCase() === 'true',
    settlementMaxBatchSize: settlementMaxBatchSize(env),
  };
}

export function loadBootstrapConfig(env: Environment): BootstrapConfig {
  return {
    ...loadConfig(env),
    keycloakUrl: url(env, 'DEX_BOOTSTRAP_KEYCLOAK_URL'),
    keycloakUsername: required(env, 'DEX_BOOTSTRAP_KEYCLOAK_USERNAME'),
    keycloakPassword: required(env, 'DEX_BOOTSTRAP_KEYCLOAK_PASSWORD'),
    operatorPassword: required(env, 'DEX_BOOTSTRAP_OPERATOR_PASSWORD'),
    administrator: identity(env, 'DEX_BOOTSTRAP_LEDGER'),
    darDirectory: required(env, 'DEX_DAR_DIRECTORY'),
  };
}
