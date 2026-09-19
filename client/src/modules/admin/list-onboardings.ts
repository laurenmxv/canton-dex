import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { Onboarding } from '../../types/onboarding.js';

/**
 * Every onboarding request, oldest first. Operators only.
 *
 * The response is a bare array, not a paged envelope, and each element is a
 * complete Onboarding rather than a summary.
 */
export async function listOnboardings(
  send: Send,
  options?: RequestOptions,
): Promise<Onboarding[]> {
  return send<Onboarding[]>({ method: 'GET', path: '/v1/admin/onboardings' }, options);
}
