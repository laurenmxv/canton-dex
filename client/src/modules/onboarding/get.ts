import { segment, type Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { Onboarding } from '../../types/onboarding.js';

/**
 * Read one onboarding the caller owns. Traders only.
 *
 * This is not an operator lookup: the backend matches the record against the
 * calling account, so another account's request answers 404.
 */
export async function get(
  send: Send,
  onboardingId: string,
  options?: RequestOptions,
): Promise<Onboarding> {
  return send<Onboarding>(
    { method: 'GET', path: `/v1/onboardings/${segment(onboardingId)}` },
    options,
  );
}
