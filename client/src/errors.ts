/**
 * What went wrong, at the level a caller can act on.
 *
 * - `authentication`: no usable token, so nothing was sent.
 * - `http`: the server answered with a non-2xx status.
 * - `network`: the request produced no readable response.
 * - `response`: a 2xx answer the client could not read as JSON.
 */
export type DexClientErrorKind = 'authentication' | 'http' | 'network' | 'response';

/** RFC 7807, as the backend's `ApiErrors` filter writes it. */
export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  /**
   * The venue's own name for the rule that refused, such as `QUOTE_EXPIRED` or
   * `LEDGER_UNAVAILABLE`. It is an extension member the backend adds to the
   * swap, settlement and availability problems, and is absent from the rest.
   */
  code?: string;
}

export interface DexClientErrorOptions {
  /** Present on `http` errors, and authoritative even when the body is unreadable. */
  status?: number;
  problem?: ProblemDetails;
  cause?: unknown;
}

/**
 * The only error this client throws, apart from a caller's own `AbortError`,
 * which is re-thrown untouched so cancellation never reads as a failure.
 *
 * Nothing this client puts on it carries an access token, an Authorization
 * header or the request options it was built from. A `cause` is whatever the
 * caller's own fetch or token provider threw, and is passed through unread.
 */
export class DexClientError extends Error {
  readonly kind: DexClientErrorKind;
  readonly status: number | undefined;
  readonly problem: ProblemDetails | undefined;

  constructor(kind: DexClientErrorKind, message: string, options: DexClientErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'DexClientError';
    this.kind = kind;
    this.status = options.status;
    this.problem = options.problem;
  }
}

/** Reads the Problem Details fields the backend sends, and ignores anything else. */
export function readProblem(body: unknown): ProblemDetails | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const source = body as Record<string, unknown>;
  const problem: ProblemDetails = {};
  for (const key of ['type', 'title', 'detail', 'instance', 'code'] as const) {
    const value = source[key];
    if (typeof value === 'string') problem[key] = value;
  }
  if (typeof source['status'] === 'number') problem.status = source['status'];
  return Object.keys(problem).length > 0 ? problem : undefined;
}
