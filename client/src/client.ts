/**
 * Builds a typed client for account, catalogue and domain APIs.
 *
 * @remarks
 * me, pools and activity expose profile, catalogue and caller-history reads.
 * Onboarding, swaps, lp, tokens and admin are separate facets of the same client.
 *
 * @packageDocumentation
 */
import { listActivity } from './activity.js';
import { createSend } from './core/http.js';
import { getProfile } from './me.js';
import { createAdminApi, type AdminApi } from './modules/admin/index.js';
import { createLpApi, type LpApi } from './modules/lp/index.js';
import { createOnboardingApi, type OnboardingApi } from './modules/onboarding/index.js';
import { createPoolsApi, type PoolsApi } from './modules/pools/index.js';
import { createSwapsApi, type SwapsApi } from './modules/swaps/index.js';
import { createTokensApi, type TokensApi } from './modules/tokens/index.js';
import type { Activity, ActivityQuery } from './types/activity.js';
import type { DexClientConfig, RequestOptions } from './types/common.js';
import type { Profile } from './types/profile.js';

/**
 * The typed surface of the Canton DEX API.
 *
 * It covers the routes the backend serves and nothing else. No method here
 * prices, signs or settles anything itself: the venue quotes, the trader's
 * wallet signs, and the ledger decides.
 */
export interface DexClient {
  /** Who the venue says the caller is. Roles live in its database, not in a token. */
  me(options?: RequestOptions): Promise<Profile>;
  /** Every kind of request the caller made. `swaps` and `lp` read one kind each. */
  activity(query?: ActivityQuery, options?: RequestOptions): Promise<Activity>;
  readonly onboarding: OnboardingApi;
  readonly pools: PoolsApi;
  readonly swaps: SwapsApi;
  readonly lp: LpApi;
  readonly tokens: TokensApi;
  readonly admin: AdminApi;
}

/**
 * Builds a client bound to one base URL and one token provider.
 *
 * Nothing is shared between clients: two of them authenticate independently,
 * and neither keeps a session, a cached token or any other global state. Who
 * the caller is stays a server-side decision, read from the token.
 */
export function createDexClient(config: DexClientConfig): DexClient {
  const send = createSend(config);
  return {
    me: (options) => getProfile(send, options),
    activity: (query, options) => listActivity(send, query, options),
    onboarding: createOnboardingApi(send),
    pools: createPoolsApi(send),
    swaps: createSwapsApi(send),
    lp: createLpApi(send),
    tokens: createTokensApi(send),
    admin: createAdminApi(send),
  };
}
