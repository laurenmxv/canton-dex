import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { Onboarding } from '../../types/onboarding.js';

/**
 * The caller's own onboarding, or null before they have applied.
 *
 * Null is the venue's answer, not a missing resource: the route succeeds and
 * says there is nothing yet.
 */
export async function mine(send: Send, options?: RequestOptions): Promise<Onboarding | null> {
  return send<Onboarding | null>(
    { method: 'GET', path: '/v1/onboardings/mine', nullable: true },
    options,
  );
}
