/**
 * Authenticates HTTP requests and resolves callers in Fastify's onRequest hook.
 *
 * @remarks
 * Verifies bearer tokens against the configured issuer. Application roles are stored in
 * PostgreSQL. Account helpers query it through the shared database client, without a separate
 * store. Fastify dispatches domain route handlers after this hook completes; IAM does not route
 * requests to the business modules.
 *
 * @packageDocumentation
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AccessDenied } from '../platform/errors.js';
import { FORBIDDEN, sendProblem, TOKEN_REQUIRED } from '../platform/problems.js';
import type { Account, Role } from './accounts.js';

/** The API audience of Keycloak access tokens. */
const AUDIENCE = 'backend';
/** The JWT clock skew for `exp` and `nbf`. */
const CLOCK_TOLERANCE_SECONDS = 60;
/** The bearer token syntax (RFC 6750 b64token), matched case-insensitively. */
const BEARER = /^bearer (?<token>[a-zA-Z0-9\-._~+/]+=*)$/i;
/** jose failures that mean the token itself is invalid; key-source failures are server errors. */
const INVALID_TOKEN_CODES = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
]);

/** The authenticated caller. The access token is request-scoped: never cached or persisted. */
export interface Caller {
  readonly account: Account;
  readonly accessToken: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller: Caller | null;
  }
}

export interface AuthenticationOptions {
  readonly issuer: string;
  readonly keys: JWTVerifyGetKey;
  readonly authenticate: (issuer: string, subject: string, name: string | undefined) => Promise<Account>;
}

type Access = 'permitAll' | 'authenticated' | Role | 'denyAll';

/** The path that routing matches: decoded, except for reserved characters such as `%2F`. */
function requestPath(url: string): string {
  const path = url.split('?')[0] ?? '';
  try {
    return decodeURI(path);
  } catch {
    // A malformed escape keeps its raw text, which no rule grants.
    return path;
  }
}

/** The access rule of a request path; the first rule that matches applies. */
function accessRule(path: string): Access {
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  if (under('/actuator/health')) return 'permitAll';
  if (
    path === '/v1/me' ||
    path === '/v1/pools' ||
    /^\/v1\/pools\/[^/]*$/.test(path) ||
    /^\/v1\/pools\/[^/]+\/market-data$/.test(path)
  ) {
    return 'authenticated';
  }
  if (under('/v1/admin')) return 'OPERATOR';
  if (under('/v1/onboardings')) return 'TRADER';
  if (['/v1/swaps', '/v1/lp', '/v1/dev/faucet'].some(under) || path === '/v1/activity' || path === '/v1/balances') {
    return 'TRADER';
  }
  return 'denyAll';
}

function isInvalidToken(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && typeof error.code === 'string' && INVALID_TOKEN_CODES.has(error.code)
  );
}

/**
 * The answer for a request that no route serves: 401 for an anonymous caller and 403 for an
 * authenticated one.
 */
export function deny(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return request.caller
    ? sendProblem(reply, { status: 403, detail: FORBIDDEN })
    : sendProblem(reply, { status: 401, detail: TOKEN_REQUIRED });
}

export function requireCaller(request: FastifyRequest): Caller {
  if (!request.caller) throw new AccessDenied('No authenticated caller');
  return request.caller;
}

/**
 * Authentication precedes authorization, which precedes body and path parsing. A bearer token
 * must pass the Keycloak signature, the exact issuer, the `backend` audience and `exp`/`nbf`
 * with 60 s tolerance. A valid token provisions or loads the account, whatever the path.
 */
export function registerAuthentication(app: FastifyInstance, options: AuthenticationOptions): void {
  async function verify(token: string): Promise<JWTPayload | undefined> {
    try {
      const { payload } = await jwtVerify(token, options.keys, {
        issuer: options.issuer,
        audience: AUDIENCE,
        algorithms: ['RS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      return payload;
    } catch (error) {
      if (isInvalidToken(error)) return undefined;
      throw error;
    }
  }

  app.decorateRequest('caller', null);
  app.addHook('onRequest', async (request, reply) => {
    const authorization = request.headers.authorization;
    if (authorization?.toLowerCase().startsWith('bearer')) {
      const token = BEARER.exec(authorization)?.groups?.token;
      const claims = token === undefined ? undefined : await verify(token);
      if (token === undefined || claims?.iss === undefined || claims.sub === undefined) {
        return sendProblem(reply, { status: 401, detail: TOKEN_REQUIRED });
      }
      const name = typeof claims.name === 'string' ? claims.name : undefined;
      request.caller = { account: await options.authenticate(claims.iss, claims.sub, name), accessToken: token };
    }
    const access = accessRule(requestPath(request.url));
    if (access === 'permitAll') return undefined;
    if (!request.caller) return sendProblem(reply, { status: 401, detail: TOKEN_REQUIRED });
    if (access === 'authenticated' || access === request.caller.account.role) return undefined;
    return sendProblem(reply, { status: 403, detail: FORBIDDEN });
  });
  app.setNotFoundHandler(deny);
}
