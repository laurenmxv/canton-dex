import type { Send } from './core/http.js';
import type { RequestOptions } from './types/common.js';
import type { Profile } from './types/profile.js';

/**
 * Who the venue says the caller is, including the role it assigns them.
 *
 * A valid identity the venue has not seen before is provisioned here as a
 * trader, so this is also the call that makes a new sign-up usable.
 */
export async function getProfile(send: Send, options?: RequestOptions): Promise<Profile> {
  return send<Profile>({ method: 'GET', path: '/v1/me' }, options);
}
