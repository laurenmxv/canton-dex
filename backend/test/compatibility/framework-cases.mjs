// Framework, health and HTTP-edge cases of the DEX API. The baseline answers are in
// golden/framework.json.
//
// Case options: `auth` names the caller, `body`/`raw`/`headers` shape the request, `state: true`
// marks a body that depends on ledger or database contents (it matches the golden answer only
// from the fresh bootstrap state), and `captures: 'extra'` stores the created onboarding id that
// later `{extra}` paths use.
import { call, createTrader, OPERATOR_USERNAME, userToken } from './http.mjs';

/** An onboarding, swap, request or settlement id that no resource has. */
const MISSING_ID = '00000000-0000-0000-0000-000000000000';
const EXTRA_ONBOARDING = '{extra}';

/** A structurally valid JWT whose signature no key produced. */
function forgedToken(issuer) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: 'RS256', typ: 'JWT', kid: 'forged' }),
    encode({ iss: issuer, aud: 'backend', sub: crypto.randomUUID(), exp: now + 300, iat: now }),
    Buffer.alloc(256).toString('base64url'),
  ].join('.');
}

function cases(pool, application, document, missing) {
  return [
    // Health surfaces.
    ['health', 'GET', '/actuator/health', {}],
    ['health-readiness', 'GET', '/actuator/health/readiness', {}],
    ['health-liveness', 'GET', '/actuator/health/liveness', {}],
    ['health-readiness-head', 'HEAD', '/actuator/health/readiness', {}],
    ['health-readiness-with-token', 'GET', '/actuator/health/readiness', { auth: 'trader' }],
    ['health-component-db', 'GET', '/actuator/health/db', {}],
    ['health-component-canton', 'GET', '/actuator/health/canton', {}],
    ['health-unknown-group', 'GET', '/actuator/health/unknown', {}],
    ['actuator-root', 'GET', '/actuator', {}],
    ['actuator-root-operator', 'GET', '/actuator', { auth: 'operator' }],
    ['actuator-info', 'GET', '/actuator/info', { auth: 'operator' }],
    ['actuator-env', 'GET', '/actuator/env', { auth: 'operator' }],
    ['health-post', 'POST', '/actuator/health', {}],
    // Authentication and authorization.
    ['me-no-token', 'GET', '/v1/me', {}],
    ['me-invalid-token', 'GET', '/v1/me', { auth: 'invalid' }],
    ['me-forged-token', 'GET', '/v1/me', { auth: 'forged' }],
    ['me-basic-scheme', 'GET', '/v1/me', { headers: { authorization: 'Basic dXNlcjpwYXNz' } }],
    ['me-trader-first-login', 'GET', '/v1/me', { auth: 'trader' }],
    ['me-operator', 'GET', '/v1/me', { state: true, auth: 'operator' }],
    ['pools-no-token', 'GET', '/v1/pools', {}],
    ['admin-no-token', 'GET', '/v1/admin/onboardings', {}],
    ['admin-trader', 'GET', '/v1/admin/onboardings', { auth: 'trader' }],
    ['trader-route-operator', 'GET', '/v1/balances', { auth: 'operator' }],
    ['onboarding-route-operator', 'GET', '/v1/onboardings/mine', { auth: 'operator' }],
    ['activity-operator', 'GET', '/v1/activity', { auth: 'operator' }],
    // Authentication precedes validation.
    ['invalid-body-no-token', 'POST', '/v1/onboardings', { raw: '{', headers: { 'content-type': 'application/json' } }],
    ['invalid-body-wrong-role', 'POST', '/v1/admin/pool-proposals', { auth: 'trader', raw: '{', headers: { 'content-type': 'application/json' } }],
    ['invalid-path-no-token', 'GET', '/v1/swaps/not-a-uuid', {}],
    ['invalid-path-wrong-role', 'GET', '/v1/admin/settlements/not-a-uuid', { auth: 'trader' }],
    // Unknown routes, methods and trailing slashes.
    ['root-no-token', 'GET', '/', {}],
    ['unknown-no-token', 'GET', '/v1/unknown', {}],
    ['unknown-trader', 'GET', '/v1/unknown', { auth: 'trader' }],
    ['unknown-under-trader-prefix', 'GET', '/v1/swaps/quote/extra', { auth: 'trader' }],
    ['unknown-under-admin-prefix', 'GET', '/v1/admin/unknown', { auth: 'operator' }],
    ['documented-unimplemented-treasury', 'GET', '/v1/admin/treasury', { auth: 'operator' }],
    ['documented-unimplemented-authority', 'GET', '/v1/admin/authority', { auth: 'operator' }],
    ['documented-unimplemented-create-pool', 'POST', '/v1/admin/pools', { auth: 'operator', body: {} }],
    ['me-trailing-slash', 'GET', '/v1/me/', { auth: 'trader' }],
    ['pools-trailing-slash', 'GET', '/v1/pools/', { auth: 'trader' }],
    ['admin-trailing-slash', 'GET', '/v1/admin/onboardings/', { auth: 'operator' }],
    ['me-put', 'PUT', '/v1/me', { auth: 'trader', body: {} }],
    ['me-delete', 'DELETE', '/v1/me', { auth: 'trader' }],
    ['me-patch', 'PATCH', '/v1/me', { auth: 'trader', body: {} }],
    ['quote-get', 'GET', '/v1/swaps/quote', { auth: 'trader' }],
    ['pools-post', 'POST', '/v1/pools', { auth: 'trader', body: {} }],
    ['admin-pools-put', 'PUT', '/v1/admin/pools', { auth: 'operator', body: {} }],
    ['me-head', 'HEAD', '/v1/me', { auth: 'trader' }],
    ['me-options', 'OPTIONS', '/v1/me', { auth: 'trader' }],
    ['me-options-no-token', 'OPTIONS', '/v1/me', {}],
    ['cors-preflight', 'OPTIONS', '/v1/me', { headers: { origin: 'http://localhost:6180', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } }],
    ['cors-simple', 'GET', '/v1/me', { auth: 'trader', headers: { origin: 'http://localhost:6180' } }],
    ['forwarded-headers', 'GET', '/v1/me', { auth: 'trader', headers: { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'dex.example.test', 'x-forwarded-prefix': '/api', forwarded: 'for=203.0.113.7;proto=https;host=dex.example.test' } }],
    ['accept-xml', 'GET', '/v1/me', { auth: 'trader', headers: { accept: 'application/xml' } }],
    ['accept-problem', 'GET', '/v1/onboardings/' + missing, { auth: 'trader', headers: { accept: 'application/json, application/problem+json' } }],
    // Invalid path values.
    ['onboarding-not-uuid', 'GET', '/v1/onboardings/not-a-uuid', { auth: 'trader' }],
    ['onboarding-missing', 'GET', '/v1/onboardings/' + missing, { auth: 'trader' }],
    ['onboarding-missing-operator', 'GET', '/v1/onboardings/' + missing, { auth: 'operator' }],
    ['swap-not-uuid', 'GET', '/v1/swaps/not-a-uuid', { auth: 'trader' }],
    ['swap-missing', 'GET', '/v1/swaps/' + missing, { auth: 'trader' }],
    ['deposit-not-uuid', 'GET', '/v1/lp/deposit/not-a-uuid', { auth: 'trader' }],
    ['deposit-missing', 'GET', '/v1/lp/deposit/' + missing, { auth: 'trader' }],
    ['withdrawal-missing', 'GET', '/v1/lp/withdraw/' + missing, { auth: 'trader' }],
    ['proposal-not-uuid', 'GET', '/v1/admin/pool-proposals/not-a-uuid', { auth: 'operator' }],
    ['proposal-missing', 'GET', '/v1/admin/pool-proposals/' + missing, { auth: 'operator' }],
    ['settlement-not-uuid', 'GET', '/v1/admin/settlements/not-a-uuid', { auth: 'operator' }],
    ['settlement-missing', 'GET', '/v1/admin/settlements/' + missing, { auth: 'operator' }],
    ['pool-unknown-id', 'GET', '/v1/pools/unknown-pool', { auth: 'operator' }],
    ['pool-unknown-id-trader', 'GET', '/v1/pools/unknown-pool', { auth: 'trader' }],
    ['policy-unknown-type', 'GET', `/v1/admin/pools/${pool}/settlement-policy/bogus`, { auth: 'operator' }],
    ['policy-uppercase-type', 'GET', `/v1/admin/pools/${pool}/settlement-policy/SWAP`, { auth: 'operator' }],
    ['policy-unknown-pool', 'GET', '/v1/admin/pools/unknown-pool/settlement-policy/swap', { auth: 'operator' }],
    ['monitoring-unknown-pool', 'GET', '/v1/admin/monitoring?poolId=unknown-pool', { auth: 'operator' }],
    // Query parameters.
    ['activity-default', 'GET', '/v1/activity', { auth: 'trader' }],
    ['activity-all-default', 'GET', '/v1/activity?type=all', { auth: 'trader' }],
    ['activity-type-bogus', 'GET', '/v1/activity?type=bogus', { auth: 'trader' }],
    ['activity-type-uppercase', 'GET', '/v1/activity?type=SWAP', { auth: 'trader' }],
    ['activity-limit-zero', 'GET', '/v1/activity?limit=0', { auth: 'trader' }],
    ['activity-limit-101', 'GET', '/v1/activity?limit=101', { auth: 'trader' }],
    ['activity-limit-100', 'GET', '/v1/activity?limit=100', { auth: 'trader' }],
    ['activity-limit-text', 'GET', '/v1/activity?limit=abc', { auth: 'trader' }],
    ['activity-limit-fraction', 'GET', '/v1/activity?limit=1.5', { auth: 'trader' }],
    ['activity-cursor-bad', 'GET', '/v1/activity?cursor=bad', { auth: 'trader' }],
    ['activity-all-cursor-bad', 'GET', '/v1/activity?type=all&cursor=bad', { auth: 'trader' }],
    ['activity-all-cursor-unknown', 'GET', `/v1/activity?type=all&cursor=swap:${missing}`, { auth: 'trader' }],
    ['activity-status-bogus', 'GET', '/v1/activity?status=bogus', { auth: 'trader' }],
    ['activity-all-status-bogus', 'GET', '/v1/activity?type=all&status=bogus', { auth: 'trader' }],
    ['activity-deposit-status-settled', 'GET', '/v1/activity?type=deposit&status=SETTLED', { auth: 'trader' }],
    ['activity-duplicate-limit', 'GET', '/v1/activity?limit=5&limit=6', { auth: 'trader' }],
    ['queue-no-pool', 'GET', '/v1/admin/settlement-requests', { auth: 'operator' }],
    ['queue-blank-pool', 'GET', '/v1/admin/settlement-requests?poolId=', { auth: 'operator' }],
    ['queue-status-bogus', 'GET', `/v1/admin/settlement-requests?poolId=${pool}&status=bogus`, { auth: 'operator' }],
    ['queue-default-ready', 'GET', `/v1/admin/settlement-requests?poolId=${pool}`, { state: true, auth: 'operator' }],
    ['queue-active', 'GET', `/v1/admin/settlement-requests?poolId=${pool}&status=active`, { state: true, auth: 'operator' }],
    ['monitoring-no-pool', 'GET', '/v1/admin/monitoring', { auth: 'operator' }],
    ['settlements-list-all', 'GET', '/v1/admin/settlements', { state: true, auth: 'operator' }],
    ['settlements-list-pool', 'GET', `/v1/admin/settlements?poolId=${pool}`, { state: true, auth: 'operator' }],
    ['preview-no-type', 'GET', `/v1/admin/pools/${pool}/settlement-preview`, { auth: 'operator' }],
    ['preview-bogus-type', 'GET', `/v1/admin/pools/${pool}/settlement-preview?type=bogus`, { auth: 'operator' }],
    ['preview-empty-swap', 'GET', `/v1/admin/pools/${pool}/settlement-preview?type=swap`, { state: true, auth: 'operator' }],
    ['preview-empty-deposit', 'GET', `/v1/admin/pools/${pool}/settlement-preview?type=deposit`, { state: true, auth: 'operator' }],
    ['preview-empty-withdraw', 'GET', `/v1/admin/pools/${pool}/settlement-preview?type=withdraw`, { state: true, auth: 'operator' }],
    ['preview-retry-and-request', 'GET', `/v1/admin/pools/${pool}/settlement-preview?type=swap&retryOf=${missing}&requestId=${missing}`, { auth: 'operator' }],
    ['preview-bad-request-id', 'GET', `/v1/admin/pools/${pool}/settlement-preview?type=swap&requestId=bad`, { auth: 'operator' }],
    ['preview-unknown-request', 'GET', `/v1/admin/pools/${pool}/settlement-preview?type=swap&requestId=${missing}`, { auth: 'operator' }],
    ['preview-unknown-retry', 'GET', `/v1/admin/pools/${pool}/settlement-preview?type=swap&retryOf=${missing}`, { auth: 'operator' }],
    ['history-default', 'GET', `/v1/admin/pools/${pool}/settlement-history`, { state: true, auth: 'operator' }],
    ['history-limit-text', 'GET', `/v1/admin/pools/${pool}/settlement-history?limit=abc`, { auth: 'operator' }],
    ['history-limit-zero', 'GET', `/v1/admin/pools/${pool}/settlement-history?limit=0`, { auth: 'operator' }],
    ['history-status-bogus', 'GET', `/v1/admin/pools/${pool}/settlement-history?status=bogus`, { auth: 'operator' }],
    ['history-type-bogus', 'GET', `/v1/admin/pools/${pool}/settlement-history?type=bogus`, { auth: 'operator' }],
    ['history-before-bad', 'GET', `/v1/admin/pools/${pool}/settlement-history?before=bad`, { auth: 'operator' }],
    ['deferred-unknown-request', 'PUT', `/v1/admin/pools/${pool}/settlement-requests/swap/${missing}/deferred`, { auth: 'operator', body: { deferred: true } }],
    ['deferred-bad-type', 'PUT', `/v1/admin/pools/${pool}/settlement-requests/bogus/${missing}/deferred`, { auth: 'operator', body: { deferred: true } }],
    ['deferred-missing-body', 'PUT', `/v1/admin/pools/${pool}/settlement-requests/swap/${missing}/deferred`, { auth: 'operator' }],
    ['run-empty-queue', 'POST', `/v1/admin/pools/${pool}/settlements`, { state: true, auth: 'operator', body: { idempotencyKey: crypto.randomUUID() } }],
    ['run-missing-key', 'POST', `/v1/admin/pools/${pool}/settlements`, { auth: 'operator', body: {} }],
    ['run-unknown-pool', 'POST', '/v1/admin/pools/unknown-pool/settlements', { auth: 'operator', body: { idempotencyKey: crypto.randomUUID() } }],
    ['policy-put-stale', 'PUT', `/v1/admin/pools/${pool}/settlement-policy/deposit`, { auth: 'operator', body: { automaticEnabled: false, batchSize: 1, expectedVersion: 999 } }],
    ['policy-put-zero-batch', 'PUT', `/v1/admin/pools/${pool}/settlement-policy/deposit`, { auth: 'operator', body: { automaticEnabled: false, batchSize: 0, expectedVersion: 0 } }],
    ['policy-put-fractional-batch', 'PUT', `/v1/admin/pools/${pool}/settlement-policy/deposit`, { auth: 'operator', body: { automaticEnabled: false, batchSize: 1.5, expectedVersion: 0 } }],
    ['policy-put-missing-fields', 'PUT', `/v1/admin/pools/${pool}/settlement-policy/deposit`, { auth: 'operator', body: {} }],
    // Request bodies and content types.
    ['onboarding-missing-body', 'POST', '/v1/onboardings', { auth: 'trader' }],
    ['onboarding-malformed-json', 'POST', '/v1/onboardings', { auth: 'trader', raw: '{"legalName":', headers: { 'content-type': 'application/json' } }],
    ['onboarding-json-array', 'POST', '/v1/onboardings', { auth: 'trader', raw: '[]', headers: { 'content-type': 'application/json' } }],
    ['onboarding-json-null', 'POST', '/v1/onboardings', { auth: 'trader', raw: 'null', headers: { 'content-type': 'application/json' } }],
    ['onboarding-text-plain', 'POST', '/v1/onboardings', { auth: 'trader', raw: JSON.stringify(application), headers: { 'content-type': 'text/plain' } }],
    ['onboarding-form-urlencoded', 'POST', '/v1/onboardings', { auth: 'trader', raw: 'legalName=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
    ['onboarding-no-content-type', 'POST', '/v1/onboardings', { auth: 'trader', raw: new TextEncoder().encode(JSON.stringify(application)) }],
    ['onboarding-json-charset', 'POST', '/v1/onboardings', { auth: 'other', raw: JSON.stringify({ ...application, documents: [{ ...document, id: crypto.randomUUID() }] }), headers: { 'content-type': 'application/json; charset=utf-8' } }],
    ['onboarding-oversized-body', 'POST', '/v1/onboardings', { auth: 'trader', body: { ...application, legalName: 'x'.repeat(3 * 1024 * 1024) } }],
    ['onboarding-blank-name', 'POST', '/v1/onboardings', { auth: 'trader', body: { legalName: '', countryCode: 'AR', documents: [document] } }],
    ['onboarding-null-name', 'POST', '/v1/onboardings', { auth: 'trader', body: { legalName: null, countryCode: 'AR', documents: [document] } }],
    ['onboarding-bad-country', 'POST', '/v1/onboardings', { auth: 'trader', body: { ...application, countryCode: 'Argentina' } }],
    ['onboarding-bad-category', 'POST', '/v1/onboardings', { auth: 'trader', body: { ...application, documents: [{ ...document, category: 'PASSPORT' }] } }],
    ['onboarding-string-size', 'POST', '/v1/onboardings', { auth: 'coerced', body: { ...application, documents: [{ ...document, id: crypto.randomUUID(), sizeBytes: '1234' }] } }],
    ['onboarding-unknown-field', 'POST', '/v1/onboardings', { auth: 'extra', captures: 'extra', body: { ...application, documents: [{ ...document, id: crypto.randomUUID() }], unknownField: 'ignored?' } }],
    ['onboarding-mine-after-create', 'GET', '/v1/onboardings/mine', { auth: 'extra' }],
    ['onboarding-mine-none', 'GET', '/v1/onboardings/mine', { auth: 'trader' }],
    ['onboarding-foreign', 'GET', '/v1/onboardings/{extra}', { auth: 'trader' }],
    ['onboarding-own-by-id', 'GET', '/v1/onboardings/{extra}', { auth: 'extra' }],
    ['onboarding-by-id-operator', 'GET', '/v1/onboardings/{extra}', { auth: 'operator' }],
    ['review-not-uuid', 'POST', '/v1/admin/onboardings/not-a-uuid/review', { auth: 'operator', body: { decision: 'REJECTED', approvedPoolIds: [] } }],
    ['review-missing', 'POST', `/v1/admin/onboardings/${missing}/review`, { auth: 'operator', body: { decision: 'REJECTED', approvedPoolIds: [] } }],
    ['review-bad-decision', 'POST', '/v1/admin/onboardings/{extra}/review', { auth: 'operator', body: { decision: 'MAYBE', approvedPoolIds: [] } }],
    ['review-lowercase-decision', 'POST', '/v1/admin/onboardings/{extra}/review', { auth: 'operator', body: { decision: 'rejected', approvedPoolIds: [] } }],
    ['review-approve-no-pools', 'POST', '/v1/admin/onboardings/{extra}/review', { auth: 'operator', body: { decision: 'APPROVED', approvedPoolIds: [], partyHint: 'dex_probe' } }],
    ['review-approve-no-hint', 'POST', '/v1/admin/onboardings/{extra}/review', { auth: 'operator', body: { decision: 'APPROVED', approvedPoolIds: [pool] } }],
    ['review-reject-with-pools', 'POST', '/v1/admin/onboardings/{extra}/review', { auth: 'operator', body: { decision: 'REJECTED', approvedPoolIds: [pool] } }],
    ['prepare-before-review', 'POST', '/v1/onboardings/{extra}/party/prepare', { auth: 'extra', body: { publicKey: 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=' } }],
    ['prepare-bad-key', 'POST', '/v1/onboardings/{extra}/party/prepare', { auth: 'extra', body: { publicKey: 'not-base64!' } }],
    ['submit-missing-fields', 'POST', '/v1/onboardings/{extra}/party/submit', { auth: 'extra', body: {} }],
    ['admin-onboardings-list', 'GET', '/v1/admin/onboardings', { state: true, auth: 'operator' }],
    ['swap-quote-not-onboarded', 'POST', '/v1/swaps/quote', { auth: 'trader', body: { poolId: pool, direction: 'QuoteToBase', amountIn: '1', slippageBps: 100 } }],
    ['swap-quote-invalid-direction', 'POST', '/v1/swaps/quote', { auth: 'trader', body: { poolId: pool, direction: 'Sideways', amountIn: '1', slippageBps: 100 } }],
    ['swap-quote-numeric-amount', 'POST', '/v1/swaps/quote', { auth: 'trader', body: { poolId: pool, direction: 'QuoteToBase', amountIn: 1, slippageBps: 100 } }],
    ['swap-quote-missing-fields', 'POST', '/v1/swaps/quote', { auth: 'trader', body: {} }],
    ['balances-not-onboarded', 'GET', '/v1/balances', { auth: 'trader' }],
    ['positions-not-onboarded', 'GET', '/v1/lp/positions', { auth: 'trader' }],
    ['faucet-status-not-onboarded', 'GET', '/v1/dev/faucet', { auth: 'trader' }],
    ['faucet-prepare-not-onboarded', 'POST', '/v1/dev/faucet/prepare', { auth: 'trader' }],
    ['faucet-submit-missing-body', 'POST', '/v1/dev/faucet/submit', { auth: 'trader' }],
    ['deposit-quote-not-onboarded', 'POST', '/v1/lp/deposit/quote', { auth: 'trader', body: { poolId: pool, maxBaseAmount: '0.005', maxQuoteAmount: '1000', slippageBps: 100 } }],
    ['withdraw-quote-not-onboarded', 'POST', '/v1/lp/withdraw/quote', { auth: 'trader', body: { poolId: pool, lpAmount: '1', slippageBps: 100 } }],
    ['swap-prepare-unknown-quote', 'POST', '/v1/swaps/prepare', { auth: 'trader', body: { quoteId: missing, minOut: '1', settlementDeadline: new Date(Date.now() + 600_000).toISOString() } }],
    ['swap-submit-unknown-preparation', 'POST', '/v1/swaps/submit', { auth: 'trader', body: { preparationId: missing, signature: Buffer.alloc(64).toString('base64') } }],
    ['swap-cancel-prepare-missing', 'POST', `/v1/swaps/${missing}/cancel/prepare`, { auth: 'trader' }],
    ['deposit-cancel-prepare-missing', 'POST', `/v1/lp/deposit/${missing}/cancel/prepare`, { auth: 'trader' }],
    ['withdraw-cancel-prepare-missing', 'POST', `/v1/lp/withdraw/${missing}/cancel/prepare`, { auth: 'trader' }],
    ['proposal-create-invalid', 'POST', '/v1/admin/pool-proposals', { auth: 'operator', body: { name: '', feeBps: '30' } }],
    ['proposal-create-unregistered', 'POST', '/v1/admin/pool-proposals', { auth: 'operator', body: { name: 'Probe', baseInstrumentId: { admin: 'nobody::1220', id: 'X' }, quoteInstrumentId: { admin: 'nobody::1220', id: 'Y' }, feeBps: '30' } }],
    ['proposal-withdraw-missing', 'POST', `/v1/admin/pool-proposals/${missing}/withdraw`, { auth: 'operator', body: {} }],
    ['proposal-list', 'GET', '/v1/admin/pool-proposals', { state: true, auth: 'operator' }],
    ['proposal-options', 'GET', '/v1/admin/pool-proposals/options', { state: true, auth: 'operator' }],
    ['admin-pools-list', 'GET', '/v1/admin/pools', { state: true, auth: 'operator' }],
    ['pool-detail-operator', 'GET', `/v1/pools/${pool}`, { state: true, auth: 'operator' }],
    ['pool-detail-trader', 'GET', `/v1/pools/${pool}`, { state: true, auth: 'trader' }],
    ['pools-trader', 'GET', '/v1/pools', { state: true, auth: 'trader' }],
    ['pools-operator', 'GET', '/v1/pools', { state: true, auth: 'operator' }],
  ];
}

/**
 * Runs every case in order against `target`, calling `before(name)` ahead of each exchange,
 * and returns each response. Fresh traders keep the cases independent of earlier runs.
 */
export async function runFrameworkCases(target, credentials, { issuer, before = () => {} }) {
  const run = crypto.randomUUID().slice(0, 8);
  const names = {
    trader: `framework-${run}`,
    other: `framework-other-${run}`,
    coerced: `framework-coerced-${run}`,
    extra: `framework-extra-${run}`,
  };
  const tokens = { operator: await userToken(target, OPERATOR_USERNAME), invalid: 'invalid', forged: forgedToken(issuer) };
  for (const [role, name] of Object.entries(names)) {
    await createTrader(target, credentials, name);
    tokens[role] = await userToken(target, name);
  }
  const pools = (await call(target, 'GET', '/v1/pools', { token: tokens.operator })).json;
  const document = { id: crypto.randomUUID(), category: 'IDENTITY', fileName: 'probe.pdf', mediaType: 'application/pdf', sizeBytes: 1234, simulated: true };
  const application = { legalName: 'Probe Trader', countryCode: 'AR', documents: [document] };
  const table = cases(pools[0].poolId, application, document, MISSING_ID);
  assertUniqueNames(table);
  const captured = {};
  const results = [];
  for (const [name, method, template, options] of table) {
    const path = resolvePath(name, template, captured);
    before(name);
    const token = options.auth ? tokens[options.auth] : undefined;
    const response = await call(target, method, path, { token, body: options.body, raw: options.raw, headers: options.headers });
    if (options.captures) captured[options.captures] = capturedId(name, response);
    results.push({ name, method, path, state: options.state === true, response });
  }
  return results;
}

function assertUniqueNames(table) {
  const seen = new Set();
  for (const [name] of table) {
    if (seen.has(name)) throw new Error(`duplicate framework case ${name}`);
    seen.add(name);
  }
}

/** A path that needs the onboarding an earlier case creates must not run without it. */
function resolvePath(name, template, captured) {
  if (!template.includes(EXTRA_ONBOARDING)) return template;
  if (captured.extra === undefined) throw new Error(`${name} needs the onboarding that the capturing case creates`);
  return template.replace(EXTRA_ONBOARDING, captured.extra);
}

function capturedId(name, response) {
  if (response.status !== 201 || typeof response.json?.id !== 'string') {
    throw new Error(`${name} must create an onboarding, got ${response.status}`);
  }
  return response.json.id;
}
