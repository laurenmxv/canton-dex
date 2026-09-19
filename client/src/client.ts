import { createSend } from './core/http.js';
import { getProfile } from './me.js';
import { createAdminApi, type AdminApi } from './modules/admin/index.js';
import { createOnboardingApi, type OnboardingApi } from './modules/onboarding/index.js';
import { createPoolsApi, type PoolsApi } from './modules/pools/index.js';
import type { DexClientConfig, RequestOptions } from './types/common.js';
import type { Profile } from './types/profile.js';

/**
 * The typed surface of the Canton DEX API.
 *
 * It covers the routes the backend serves. There is no swap, proposal,
 * instrument or notification route, so this client exposes none.
 */
export interface DexClient {
  /** Who the venue says the caller is. Roles live in its database, not in a token. */
  me(options?: RequestOptions): Promise<Profile>;
  readonly onboarding: OnboardingApi;
  readonly pools: PoolsApi;
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
    admin: createAdminApi(send),
  };
}
