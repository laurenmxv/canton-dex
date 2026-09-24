// The frozen public HTTP surface: the 50 business routes and the health routes Compose and
// the frontends use. Literal segments are listed before parameterized ones that share a prefix.

export const BUSINESS_ROUTES = [
  ['Api', 'GET', '/v1/me'],
  ['Api', 'GET', '/v1/pools'],
  ['Api', 'GET', '/v1/onboardings/mine'],
  ['Api', 'POST', '/v1/onboardings'],
  ['Api', 'GET', '/v1/onboardings/{onboardingId}'],
  ['Api', 'GET', '/v1/admin/onboardings'],
  ['Api', 'POST', '/v1/admin/onboardings/{onboardingId}/review'],
  ['Api', 'POST', '/v1/onboardings/{onboardingId}/party/prepare'],
  ['Api', 'POST', '/v1/onboardings/{onboardingId}/party/submit'],
  ['Pool', 'GET', '/v1/admin/pool-proposals/options'],
  ['Pool', 'GET', '/v1/admin/pool-proposals'],
  ['Pool', 'POST', '/v1/admin/pool-proposals'],
  ['Pool', 'GET', '/v1/admin/pool-proposals/{proposalId}'],
  ['Pool', 'POST', '/v1/admin/pool-proposals/{proposalId}/withdraw'],
  ['Pool', 'GET', '/v1/admin/pools'],
  ['Pool', 'GET', '/v1/pools/{poolId}'],
  ['Token', 'GET', '/v1/balances'],
  ['Token', 'GET', '/v1/dev/faucet'],
  ['Token', 'POST', '/v1/dev/faucet/prepare'],
  ['Token', 'POST', '/v1/dev/faucet/submit'],
  ['Swap', 'POST', '/v1/swaps/quote'],
  ['Swap', 'POST', '/v1/swaps/prepare'],
  ['Swap', 'POST', '/v1/swaps/submit'],
  ['Swap', 'GET', '/v1/swaps/{swapId}'],
  ['Swap', 'POST', '/v1/swaps/{swapId}/cancel/prepare'],
  ['Swap', 'POST', '/v1/swaps/{swapId}/cancel/submit'],
  ['Swap', 'GET', '/v1/activity'],
  ['Liquidity', 'POST', '/v1/lp/deposit/quote'],
  ['Liquidity', 'POST', '/v1/lp/deposit/prepare'],
  ['Liquidity', 'POST', '/v1/lp/deposit/submit'],
  ['Liquidity', 'GET', '/v1/lp/deposit/{depositId}'],
  ['Liquidity', 'POST', '/v1/lp/deposit/{depositId}/cancel/prepare'],
  ['Liquidity', 'POST', '/v1/lp/deposit/{depositId}/cancel/submit'],
  ['Liquidity', 'POST', '/v1/lp/withdraw/quote'],
  ['Liquidity', 'POST', '/v1/lp/withdraw/prepare'],
  ['Liquidity', 'POST', '/v1/lp/withdraw/submit'],
  ['Liquidity', 'GET', '/v1/lp/withdraw/{withdrawalId}'],
  ['Liquidity', 'POST', '/v1/lp/withdraw/{withdrawalId}/cancel/prepare'],
  ['Liquidity', 'POST', '/v1/lp/withdraw/{withdrawalId}/cancel/submit'],
  ['Liquidity', 'GET', '/v1/lp/positions'],
  ['Settlement', 'GET', '/v1/admin/settlement-requests'],
  ['Settlement', 'GET', '/v1/admin/settlements'],
  ['Settlement', 'GET', '/v1/admin/settlements/{settlementId}'],
  ['Settlement', 'POST', '/v1/admin/pools/{poolId}/settlements'],
  ['Settlement', 'GET', '/v1/admin/pools/{poolId}/settlement-preview'],
  ['Settlement', 'PUT', '/v1/admin/pools/{poolId}/settlement-requests/{type}/{requestId}/deferred'],
  ['Settlement', 'GET', '/v1/admin/pools/{poolId}/settlement-history'],
  ['Settlement', 'GET', '/v1/admin/pools/{poolId}/settlement-policy/{type}'],
  ['Settlement', 'PUT', '/v1/admin/pools/{poolId}/settlement-policy/{type}'],
  ['Settlement', 'GET', '/v1/admin/monitoring'],
].map(([module, method, path]) => ({ module, method, path }));

export const HEALTH_ROUTES = [
  { module: 'Health', method: 'GET', path: '/actuator/health' },
  { module: 'Health', method: 'GET', path: '/actuator/health/readiness' },
  { module: 'Health', method: 'GET', path: '/actuator/health/liveness' },
];

const ALL_ROUTES = [...BUSINESS_ROUTES, ...HEALTH_ROUTES].map((route) => ({
  ...route,
  pattern: new RegExp(`^${route.path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
}));

/** The declared route a request reaches, or null for an undeclared method and path. */
export function routeOf(method, url) {
  const pathname = url.split('?')[0];
  const route = ALL_ROUTES.find((candidate) => candidate.method === method && candidate.pattern.test(pathname));
  return route ? `${route.method} ${route.path}` : null;
}
