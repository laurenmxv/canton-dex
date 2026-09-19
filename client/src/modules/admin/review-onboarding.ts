import { segment, type Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { Onboarding, ReviewDecisionInput } from '../../types/onboarding.js';

/**
 * Approve an onboarding for a set of pools, or reject it. Operators only.
 *
 * An approval carries at least one pool from the venue's catalogue and the
 * party hint the operator settled on, which the backend suggested and the
 * operator may have edited. A rejection carries no pools and no hint.
 *
 * The decision is immutable: repeating the identical one is accepted, a
 * different one on an already reviewed request answers 409, and an unknown
 * pool or a malformed hint answers 400.
 */
export async function reviewOnboarding(
  send: Send,
  onboardingId: string,
  input: ReviewDecisionInput,
  options?: RequestOptions,
): Promise<Onboarding> {
  return send<Onboarding>(
    {
      method: 'POST',
      path: `/v1/admin/onboardings/${segment(onboardingId)}/review`,
      body: input,
    },
    options,
  );
}
