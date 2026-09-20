import { DexClientError as ApiError } from '@canton-dex/client';
import type { DexClient } from './port';
import { DomainError, type DexErrorCode } from './types';

/** Every status the backend's Problem Details filter turns into a rule. */
const codeByStatus: Record<number, DexErrorCode> = {
  400: 'VALIDATION',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  // The participant is temporarily out of reach. A read may be tried again;
  // nothing the venue was asked to submit is known to have failed.
  503: 'UNAVAILABLE',
};

/** What a reader is told when the venue gives no Problem Details of its own. */
function fallbackMessage(error: ApiError): string {
  switch (error.kind) {
    case 'authentication':
      return 'Your session has no access token. Sign in again.';
    case 'network':
      return 'The venue could not be reached.';
    case 'response':
      return 'The venue sent a reply this app could not read.';
    case 'http':
      // 401 is the one unmapped status a reader can act on themselves.
      if (error.status === 401) return 'Your session is no longer valid. Sign in again.';
      return `The venue reported an error (HTTP ${error.status ?? 'unknown'}).`;
  }
}

/**
 * Turns an SDK error into the one the screens already branch on, so a real
 * failure and a fixture failure reach the reader the same way. A cancellation
 * is not an SDK error and passes straight through.
 */
async function translate<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (cause) {
    if (!(cause instanceof ApiError)) throw cause;
    const detail = cause.problem?.detail;
    const code = cause.status === undefined ? undefined : codeByStatus[cause.status];
    if (code) {
      throw new DomainError(detail ?? fallbackMessage(cause), code, cause.problem?.code, { cause });
    }
    // No rule to name, so the status stays in the message a reader or a log sees.
    const message =
      detail === undefined
        ? fallbackMessage(cause)
        : cause.status === undefined
          ? detail
          : `${detail} (HTTP ${cause.status})`;
    throw new Error(message, { cause });
  }
}

/**
 * The venue's client, speaking the webapp's error vocabulary.
 *
 * It adds nothing else: every method is the SDK's, so no screen can reach an
 * operation the backend does not serve.
 */
export function venueClient(api: DexClient): DexClient {
  return {
    me: (options) => translate(api.me(options)),
    onboarding: {
      mine: (options) => translate(api.onboarding.mine(options)),
      submitApplication: (input, options) =>
        translate(api.onboarding.submitApplication(input, options)),
      get: (onboardingId, options) => translate(api.onboarding.get(onboardingId, options)),
      prepareParty: (onboardingId, input, options) =>
        translate(api.onboarding.prepareParty(onboardingId, input, options)),
      confirmParty: (onboardingId, input, options) =>
        translate(api.onboarding.confirmParty(onboardingId, input, options)),
    },
    pools: {
      list: (options) => translate(api.pools.list(options)),
      get: (poolId, options) => translate(api.pools.get(poolId, options)),
    },
    swaps: {
      quote: (input, options) => translate(api.swaps.quote(input, options)),
      prepare: (input, options) => translate(api.swaps.prepare(input, options)),
      submit: (input, options) => translate(api.swaps.submit(input, options)),
      get: (swapId, options) => translate(api.swaps.get(swapId, options)),
      prepareCancellation: (swapId, options) =>
        translate(api.swaps.prepareCancellation(swapId, options)),
      submitCancellation: (swapId, input, options) =>
        translate(api.swaps.submitCancellation(swapId, input, options)),
      activity: (query, options) => translate(api.swaps.activity(query, options)),
    },
    tokens: {
      balances: (options) => translate(api.tokens.balances(options)),
      faucetStatus: (options) => translate(api.tokens.faucetStatus(options)),
      prepareFaucetClaim: (options) => translate(api.tokens.prepareFaucetClaim(options)),
      submitFaucetClaim: (input, options) =>
        translate(api.tokens.submitFaucetClaim(input, options)),
    },
    admin: {
      listOnboardings: (options) => translate(api.admin.listOnboardings(options)),
      reviewOnboarding: (onboardingId, input, options) =>
        translate(api.admin.reviewOnboarding(onboardingId, input, options)),
      poolCreationOptions: (options) => translate(api.admin.poolCreationOptions(options)),
      listPoolProposals: (options) => translate(api.admin.listPoolProposals(options)),
      createPoolProposal: (input, options) => translate(api.admin.createPoolProposal(input, options)),
      getPoolProposal: (proposalId, options) =>
        translate(api.admin.getPoolProposal(proposalId, options)),
      withdrawPoolProposal: (proposalId, options) =>
        translate(api.admin.withdrawPoolProposal(proposalId, options)),
      listPools: (options) => translate(api.admin.listPools(options)),
      settlements: {
        requests: (poolId, status, options) =>
          translate(api.admin.settlements.requests(poolId, status, options)),
        list: (poolId, options) => translate(api.admin.settlements.list(poolId, options)),
        get: (settlementId, options) =>
          translate(api.admin.settlements.get(settlementId, options)),
        run: (poolId, input, options) =>
          translate(api.admin.settlements.run(poolId, input, options)),
        policy: (poolId, options) => translate(api.admin.settlements.policy(poolId, options)),
        updatePolicy: (poolId, input, options) =>
          translate(api.admin.settlements.updatePolicy(poolId, input, options)),
        monitoring: (poolId, options) =>
          translate(api.admin.settlements.monitoring(poolId, options)),
      },
    },
  };
}
