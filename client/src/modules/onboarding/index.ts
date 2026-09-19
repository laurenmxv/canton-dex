import type { Send } from '../../core/http.js';
import { confirmParty } from './confirm-party.js';
import { get } from './get.js';
import { mine } from './mine.js';
import { prepareParty } from './prepare-party.js';
import { submitApplication } from './submit-application.js';
import type { OnboardingApi } from './types.js';

export function createOnboardingApi(send: Send): OnboardingApi {
  return {
    mine: (options) => mine(send, options),
    submitApplication: (input, options) => submitApplication(send, input, options),
    get: (onboardingId, options) => get(send, onboardingId, options),
    prepareParty: (onboardingId, input, options) =>
      prepareParty(send, onboardingId, input, options),
    confirmParty: (onboardingId, input, options) => confirmParty(send, onboardingId, input, options),
  };
}

export type { OnboardingApi } from './types.js';
