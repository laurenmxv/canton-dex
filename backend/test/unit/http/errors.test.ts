import { afterEach, describe, expect, it } from 'vitest';
import { LedgerHttp } from '../../../src/canton/http.js';
import { PartyAlreadyExists } from '../../../src/onboarding/model.js';
import { AccessDenied, CodedFailure } from '../../../src/platform/errors.js';
import { createServer } from '../../../src/platform/server.js';
import { cantonError, fakeParticipant, type FakeParticipant } from '../support/participant.js';

/** The answer of the error handler for a request whose handler throws `failure`. */
async function fail(failure: unknown) {
  const app = createServer();
  app.get('/v1/admin/monitoring', () => {
    throw failure;
  });
  const response = await app.inject({ method: 'GET', url: '/v1/admin/monitoring' });
  await app.close();
  return {
    status: response.statusCode,
    type: response.headers['content-type'],
    body: response.json<Record<string, unknown>>(),
  };
}

describe('API errors', () => {
  let participant: FakeParticipant | undefined;
  afterEach(async () => {
    await participant?.close();
    participant = undefined;
  });

  /** A raw participant failure, as the adapter raises it for this gRPC status. */
  async function participantFailure(grpcCode: number, status: number): Promise<unknown> {
    participant = await fakeParticipant({
      'GET /v2/state/ledger-end': () => cantonError(status, grpcCode, 'secret-access-token'),
    });
    const http = new LedgerHttp(participant.url);
    const error = await http
      .call({ method: 'GET', path: '/v2/state/ledger-end', token: 'token', timeoutMs: 5_000 })
      .catch((e: unknown) => e);
    await participant.close();
    participant = undefined;
    return error;
  }

  it.each([
    ['UNAVAILABLE', 14, 503],
    ['DEADLINE_EXCEEDED', 4, 504],
    ['CANCELLED', 1, 499],
    ['RESOURCE_EXHAUSTED', 8, 429],
  ])('answers a transient participant read (%s) with a safe 503', async (_name, grpcCode, status) => {
    const response = await fail(await participantFailure(grpcCode, status));
    expect(response.status).toBe(503);
    expect(response.type).toBe('application/problem+json');
    expect(response.body.code).toBe('LEDGER_UNAVAILABLE');
    expect(response.body.detail).toBe('The participant is temporarily unavailable; try again');
    expect(JSON.stringify(response.body)).not.toContain('secret-access-token');
  });

  it.each([
    ['INVALID_ARGUMENT', 3, 400],
    ['FAILED_PRECONDITION', 9, 400],
    ['UNAUTHENTICATED', 16, 401],
    ['PERMISSION_DENIED', 7, 403],
  ])('keeps the existing status of another raw participant failure (%s)', async (_name, grpcCode, status) => {
    expect((await fail(await participantFailure(grpcCode, status))).status).toBe(500);
  });

  it('preserves domain, authorization, conflict and unknown-outcome errors', async () => {
    expect((await fail(new AccessDenied('denied'))).status).toBe(403);
    for (const failure of [
      new CodedFailure(401, 'SESSION_EXPIRED', 'Sign in again'),
      new CodedFailure(409, 'POOL_CHANGED', 'Pool changed'),
      new CodedFailure(503, 'LEDGER_UNAVAILABLE', 'Confirmation is pending'),
    ]) {
      const response = await fail(failure);
      expect(response.status).toBe(failure.status);
      expect(response.body.code).toBe(failure.code);
    }
  });

  it('answers a duplicate party with an explicit conflict', async () => {
    const response = await fail(new PartyAlreadyExists());
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PARTY_ALREADY_EXISTS');
    expect(response.body.detail).toBe('This party already exists. Registration was stopped.');
  });
});
