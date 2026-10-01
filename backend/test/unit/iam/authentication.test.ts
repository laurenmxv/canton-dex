import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { Account } from '../../../src/iam/accounts.js';
import { registerAuthentication, requireCaller } from '../../../src/iam/authentication.js';
import { createServer } from '../../../src/platform/server.js';

describe('account authentication', () => {
  it('keeps the validated caller JWT for the request and takes the role from the account', async () => {
    const account: Account = {
      id: randomUUID(),
      issuer: 'https://identity.test',
      subject: 'david-user',
      displayName: 'David',
      role: 'TRADER',
    };
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' };
    const now = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({ name: account.displayName, roles: ['OPERATOR'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(account.issuer)
      .setSubject(account.subject)
      .setAudience(['backend'])
      .setIssuedAt(now - 10)
      .setExpirationTime(now + 120)
      .sign(privateKey);
    const app = createServer();
    registerAuthentication(app, {
      issuer: account.issuer,
      keys: createLocalJWKSet({ keys: [jwk] }),
      authenticate: (issuer, subject, name) => {
        expect(issuer).toBe(account.issuer);
        expect(subject).toBe(account.subject);
        expect(name).toBe(account.displayName);
        return Promise.resolve(account);
      },
    });
    let seen: ReturnType<typeof requireCaller> | undefined;
    app.get('/v1/me', (request, reply) => {
      seen = requireCaller(request);
      return reply.send({});
    });
    app.get('/v1/admin/onboardings', (_request, reply) => reply.send({}));
    app.get('/v1/pools/pool-1/market-data', (_request, reply) => reply.send({}));

    const authorization = `Bearer ${token}`;
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization } })).statusCode).toBe(200);
    expect(seen?.account).toBe(account);
    expect(seen?.accessToken).toBe(token);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/pools/pool-1/market-data',
          headers: { authorization },
        })
      ).statusCode,
    ).toBe(200);
    // Database roles are authoritative: the token's OPERATOR claim grants nothing.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/admin/onboardings', headers: { authorization } })).statusCode,
    ).toBe(403);
    // The principal that code passes around holds no credential.
    expect(JSON.stringify(seen?.account)).not.toContain(token);
    await app.close();
  });
});
