import { segment, type Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { Onboarding, PartySubmissionInput } from '../../types/onboarding.js';

/**
 * Hand the venue the signature the trader's signer produced, so it can register
 * the external party on the ledger.
 *
 * The venue checks the signature against the prepared key. A malformed or wrong
 * signature answers 400, a preparation belonging to another onboarding answers
 * 404, and a missing prerequisite answers 409. Repeating a submission that
 * already succeeded changes nothing.
 */
export async function confirmParty(
  send: Send,
  onboardingId: string,
  input: PartySubmissionInput,
  options?: RequestOptions,
): Promise<Onboarding> {
  return send<Onboarding>(
    {
      method: 'POST',
      path: `/v1/onboardings/${segment(onboardingId)}/party/submit`,
      body: input,
    },
    options,
  );
}
