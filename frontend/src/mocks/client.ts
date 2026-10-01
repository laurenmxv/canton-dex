import type { DemoControls, BoundDemoClient, DexBackend } from '../lib/api/demo';
import { DomainError, type Onboarding } from '../lib/api/types';
import * as demo from './store';
import type { DemoState } from './store';

const VENUE_SETTLEMENT_QUEUE = 'a venue settlement queue';
const VENUE_SETTLEMENTS = 'venue settlements';
const VENUE_QUEUE_POLICY = 'a settlement queue policy';
const VENUE_PREVIEWS = 'venue batch previews';

export interface FixtureBackendOptions {
  /** Simulated round trip. Set to 0 in tests. */
  latencyMs?: number;
  state?: DemoState;
}

/**
 * A venue operation this demo world does not serve.
 *
 * Pools here are created by the demo's own three-approval flow, which is a
 * different thing from the venue's proposals, so nothing maps onto these
 * routes. No screen in demo mode calls one; if one ever did, it would say so
 * rather than answer with something invented.
 */
function absent<T>(operation: string): () => Promise<T> {
  return () =>
    Promise.reject(new DomainError(`The demo does not serve ${operation}`, 'NOT_FOUND'));
}

/** Returned values are copies, so screens can never mutate demo state in place. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * The only implementation behind the port today. Everything it returns is
 * simulated, and the screens label it as such.
 *
 * `clientFor` binds the domain surface to one actor, the way a token binds the
 * real backend. Every client shares one demo world, so switching identity
 * keeps requests, proposals and pools coherent. Ownership and role checks live
 * in the store, so the fixture refuses anything the real backend refuses.
 */
export function createFixtureBackend(options: FixtureBackendOptions = {}): DexBackend {
  const latencyMs = options.latencyMs ?? 260;
  let state = options.state ?? demo.seededDemoState();

  async function settle<T>(produce: () => T): Promise<T> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return copy(produce());
  }

  /** Reads advance the ledger, so confirmations arrive while a screen polls. */
  function advanced(onboarding: Onboarding): Onboarding {
    demo.tickLedger(state, onboarding);
    onboarding.status = demo.deriveStatus(onboarding);
    return onboarding;
  }

  const controls: DemoControls = {
    listIdentities: () => settle(() => state.identities),
    approveAsCounterparty: (proposalId, approver) =>
      settle(() => demo.approveProposal(state, proposalId, approver)),
    reset: async () => {
      state = demo.seededDemoState();
    },
  };

  function clientFor(accountId: string): BoundDemoClient | null {
    if (!state.identities.some((identity) => identity.accountId === accountId)) return null;

    return {
      client: {
        me: () => settle(() => demo.profileOf(state, accountId)),
        activity: absent('the venue request history'),

        onboarding: {
          mine: () =>
            settle(() => {
              const found = demo.findOnboardingForAccount(state, accountId);
              return found ? advanced(found) : null;
            }),
          submitApplication: (application) =>
            settle(() => demo.submitApplication(state, accountId, application)),
          get: (onboardingId) =>
            settle(() => advanced(demo.findOwnedOnboarding(state, accountId, onboardingId))),
          prepareParty: (onboardingId, input) =>
            settle(() => demo.prepareParty(state, accountId, onboardingId, input)),
          confirmParty: (onboardingId, input) =>
            settle(() => demo.confirmParty(state, accountId, onboardingId, input)),
        },

        pools: {
          list: () => settle(() => demo.poolCatalogue(state, accountId)),
          get: absent('a pool of its own'),
          marketData: absent('venue market data'),
        },

        // The demo signs nothing and settles nothing, so it serves none of the
        // venue's swap, liquidity, balance or settlement routes. Its own simulated swap
        // flow lives under `demo.swaps`, where a screen can see what it is.
        swaps: {
          quote: absent('venue quotes'),
          prepare: absent('venue swap preparations'),
          submit: absent('signed swap submissions'),
          get: absent('a venue swap record'),
          prepareCancellation: absent('venue withdrawal preparations'),
          submitCancellation: absent('signed withdrawals'),
          activity: absent('the venue swap history'),
        },

        lp: {
          quoteDeposit: absent('venue deposit quotes'),
          prepareDeposit: absent('venue deposit preparations'),
          submitDeposit: absent('signed deposits'),
          getDeposit: absent('a venue deposit record'),
          quoteWithdrawal: absent('venue withdrawal quotes'),
          prepareWithdrawal: absent('venue withdrawal preparations'),
          submitWithdrawal: absent('signed withdrawals'),
          getWithdrawal: absent('a venue withdrawal record'),
          positions: absent('LP positions'),
          deposits: absent('the venue deposit history'),
          withdrawals: absent('the venue withdrawal history'),
          prepareDepositCancellation: absent('venue recovery preparations'),
          submitDepositCancellation: absent('signed recoveries'),
          prepareWithdrawalCancellation: absent('venue recovery preparations'),
          submitWithdrawalCancellation: absent('signed recoveries'),
        },

        tokens: {
          balances: absent('ledger balances'),
          faucetStatus: absent('the development faucet'),
          prepareFaucetClaim: absent('the development faucet'),
          submitFaucetClaim: absent('the development faucet'),
        },

        admin: {
          listOnboardings: () => settle(() => demo.listOnboardings(state, accountId).map(advanced)),
          reviewOnboarding: (onboardingId, decision) =>
            settle(() => demo.reviewOnboarding(state, accountId, onboardingId, decision)),
          poolCreationOptions: absent('pool creation options'),
          listPoolProposals: absent('the venue pool proposals'),
          createPoolProposal: absent('venue pool proposals'),
          getPoolProposal: absent('the venue pool proposals'),
          withdrawPoolProposal: absent('venue pool proposals'),
          listPools: absent('the venue pool records'),
          settlements: {
            requests: absent(VENUE_SETTLEMENT_QUEUE),
            setDeferred: absent(VENUE_SETTLEMENT_QUEUE),
            preview: absent(VENUE_PREVIEWS),
            previewRequest: absent(VENUE_PREVIEWS),
            list: absent(VENUE_SETTLEMENTS),
            history: absent(VENUE_SETTLEMENTS),
            get: absent('a venue settlement'),
            run: absent('venue batches'),
            policy: absent(VENUE_QUEUE_POLICY),
            updatePolicy: absent(VENUE_QUEUE_POLICY),
            monitoring: absent('venue monitoring'),
          },
        },
      },

      demo: {
        onboarding: {
          registerParty: (onboardingId) =>
            settle(() => demo.simulatePartyRegistration(state, accountId, onboardingId)),
        },

        pools: {
          list: () => settle(() => state.pools),
          listInstruments: () => settle(() => state.instruments),
          listProposals: () => settle(() => state.proposals),
          getProposal: (proposalId) => settle(() => demo.findProposal(state, proposalId)),
          createProposal: (input) => settle(() => demo.createProposal(state, accountId, input)),
          requestCreation: (proposalId) =>
            settle(() => demo.requestPoolCreation(state, accountId, proposalId)),
        },

        swaps: {
          eligiblePools: () => settle(() => demo.eligiblePools(state, accountId)),
          requestQuote: (input) => settle(() => demo.quoteSwap(state, accountId, input)),
          prepare: (quoteId) => settle(() => demo.prepareSwap(state, accountId, quoteId)),
          submit: (preparationId) => settle(() => demo.submitSwap(state, accountId, preparationId)),
          listRequests: () => settle(() => demo.swapRequestsFor(state, accountId)),
        },
      },
    };
  }

  return { controls, clientFor };
}
