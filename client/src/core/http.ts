/**
 * Sends typed requests and returns results or errors.
 *
 * @remarks
 * Stateless library transport. It does not sign, settle, poll, cache or retry requests.
 *
 * @packageDocumentation
 */
import { DexClientError, readProblem, type ProblemDetails } from '../errors.js';
import type { DexClientConfig, RequestOptions } from '../types/common.js';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  /** An API path with every dynamic segment already encoded. */
  path: string;
  /**
   * Appended as a query string. A parameter whose value is undefined is left
   * out, so the route applies its own default rather than being sent a blank.
   */
  query?: Readonly<Record<string, string | number | undefined>>;
  /** Serialized only when present, so a bodyless request stays bodyless. */
  body?: unknown;
  /**
   * True where a JSON `null` is an answer the route gives on purpose, as
   * `GET /v1/onboardings/mine` does before the caller has applied. Everywhere
   * else a null body stays a protocol error.
   */
  nullable?: boolean;
  /**
   * True where the route answers `204 No Content` on purpose, as a deferral
   * does. Success then resolves with nothing, and no body is read as a record.
   */
  empty?: boolean;
}

/** The transport each module is handed. `index.ts` does not re-export it. */
export type Send = <T>(request: HttpRequest, options?: RequestOptions) => Promise<T>;

const ACCEPT = 'application/json, application/problem+json';

/** Encodes one dynamic segment. Every identifier in a path goes through this. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

/** The one place a query is encoded, so no caller builds a string by hand. */
function queryString(query: HttpRequest['query']): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, String(value));
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

const BASE_URL_RULE =
  'baseUrl must be an absolute http(s) URL with a host, or a root-relative path such as "/api", and carry no query, fragment, backslash or control character';

/**
 * Characters a base URL may never carry: a backslash reads as a separator, a
 * control character is dropped by URL parsing rather than refused, and a query
 * or fragment cuts the path short once an API path is appended to it.
 */
const FORBIDDEN = /[\\?#\u0000-\u001f\u007f]/;

/** Exactly one leading slash, so `//host` and `///host` never qualify. */
const ROOT_RELATIVE = /^\/(?!\/)/;

/** Stands in for the page origin, so a root-relative base can be tested against it. */
const PROBE_ORIGIN = 'http://base.invalid';

/**
 * An absolute `http(s)` URL with a host, or a root-relative path.
 *
 * Anything that could move the origin is refused, because the bearer token
 * would then reach a host the operator never configured. Two rules do that,
 * and neither covers the other:
 *
 * - A base must have exactly one leading slash. This is a rule about shape, not
 *   about where it happens to resolve, because a protocol-relative base naming
 *   the probe host would otherwise resolve to the probe origin and pass.
 * - What is left must still resolve to the probe origin, which is what catches
 *   `/\evil.test`, where the backslash reads as a separator.
 *
 * `FORBIDDEN` covers the rest.
 */
function resolveBase(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === '') return '';
  if (FORBIDDEN.test(trimmed)) throw new TypeError(BASE_URL_RULE);

  let url: URL;
  try {
    url = new URL(trimmed, PROBE_ORIGIN);
  } catch {
    throw new TypeError(BASE_URL_RULE);
  }

  if (/^https?:\/\//i.test(trimmed)) {
    if (url.host === '') throw new TypeError(BASE_URL_RULE);
  } else if (!ROOT_RELATIVE.test(trimmed) || url.origin !== PROBE_ORIGIN) {
    throw new TypeError(BASE_URL_RULE);
  }
  return trimmed.replace(/\/+$/, '');
}

async function bearerToken(
  config: DexClientConfig,
  signal: AbortSignal | undefined,
): Promise<string> {
  let token: string | null;
  try {
    token = await config.getAccessToken();
  } catch (cause) {
    // A provider that rejects because the caller gave up reports the abort.
    signal?.throwIfAborted();
    throw new DexClientError('authentication', 'The access token provider failed', { cause });
  }
  // The provider may have taken a while. A caller who gave up in the meantime
  // gets their own AbortError, whatever the provider ended up answering.
  signal?.throwIfAborted();
  if (typeof token !== 'string' || token.trim() === '') {
    throw new DexClientError('authentication', 'No access token is available');
  }
  return token;
}

/** Parsed JSON, or undefined when the body is empty or not JSON at all. */
function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function httpMessage(status: number, problem: ProblemDetails | undefined): string {
  const detail = problem?.detail ?? problem?.title;
  return detail === undefined ? `HTTP ${status}` : `HTTP ${status}: ${detail}`;
}

/**
 * Builds the one request function every operation goes through.
 *
 * It sends exactly one attempt: there is no retry, no idempotency key and no
 * cache, because a POST that fails after leaving has an unknown outcome on the
 * server and replaying it is not this client's decision to make.
 */
export function createSend(config: DexClientConfig): Send {
  const base = resolveBase(config.baseUrl);
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new TypeError('This runtime has no fetch; pass one as fetchImpl');
  }

  return async function send<T>(request: HttpRequest, options?: RequestOptions): Promise<T> {
    const signal = options?.signal;
    signal?.throwIfAborted();

    const token = await bearerToken(config, signal);

    const headers: Record<string, string> = {
      accept: ACCEPT,
      authorization: `Bearer ${token}`,
    };
    const hasBody = request.body !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await doFetch(`${base}${request.path}${queryString(request.query)}`, {
        method: request.method,
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined,
        signal,
        // No cookie ever rides along with the bearer token, and a redirect is
        // refused rather than carrying the Authorization header somewhere else.
        credentials: 'omit',
        redirect: 'error',
      });
    } catch (cause) {
      // A cancelled request is the caller's own AbortError, not a failure.
      signal?.throwIfAborted();
      throw new DexClientError('network', 'The request did not complete', { cause });
    }

    // Read separately: once a response exists, its status outranks a body the
    // connection failed to deliver.
    let body: unknown;
    try {
      body = parseJson(await response.text());
    } catch {
      signal?.throwIfAborted();
      body = undefined;
    }

    if (!response.ok) {
      const problem = readProblem(body);
      throw new DexClientError('http', httpMessage(response.status, problem), {
        status: response.status,
        problem,
      });
    }

    if (request.empty) return undefined as T;
    if (body === null && request.nullable) return null as T;
    if (typeof body !== 'object' || body === null) {
      throw new DexClientError('response', 'The venue returned a body that is not JSON');
    }
    return body as T;
  };
}
