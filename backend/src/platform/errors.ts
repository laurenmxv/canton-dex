/**
 * Failures with a defined public answer. `problems.ts` maps each one to its status, detail and
 * code; any other error becomes the generic 500 answer.
 */

/** Invalid request fields or body; the answer is the generic 400 detail. */
export class InvalidRequest extends Error {}

/** A missing resource, or one that belongs to another account. */
export class NotFound extends Error {
  constructor() {
    super('Resource not found');
  }
}

/** An authenticated caller without the rights for the operation. */
export class AccessDenied extends Error {}

/** A business conflict. The message is the public detail; `code` is added when the API has one. */
export class Conflict extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** A workflow failure with its own public status and code. */
export class CodedFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A dependency that could not answer; the message is the public 503 detail, without a code. */
export class Unavailable extends Error {}

/**
 * A participant failure that may succeed on retry: unreachable, timed out, cancelled or
 * overloaded. It never proves that a submitted command was rejected.
 */
export class LedgerUnavailable extends Error {}
