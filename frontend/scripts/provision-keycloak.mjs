#!/usr/bin/env node
/**
 * Registers the public browser client this webapp signs in with, on the
 * Keycloak that cn-quickstart already runs.
 *
 * Idempotent: run it as often as you like. It only ever touches the one client
 * it owns, and never the realm, its users, or any other client.
 *
 * Administrative credentials come from the environment and are never printed,
 * never written to a file, and never reach the browser bundle.
 */

const KEYCLOAK_URL = process.env.DEX_KEYCLOAK_URL ?? 'http://localhost:18082';
const REALM = process.env.DEX_KEYCLOAK_REALM ?? 'Dex';
const CLIENT_ID = process.env.DEX_KEYCLOAK_CLIENT_ID ?? 'dex-web';
const APP_ORIGIN = process.env.DEX_WEB_ORIGIN ?? 'http://localhost:5180';
const ADMIN_USER =
  process.env.DEX_KEYCLOAK_ADMIN_USERNAME ?? process.env.DEX_BOOTSTRAP_KEYCLOAK_USERNAME;
const ADMIN_PASSWORD =
  process.env.DEX_KEYCLOAK_ADMIN_PASSWORD ?? process.env.DEX_BOOTSTRAP_KEYCLOAK_PASSWORD;

if (!ADMIN_USER || !ADMIN_PASSWORD) {
  console.error(
    'Set DEX_KEYCLOAK_ADMIN_USERNAME and DEX_KEYCLOAK_ADMIN_PASSWORD, then run this again.\n' +
      'The local cn-quickstart values live in docker/env/bootstrap.env.',
  );
  process.exit(1);
}

/** The browser client: no secret, no direct grants, no service account. */
const desired = {
  clientId: CLIENT_ID,
  name: 'Canton DEX webapp',
  enabled: true,
  protocol: 'openid-connect',
  publicClient: true,
  standardFlowEnabled: true,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: false,
  redirectUris: [`${APP_ORIGIN}/*`],
  webOrigins: [APP_ORIGIN],
  attributes: {
    login_theme: 'canton-dex',
    'pkce.code.challenge.method': 'S256',
    'post.logout.redirect.uris': `${APP_ORIGIN}/*`,
  },
  protocolMappers: [
    {
      name: 'backend-audience',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-audience-mapper',
      config: { 'included.custom.audience': 'backend', 'access.token.claim': 'true' },
    },
  ],
};

async function adminToken() {
  const body = new URLSearchParams({
    client_id: 'admin-cli',
    grant_type: 'password',
    username: ADMIN_USER,
    password: ADMIN_PASSWORD,
  });
  const response = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Admin sign-in failed with HTTP ${response.status}`);
  }
  return (await response.json()).access_token;
}

async function admin(token, method, path, payload) {
  const response = await fetch(`${KEYCLOAK_URL}/admin/realms/${REALM}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} returned HTTP ${response.status}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  const token = await adminToken();
  const existing = await admin(token, 'GET', `/clients?clientId=${encodeURIComponent(CLIENT_ID)}`);

  if (existing.length === 0) {
    await admin(token, 'POST', '/clients', desired);
    console.log(`Created public client ${CLIENT_ID} in realm ${REALM}.`);
  } else {
    await admin(token, 'PUT', `/clients/${existing[0].id}`, { ...existing[0], ...desired });
    console.log(`Updated public client ${CLIENT_ID} in realm ${REALM}.`);
  }

  console.log(`  redirect: ${APP_ORIGIN}/*`);
  console.log('  flow:     authorization code with PKCE S256');
  console.log('  audience: backend');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
