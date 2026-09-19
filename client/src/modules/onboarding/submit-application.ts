import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { Onboarding, OnboardingApplicationInput } from '../../types/onboarding.js';

/**
 * Register the caller's onboarding request. Traders only, one per account.
 *
 * The documents are metadata for files the venue would ask for; no bytes are
 * sent, and the backend marks every entry simulated. The created record starts
 * at `AWAITING_REVIEW_AND_PARTY` with no review, no party and no ledger steps.
 */
export async function submitApplication(
  send: Send,
  input: OnboardingApplicationInput,
  options?: RequestOptions,
): Promise<Onboarding> {
  return send<Onboarding>({ method: 'POST', path: '/v1/onboardings', body: input }, options);
}
