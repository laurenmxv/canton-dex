import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { DevelopmentFixtures } from './fixtures.js';
import { at, text } from '../../support/json.js';

const REQUEST_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;
const COMPLETED_TIMEOUT_MS = 90_000;
const COMPLETED_POLL_MS = 1_000;

export interface KeyPair {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

export { delay };

export function ed25519KeyPair(): KeyPair {
  return generateKeyPairSync('ed25519');
}

export function secp256k1KeyPair(): KeyPair {
  return generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
}

export function publicKey(key: KeyPair): string {
  return key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

/** The wallet's signature of the prepared multihash, as the frontend submits it. */
export function signParty(key: KeyPair, party: unknown): { preparationId: string; signature: string } {
  const hash = Buffer.from(text(party, 'multiHash'), 'base64');
  return {
    preparationId: text(party, 'preparationId'),
    signature: sign(null, hash, key.privateKey).toString('base64'),
  };
}

/** One scenario's view of the running backend, with the development fixtures. */
export class BackendFixture {
  readonly fixtures = new DevelopmentFixtures();
  private readonly baseUrl = (process.env.DEX_TEST_BASE_URL ?? '').replace(/\/+$/, '');

  static async start(): Promise<BackendFixture> {
    const fixture = new BackendFixture();
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        if ((await fixture.send('GET', '/actuator/health/readiness', undefined, undefined)).status === 200)
          return fixture;
      } catch {
        // The backend may still be starting; poll until the deadline.
      }
      if (Date.now() > deadline) throw new Error('The backend did not become ready');
      await delay(READY_POLL_MS);
    }
  }

  async trader(scenario: string): Promise<string> {
    const name = `${scenario}-${randomUUID()}`;
    await this.fixtures.createTrader(name);
    return name;
  }

  token(name: string): Promise<string> {
    return this.fixtures.userToken(name);
  }

  send(method: string, path: string, token: string | undefined, body: unknown): Promise<Response> {
    return fetch(this.baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /** One exchange with the expected status; an error must be a complete problem detail. */
  async request(
    method: string,
    path: string,
    token: string | undefined,
    body: unknown,
    expected: number,
  ): Promise<unknown> {
    const response = await this.send(method, path, token, body);
    const payload = await response.text();
    expect(response.status, `${method} ${path}: ${payload}`).toBe(expected);
    const json: unknown = JSON.parse(payload);
    if (expected >= 400) {
      expect(response.headers.get('content-type') ?? '').toContain('application/problem+json');
      expect(at(json, 'status')).toBe(expected);
      expect(at(json, 'type') ?? 'about:blank').toBe('about:blank');
      expect(text(json, 'title')).not.toBe('');
      expect(text(json, 'detail')).not.toBe('');
    }
    return json;
  }

  async create(token: string): Promise<unknown> {
    return this.request(
      'POST',
      '/v1/onboardings',
      token,
      {
        legalName: 'Synthetic Trader',
        countryCode: 'AR',
        documents: [
          {
            id: randomUUID(),
            category: 'IDENTITY',
            fileName: 'david-test.pdf',
            mediaType: 'application/pdf',
            sizeBytes: 1234,
            simulated: true,
          },
        ],
      },
      201,
    );
  }

  async approve(id: string): Promise<unknown> {
    return this.request(
      'POST',
      `/v1/admin/onboardings/${id}/review`,
      await this.token('operator'),
      { decision: 'APPROVED', approvedPoolIds: [await this.poolId()], partyHint: 'dex_david_test' },
      200,
    );
  }

  async register(id: string, token: string): Promise<unknown> {
    const key = ed25519KeyPair();
    const prepared = await this.request(
      'POST',
      `/v1/onboardings/${id}/party/prepare`,
      token,
      { publicKey: publicKey(key) },
      200,
    );
    await this.request('POST', `/v1/onboardings/${id}/party/submit`, token, signParty(key, at(prepared, 'party')), 200);
    return this.completed(token);
  }

  async completed(token: string): Promise<unknown> {
    const deadline = Date.now() + COMPLETED_TIMEOUT_MS;
    for (;;) {
      const onboarding = await this.request('GET', '/v1/onboardings/mine', token, undefined, 200);
      if (at(onboarding, 'status') === 'COMPLETED') return onboarding;
      if (Date.now() > deadline) throw new Error(`Onboarding did not complete: ${JSON.stringify(onboarding)}`);
      await delay(COMPLETED_POLL_MS);
    }
  }

  async subject(accountId: string): Promise<string> {
    const row = await this.fixtures.db
      .selectFrom('accounts')
      .select('subject')
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    return row.subject;
  }

  async poolId(): Promise<string> {
    const { rows } = await sql<{ pool_id: string }>`
      SELECT p.pool_id FROM test_token_pools t JOIN pools p ON p.pool_id=t.pool_id
      WHERE t.pair='BTC/USDC' AND p.active`.execute(this.fixtures.db);
    const [row] = rows;
    if (rows.length !== 1 || !row) throw new Error('Expected one active BTC/USDC fixture pool');
    return row.pool_id;
  }

  close(): Promise<void> {
    return this.fixtures.close();
  }
}

/** Runs one test with its own BackendFixture, and closes the fixture after the test. */
export async function withBackend(run: (test: BackendFixture) => Promise<void>): Promise<void> {
  const test = await BackendFixture.start();
  try {
    await run(test);
  } finally {
    await test.close();
  }
}
