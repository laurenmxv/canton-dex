import type { DexClient } from './port';
import type {
  CreateProposalInput,
  Onboarding,
  Instrument,
  Pool,
  PoolApprover,
  PoolProposal,
  QuoteInput,
  Role,
  SwapPreparation,
  SwapQuote,
  SwapRequest,
} from './types';

/** A fixture actor the demo can act as. Real sessions come from an identity provider. */
export interface Identity {
  accountId: string;
  displayName: string;
  role: Role;
  /** Party pre-provisioned on the participant-test node, never a wallet key. */
  fixturePartyId: string;
}

/**
 * Controls that exist only because this is a demo. They have no counterpart in
 * the real API and reach only the identity switcher and the counterparty
 * approval panel.
 */
export interface DemoControls {
  listIdentities(): Promise<Identity[]>;
  /** Stands in for another organization approving on its own participant. */
  approveAsCounterparty(proposalId: string, approver: PoolApprover): Promise<PoolProposal>;
  /** Clears every fixture request, proposal and pool back to the seed. */
  reset(): Promise<void>;
}

/**
 * Pool operations no route serves. The venue's own catalogue lives on
 * `DexClient.pools`; everything richer than a name is the demo's invention.
 */
export interface DemoPoolsApi {
  list(): Promise<Pool[]>;
  listInstruments(): Promise<Instrument[]>;
  listProposals(): Promise<PoolProposal[]>;
  getProposal(proposalId: string): Promise<PoolProposal>;
  createProposal(input: CreateProposalInput): Promise<PoolProposal>;
  requestCreation(proposalId: string): Promise<PoolProposal>;
}

export interface DemoSwapsApi {
  /** Pools the caller may trade, from their approved onboarding. */
  eligiblePools(): Promise<Pool[]>;
  requestQuote(input: QuoteInput): Promise<SwapQuote>;
  prepare(quoteId: string): Promise<SwapPreparation>;
  /** Signing happens below this seam, never in a screen. */
  submit(preparationId: string): Promise<SwapRequest>;
  listRequests(): Promise<SwapRequest[]>;
}

/** What the demo does instead of opening a wallet. */
export interface DemoOnboardingApi {
  /**
   * Registers the caller's party with a key and a signature the demo invents.
   * The real path asks a wallet, which the demo has none of.
   */
  registerParty(onboardingId: string): Promise<Onboarding>;
}

/**
 * Everything the demo serves that the venue does not. A screen reaching for
 * this is a screen the real mode does not show.
 */
export interface DemoApi {
  readonly pools: DemoPoolsApi;
  readonly swaps: DemoSwapsApi;
  readonly onboarding: DemoOnboardingApi;
}

/** One fixture actor's two surfaces: what the venue would serve, and the rest. */
export interface BoundDemoClient {
  readonly client: DexClient;
  readonly demo: DemoApi;
}

/**
 * What the composition point wires up: one shared demo world, plus the surfaces
 * bound to whichever actor the session is currently acting as.
 */
export interface DexBackend {
  readonly controls: DemoControls;
  /** Null when no fixture actor matches, so no role is ever assumed. */
  clientFor(accountId: string): BoundDemoClient | null;
}
