import type { RequestOptions } from '../../types/common.js';
import type {
  Onboarding,
  OnboardingApplicationInput,
  PartyPreparationInput,
  PartySubmissionInput,
} from '../../types/onboarding.js';

/** What a trader can do with their own onboarding. */
export interface OnboardingApi {
  /** The caller's own onboarding, or null before they have applied. */
  mine(options?: RequestOptions): Promise<Onboarding | null>;
  submitApplication(
    input: OnboardingApplicationInput,
    options?: RequestOptions,
  ): Promise<Onboarding>;
  get(onboardingId: string, options?: RequestOptions): Promise<Onboarding>;
  prepareParty(
    onboardingId: string,
    input: PartyPreparationInput,
    options?: RequestOptions,
  ): Promise<Onboarding>;
  confirmParty(
    onboardingId: string,
    input: PartySubmissionInput,
    options?: RequestOptions,
  ): Promise<Onboarding>;
}
