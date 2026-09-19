import { describe, expect, it } from 'vitest';

/**
 * Checks that a token this webapp obtains is one the business API accepts.
 *
 * It lives apart from the flow tests on purpose: no screen and no hook ever
 * calls the business API. Only the future TypeScript SDK will.
 *
 * Opt in with a token captured from a real browser sign-in:
 *   DEX_WEB_ACCESS_TOKEN=... npx vitest run token-compatibility
 */
const token = process.env.DEX_WEB_ACCESS_TOKEN;
const apiBaseUrl = process.env.DEX_API_BASE_URL ?? 'http://localhost:18080';
const issuer = process.env.DEX_IAM_ISSUER ?? 'http://localhost:18082/realms/Dex';

/**
 * A trader's token reaching an onboarding that does not exist gets 404. An
 * operator's token is refused by the role check first, so set
 * DEX_API_EXPECTED_STATUS=403 for one. Anything else, including 401, a
 * redirect or a 500, means the token did not do what this test claims.
 */
const expectedStatus = Number(process.env.DEX_API_EXPECTED_STATUS ?? '404');
const MISSING_ONBOARDING = '00000000-0000-0000-0000-000000000000';

function claims(accessToken: string): Record<string, unknown> {
  const payload = accessToken.split('.')[1];
  if (!payload) throw new Error('Access token is not a JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

describe.skipIf(!token)('token compatibility with the business API', () => {
  it('carries the issuer and audience the backend validates', () => {
    const parsed = claims(token!);
    const audience = parsed.aud;

    expect(parsed.iss).toBe(issuer);
    expect(Array.isArray(audience) ? audience : [audience]).toContain('backend');
    expect(parsed.sub).toEqual(expect.any(String));
  });

  it('is accepted by the API, which answers with its own problem document', async () => {
    const response = await fetch(`${apiBaseUrl}/v1/onboardings/${MISSING_ONBOARDING}`, {
      headers: { Authorization: `Bearer ${token}` },
      // A 302 to a login page must fail here, not follow through to a 200.
      redirect: 'manual',
    });

    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get('content-type')).toMatch(/application\/problem\+json/);

    const problem = (await response.json()) as { status?: number; detail?: string };
    expect(problem.status).toBe(response.status);
    expect(problem.detail).toEqual(expect.any(String));
    expect(problem.detail).not.toMatch(/access token/i);
  });

  it('is the only thing standing between the caller and a rejection', async () => {
    const response = await fetch(`${apiBaseUrl}/v1/onboardings/${MISSING_ONBOARDING}`, {
      redirect: 'manual',
    });

    expect(response.status).toBe(401);
  });
});
