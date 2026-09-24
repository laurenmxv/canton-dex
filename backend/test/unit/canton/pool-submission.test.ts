import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceCredentials } from '../../../src/canton/credentials.js';
import { definitelyRejected, LedgerHttp, LedgerRejected } from '../../../src/canton/http.js';
import { Ledger } from '../../../src/canton/ledger.js';
import { submitPoolCommand } from '../../../src/canton/pool-ledger.js';
import { LedgerUnavailable } from '../../../src/platform/errors.js';
import { PoolRejected } from '../../../src/pools/ports.js';
import {
  cantonError,
  fakeParticipant,
  TOKEN_ROUTE,
  type Answer,
  type FakeParticipant,
} from '../support/participant.js';

/** gRPC status codes as the JSON Ledger API reports them in `grpcCodeValue`. */
const CANCELLED = 1;
const UNKNOWN = 2;
const INVALID_ARGUMENT = 3;
const DEADLINE_EXCEEDED = 4;
const NOT_FOUND = 5;
const ALREADY_EXISTS = 6;
const PERMISSION_DENIED = 7;
const ABORTED = 10;
const UNAVAILABLE = 14;
const UNAUTHENTICATED = 16;

function rejection(grpcCode: number, code: string, definiteAnswer = false): LedgerRejected {
  return new LedgerRejected(409, code, grpcCode, 'rejected', definiteAnswer);
}

describe('pool submission', () => {
  let participant: FakeParticipant;
  let ledger: Ledger;
  let answer: Answer;

  beforeEach(async () => {
    participant = await fakeParticipant({
      ...TOKEN_ROUTE,
      'POST /v2/commands/submit-and-wait-for-transaction': () => answer,
    });
    ledger = Ledger.service(
      new LedgerHttp(participant.url),
      new ServiceCredentials(new URL('/token', participant.url), {
        userId: 'operator',
        clientId: 'c',
        clientSecret: 's',
      }),
    );
  });

  afterEach(() => participant.close());

  const submit = () => submitPoolCommand(() => ledger.submit('command', 'operator', [], []));

  it('distinguishes a known rejection from a transport failure and a duplicate command', async () => {
    for (const [status, grpcCode] of [
      [403, PERMISSION_DENIED],
      [401, UNAUTHENTICATED],
      [400, INVALID_ARGUMENT],
    ] as const) {
      answer = cantonError(status, grpcCode, 'refused');
      await expect(submit()).rejects.toBeInstanceOf(PoolRejected);
    }
    for (const [status, grpcCode] of [
      [504, DEADLINE_EXCEEDED],
      [499, CANCELLED],
      [500, UNKNOWN],
      [503, UNAVAILABLE],
      [404, NOT_FOUND],
      [409, ALREADY_EXISTS],
    ] as const) {
      answer = cantonError(status, grpcCode, 'unknown outcome');
      // The participant's answer passes through, retryable or not, with its code intact.
      const failure = await submit().catch((error: unknown) => error);
      expect(failure).not.toBeInstanceOf(PoolRejected);
      const reported = failure instanceof LedgerUnavailable ? failure.cause : failure;
      expect(reported instanceof LedgerRejected && reported.grpcCode === grpcCode).toBe(true);
    }
  });

  it('a missing update does not prove a rejection, but a missing input contract does', () => {
    for (const code of ['UPDATE_NOT_FOUND', 'CONTRACT_NOT_FOUND']) {
      expect(definitelyRejected(rejection(NOT_FOUND, code))).toBe(code === 'CONTRACT_NOT_FOUND');
    }
  });

  it("respects Canton's definite answer without treating a duplicate as a failure", () => {
    expect(definitelyRejected(rejection(ABORTED, 'NA', true))).toBe(true);
    expect(definitelyRejected(rejection(ALREADY_EXISTS, 'NA', true))).toBe(false);
  });
});
