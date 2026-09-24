// Minimal HTTP and Keycloak helpers for the compatibility cases. Credentials come from the
// caller's environment; tokens are held in memory only and never written or printed.

/** Every request has a deadline, so a stalled backend or Keycloak fails the run. */
const REQUEST_TIMEOUT_MS = 60_000;
/** The realm and clients the local stack imports from docker/Dex-realm.json. */
const DEX_REALM = 'Dex';
const ADMIN_CLIENT_ID = 'admin-cli';
const DIRECT_GRANT_CLIENT_ID = 'backend-tests';
/** Development fixture credentials, as the backend integration fixtures use them. */
export const OPERATOR_USERNAME = 'operator';
const OPERATOR_PASSWORD = 'operator';
const TRADER_PASSWORD = 'test-password';

export function endpoints({ api, keycloak }) {
  return { api: api.replace(/\/+$/, ''), keycloak: keycloak.replace(/\/+$/, '') };
}

function bounded(init = {}) {
  return { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

async function passwordToken(url, values) {
  const response = await fetch(url, bounded({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
  }));
  if (!response.ok) throw new Error(`token request to ${new URL(url).pathname} returned ${response.status}`);
  return (await response.json()).access_token;
}

function adminToken(target, credentials) {
  return passwordToken(`${target.keycloak}/realms/master/protocol/openid-connect/token`, {
    client_id: ADMIN_CLIENT_ID,
    grant_type: 'password',
    username: credentials.username,
    password: credentials.password,
  });
}

/** Creates a Keycloak trader in the Dex realm, as the backend test fixtures do. */
export async function createTrader(target, credentials, name) {
  const token = await adminToken(target, credentials);
  const response = await fetch(`${target.keycloak}/admin/realms/${DEX_REALM}/users`, bounded({
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      username: name,
      enabled: true,
      firstName: name,
      lastName: 'Fixture',
      email: `${name}@example.test`,
      emailVerified: true,
      credentials: [{ type: 'password', value: TRADER_PASSWORD, temporary: false }],
    }),
  }));
  if (response.status !== 201) throw new Error(`creating trader returned ${response.status}`);
  return name;
}

/** A Dex access token through the direct-grant client. */
export function userToken(target, name) {
  return passwordToken(`${target.keycloak}/realms/${DEX_REALM}/protocol/openid-connect/token`, {
    client_id: DIRECT_GRANT_CLIENT_ID,
    grant_type: 'password',
    username: name,
    password: name === OPERATOR_USERNAME ? OPERATOR_PASSWORD : TRADER_PASSWORD,
  });
}

/**
 * One exchange. `body` is sent as JSON; `raw` is sent unchanged; neither sends no body.
 * `json` is undefined when the answer is empty or is not JSON; `text` always has the body.
 */
export async function call(target, method, path, { token, body, raw, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] ??= 'application/json';
  }
  const response = await fetch(target.api + path, bounded(init));
  const text = await response.text();
  return { status: response.status, headers: Object.fromEntries(response.headers), text, json: parseJson(text) };
}

function parseJson(text) {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
