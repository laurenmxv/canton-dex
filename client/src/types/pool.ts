/**
 * A pool in the venue's current catalogue.
 *
 * Presence here means the pool exists and an operator may approve access to
 * it. It says nothing about whether a given trader may trade it: that follows
 * from their own confirmed access on the ledger.
 */
export interface PoolSummary {
  poolId: string;
  name: string;
}

/** A Canton instrument: the admin that issues it, and that admin's own id for it. */
export interface InstrumentId {
  admin: string;
  id: string;
}

/** An account the pool holds an instrument in. The venue assigns the owner. */
export interface PoolAccount {
  owner: string;
  provider: null;
  id: string;
}

/**
 * What a pool is made of.
 *
 * Every amount is a decimal string, as the ledger stores it. None of them is
 * parsed into a JavaScript number anywhere in this client: a `Decimal` carries
 * 28 integer and 10 fractional digits, which a double cannot hold.
 */
export interface PoolTerms {
  dvv: string;
  baseInstrumentId: InstrumentId;
  quoteInstrumentId: InstrumentId;
  baseAccount: PoolAccount;
  quoteAccount: PoolAccount;
  lpTokenInstrumentId: InstrumentId;
  feeBps: string;
  baseReserve: string;
  quoteReserve: string;
  lpTokenSupply: string;
}

/**
 * What an operator proposes. The venue assigns the authority, the factory and
 * the owners, so none of them is a parameter here.
 */
export interface CreatePoolProposal {
  name: string;
  baseInstrumentId: InstrumentId;
  quoteInstrumentId: InstrumentId;
  baseAccountId: string;
  quoteAccountId: string;
  lpTokenId: string;
  feeBps: string;
  baseReserve: string;
  quoteReserve: string;
  lpTokenSupply: string;
}

/**
 * Where a proposal stands.
 *
 * `UNRESOLVED` is not a failure: the venue has not seen the outcome yet.
 * `FAILED` is, and it is final: the command was rejected, and `error` says
 * why. A `PENDING` proposal can carry an error too, from a reconciliation or a
 * refused withdrawal, without losing anything it already holds.
 */
export type PoolProposalStatus =
  | 'SUBMITTING'
  | 'PENDING'
  | 'CREATED'
  | 'REJECTED'
  | 'WITHDRAWN'
  | 'UNRESOLVED'
  | 'FAILED';

export interface PoolProposal {
  proposalId: string;
  name: string;
  settings: PoolTerms;
  status: PoolProposalStatus;
  createdAt: string;
  updatedAt: string;
  proposedBy: string;
  proposalCid: string | null;
  factoryId: string;
  poolId: string | null;
  updateId: string | null;
  error: string | null;
}

/** A pool as it exists on the ledger, with the contracts that hold it. */
export interface PoolDetail {
  poolId: string;
  name: string;
  settings: PoolTerms;
  configId: string;
  stateId: string;
  packageId: string;
  createdAt: string | null;
  updatedAt: string;
}

/** A party that issues instruments, as the venue has it configured. */
export interface InstrumentAdmin {
  partyId: string;
  label: string;
}

/** The parties a proposal is built against. The caller chooses none of them. */
export interface PoolCreationOptions {
  factoryId: string;
  dvv: string;
  venueOperator: string;
  instrumentAdmins: readonly InstrumentAdmin[];
}
