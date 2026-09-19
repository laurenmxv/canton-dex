import { segment, type Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { Onboarding, PartyPreparationInput } from '../../types/onboarding.js';

/**
 * Ask the venue to prepare an external party for the caller's own public key,
 * and return the whole record with its `party` field filled in.
 *
 * Only an approved onboarding can prepare. Repeating the call with the same key
 * returns the same preparation; a different key answers 409. The private half
 * of the key never leaves the trader's signer, so it is not a parameter here.
 */
export async function prepareParty(
  send: Send,
  onboardingId: string,
  input: PartyPreparationInput,
  options?: RequestOptions,
): Promise<Onboarding> {
  return send<Onboarding>(
    {
      method: 'POST',
      path: `/v1/onboardings/${segment(onboardingId)}/party/prepare`,
      body: input,
    },
    options,
  );
}
