import { LedgerUnavailable } from '../platform/errors.js';
import { jsonText } from '../platform/json.js';

/** The gRPC status codes that JsCantonError reports as `grpcCodeValue`. */
export const GRPC = {
  CANCELLED: 1,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;
/** Failures that may succeed on retry. */
const TRANSIENT_GRPC_CODES = new Set<number>([
  GRPC.CANCELLED,
  GRPC.DEADLINE_EXCEEDED,
  GRPC.RESOURCE_EXHAUSTED,
  GRPC.UNAVAILABLE,
]);
const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);

export type Query = Readonly<Record<string, string | number | boolean | readonly string[] | undefined>>;

export interface LedgerCall {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly query?: Query;
  /** A JSON body, or raw bytes sent as `application/octet-stream`. */
  readonly body?: unknown;
}

/** A definite participant answer that is not a success, from its JsCantonError body when present. */
export class LedgerRejected extends Error {
  constructor(
    readonly status: number,
    /** The Canton error code id, for example `EXTERNAL_PARTY_ALREADY_EXISTS`. */
    readonly code: string | undefined,
    readonly grpcCode: number | undefined,
    /** The Canton error cause; it never contains a token. */
    readonly reason: string,
    /** Canton's own statement that the command has no effect, whatever the status code. */
    readonly definiteAnswer = false,
  ) {
    super(`Participant answered HTTP ${String(status)}${code ? ` ${code}` : ''}: ${reason}`);
  }
}

/**
 * Parses participant JSON. An integer beyond the exact JavaScript range, such as a large int64
 * offset, becomes a bigint with every digit; it is never rounded.
 */
export function parseLedgerJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && context && /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : value,
  );
}

/** A create that found the resource already there. */
export function alreadyExists(error: unknown): boolean {
  return error instanceof LedgerRejected && (error.grpcCode === GRPC.ALREADY_EXISTS || error.status === 409);
}

/** Codes of a submission that the participant refused before it could have an effect. */
const REFUSED_GRPC_CODES = new Set<number>([GRPC.UNAUTHENTICATED, GRPC.PERMISSION_DENIED, GRPC.INVALID_ARGUMENT]);
/** The same refusals from the HTTP layer, which answers them before it decodes any command. */
const REFUSED_HTTP_STATUSES = new Set([400, 401, 403]);
const CONTRACT_NOT_FOUND = 'CONTRACT_NOT_FOUND';

/**
 * Whether a submission with a fresh command id definitely has no effect. Certainty is independent
 * of retryability: a retryable answer can still state that the command has no effect. A duplicate
 * command is never a rejection, because the original may have committed; a missing input contract
 * is. A call without any participant answer stays uncertain.
 */
export function definitelyRejected(error: unknown): boolean {
  const answer = error instanceof LedgerUnavailable ? error.cause : error;
  if (!(answer instanceof LedgerRejected)) return false;
  if (answer.grpcCode === undefined && REFUSED_HTTP_STATUSES.has(answer.status)) return true;
  if (answer.grpcCode !== undefined && REFUSED_GRPC_CODES.has(answer.grpcCode)) return true;
  if (answer.grpcCode === GRPC.ALREADY_EXISTS) return false;
  return answer.definiteAnswer || answer.code === CONTRACT_NOT_FOUND;
}

function participantFailure(status: number, text: string, path: string): Error {
  let code: string | undefined;
  let grpcCode: number | undefined;
  let definiteAnswer = false;
  let reason = text.slice(0, 1_000);
  try {
    const body = parseLedgerJson(text);
    if (typeof body === 'object' && body !== null) {
      if ('code' in body && typeof body.code === 'string') code = body.code;
      if ('grpcCodeValue' in body && typeof body.grpcCodeValue === 'number') grpcCode = body.grpcCodeValue;
      if ('cause' in body && typeof body.cause === 'string') reason = body.cause;
      definiteAnswer = 'definiteAnswer' in body && body.definiteAnswer === true;
    }
  } catch {
    // A plain-text answer, such as a request decoding failure, keeps its text as the reason.
  }
  const answer = new LedgerRejected(status, code, grpcCode, reason, definiteAnswer);
  if ((grpcCode !== undefined && TRANSIENT_GRPC_CODES.has(grpcCode)) || TRANSIENT_HTTP_STATUSES.has(status)) {
    // Retryable; the participant's own answer stays available as the cause for certainty checks.
    return new LedgerUnavailable(`Participant ${path} is temporarily unavailable: HTTP ${String(status)}`, {
      cause: answer,
    });
  }
  return answer;
}

function url(base: URL, path: string, query: Query | undefined): URL {
  const target = new URL(path, base);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) target.searchParams.append(name, String(item));
  }
  return target;
}

/**
 * The one HTTP client of the JSON Ledger API. It owns the base URL, the per-call bearer token,
 * the deadline and exact JSON encoding and decoding. A network failure or deadline is LedgerUnavailable;
 * callers decide whether an unknown outcome needs recovery. It never retries.
 */
export class LedgerHttp {
  constructor(private readonly baseUrl: URL) {}

  async call({ method, path, token, timeoutMs, query, body }: LedgerCall): Promise<unknown> {
    const bytes = body instanceof Uint8Array;
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = bytes ? 'application/octet-stream' : 'application/json';
    let text: string;
    let status: number;
    try {
      const response = await fetch(url(this.baseUrl, path, query), {
        method,
        headers,
        body: bytes ? body : body === undefined ? null : jsonText(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw new LedgerUnavailable(`Participant ${path} did not answer`, { cause: error });
    }
    if (status < 200 || status > 299) throw participantFailure(status, text, path);
    return text === '' ? undefined : parseLedgerJson(text);
  }
}
