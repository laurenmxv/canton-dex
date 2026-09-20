import type { DexClient } from '../lib/api/port';

/** An operation the test under way never reaches, and fails loudly if it does. */
function unused(name: string) {
  return () => Promise.reject(new Error(`${name} is not part of this test`));
}

/**
 * A complete client whose every operation is refused, with the few a test needs
 * supplied.
 *
 * The port is the whole backend surface, so a literal would have to name every
 * operation to satisfy it, and each test would then have to grow whenever the
 * venue gains a route it does not exercise.
 */
export function testClient(parts: {
  me?: DexClient['me'];
  onboarding?: Partial<DexClient['onboarding']>;
  pools?: Partial<DexClient['pools']>;
  swaps?: Partial<DexClient['swaps']>;
  tokens?: Partial<DexClient['tokens']>;
  admin?: Partial<Omit<DexClient['admin'], 'settlements'>>;
  settlements?: Partial<DexClient['admin']['settlements']>;
}): DexClient {
  return {
    me: parts.me ?? unused('me'),
    onboarding: {
      mine: unused('onboarding.mine'),
      submitApplication: unused('onboarding.submitApplication'),
      get: unused('onboarding.get'),
      prepareParty: unused('onboarding.prepareParty'),
      confirmParty: unused('onboarding.confirmParty'),
      ...parts.onboarding,
    },
    pools: {
      list: unused('pools.list'),
      get: unused('pools.get'),
      ...parts.pools,
    },
    swaps: {
      quote: unused('swaps.quote'),
      prepare: unused('swaps.prepare'),
      submit: unused('swaps.submit'),
      get: unused('swaps.get'),
      prepareCancellation: unused('swaps.prepareCancellation'),
      submitCancellation: unused('swaps.submitCancellation'),
      activity: unused('swaps.activity'),
      ...parts.swaps,
    },
    tokens: {
      balances: unused('tokens.balances'),
      faucetStatus: unused('tokens.faucetStatus'),
      prepareFaucetClaim: unused('tokens.prepareFaucetClaim'),
      submitFaucetClaim: unused('tokens.submitFaucetClaim'),
      ...parts.tokens,
    },
    admin: {
      listOnboardings: unused('admin.listOnboardings'),
      reviewOnboarding: unused('admin.reviewOnboarding'),
      poolCreationOptions: unused('admin.poolCreationOptions'),
      listPoolProposals: unused('admin.listPoolProposals'),
      createPoolProposal: unused('admin.createPoolProposal'),
      getPoolProposal: unused('admin.getPoolProposal'),
      withdrawPoolProposal: unused('admin.withdrawPoolProposal'),
      listPools: unused('admin.listPools'),
      ...parts.admin,
      settlements: {
        requests: unused('admin.settlements.requests'),
        list: unused('admin.settlements.list'),
        get: unused('admin.settlements.get'),
        run: unused('admin.settlements.run'),
        policy: unused('admin.settlements.policy'),
        updatePolicy: unused('admin.settlements.updatePolicy'),
        monitoring: unused('admin.settlements.monitoring'),
        ...parts.settlements,
      },
    },
  };
}
