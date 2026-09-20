import { createSend } from './core/http.js';
import { getProfile } from './me.js';
import { createAdminApi, type AdminApi } from './modules/admin/index.js';
import { createOnboardingApi, type OnboardingApi } from './modules/onboarding/index.js';
import { createPoolsApi, type PoolsApi } from './modules/pools/index.js';
import { createSwapsApi, type SwapsApi } from './modules/swaps/index.js';
import { createTokensApi, type TokensApi } from './modules/tokens/index.js';
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
  readonly onboarding: OnboardingApi;
  readonly pools: PoolsApi;
  readonly swaps: SwapsApi;
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
    onboarding: createOnboardingApi(send),
    pools: createPoolsApi(send),
    swaps: createSwapsApi(send),
    tokens: createTokensApi(send),
    admin: createAdminApi(send),
  };
}
