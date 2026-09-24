import { STATUS_CODES } from 'node:http';
import type { FastifyReply } from 'fastify';
import {
  AccessDenied,
  CodedFailure,
  Conflict,
  InvalidRequest,
  LedgerUnavailable,
  NotFound,
  Unavailable,
} from './errors.js';
import { isUniqueViolation } from './database.js';
import { jsonText } from './json.js';

export const PROBLEM_JSON = 'application/problem+json';
export const INVALID_REQUEST = 'Invalid request fields or request body';
export const TOKEN_REQUIRED = 'A valid access token is required';
export const FORBIDDEN = 'This account cannot perform that operation';
export const REQUEST_FAILED = 'The request could not be completed';
const LEDGER_UNAVAILABLE = 'The participant is temporarily unavailable; try again';
const ONBOARDING_EXISTS = 'An onboarding already exists for this account';

export interface Problem {
  readonly status: number;
  readonly detail: string;
  readonly code?: string;
}

/** The baseline answer for a failure, or undefined for an unexpected error (500). */
export function problemFor(error: unknown): Problem | undefined {
  if (error instanceof AccessDenied) return { status: 403, detail: FORBIDDEN };
  if (error instanceof NotFound) return { status: 404, detail: error.message };
  if (error instanceof CodedFailure) return { status: error.status, detail: error.message, code: error.code };
  if (error instanceof InvalidRequest) return { status: 400, detail: INVALID_REQUEST };
  if (error instanceof Conflict) {
    return error.code === undefined
      ? { status: 409, detail: error.message }
      : { status: 409, detail: error.message, code: error.code };
  }
  if (error instanceof Unavailable) return { status: 503, detail: error.message };
  // The baseline API answered every duplicate key with this onboarding detail.
  if (isUniqueViolation(error)) return { status: 409, detail: ONBOARDING_EXISTS };
  if (error instanceof LedgerUnavailable)
    return { status: 503, detail: LEDGER_UNAVAILABLE, code: 'LEDGER_UNAVAILABLE' };
  return undefined;
}

/**
 * The baseline problem body: `detail`, `status` and `title`, then `code` when there is one. As in
 * the baseline, an empty detail is omitted; a pool that is not ready without a reason has one.
 */
export function sendProblem(reply: FastifyReply, { status, detail, code }: Problem): FastifyReply {
  const body = {
    ...(detail === '' ? {} : { detail }),
    status,
    title: STATUS_CODES[status],
    ...(code === undefined ? {} : { code }),
  };
  return reply
    .code(status)
    .header('content-type', PROBLEM_JSON)
    .send(Buffer.from(JSON.stringify(body)));
}

/**
 * A JSON answer. A Buffer keeps the exact baseline content type; Fastify adds a charset to strings.
 * A bigint is an exact number literal, as the baseline wrote its int64 fields.
 */
export function sendJson(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  return reply
    .code(status)
    .header('content-type', 'application/json')
    .send(Buffer.from(jsonText(body)));
}
