import type {
  CreateProposal,
  LedgerPool,
  PendingProposal,
  PoolDetail,
  Proposal,
  ProposalStatus,
  ProposalTerms,
} from './model.js';

/** Definite proof that the participant rejected a pool command. */
export class PoolRejected extends Error {
  constructor(cause: unknown) {
    super('Canton rejected the command', { cause });
  }
}

/** A proposal's confirmed ledger state: proposed (PENDING) or decided, with the created pool. */
export interface PoolConfirmation {
  readonly proposalCid: string;
  readonly status: ProposalStatus;
  readonly updateId: string;
  readonly pool: LedgerPool | null;
}

/** The operator's pool factory, proposals and pool contracts. */
export interface PoolLedger {
  readonly packageId: string;
  operator(): Promise<string>;
  offset(): Promise<bigint>;
  factory(dvo: string): Promise<string>;
  propose(proposal: Proposal, commandId: string): Promise<PoolConfirmation>;
  withdraw(proposal: Proposal, commandId: string): Promise<PoolConfirmation>;
  /** The proposal's confirmed states since its begin offset, in ledger order. */
  recover(pending: PendingProposal): Promise<PoolConfirmation[]>;
  /** The DVO's current pools, named from `names` where the venue stored a name. */
  pools(names: ReadonlyMap<string, string>, dvo: string): Promise<LedgerPool[]>;
}

/** The durable proposals and pool catalog that the workflow reads and advances. */
export interface PoolProgress {
  dvo(): Promise<string>;
  get(id: string): Promise<Proposal>;
  pending(): Promise<readonly PendingProposal[]>;
  reserve(
    id: string,
    input: CreateProposal,
    settings: ProposalTerms,
    factoryId: string,
    accountId: string,
    offset: bigint,
  ): Promise<Proposal>;
  proposed(id: string, proposalCid: string, updateId: string): Promise<void>;
  unresolved(id: string): Promise<void>;
  failedSubmission(id: string, withdrawal: boolean): Promise<void>;
  reconciliationError(id: string, failed: boolean): Promise<void>;
  finish(id: string, status: ProposalStatus, updateId: string, pool: LedgerPool | null): Promise<void>;
  claimWithdrawal(id: string, commandId: string): Promise<boolean>;
  save(pool: LedgerPool): Promise<void>;
  names(): Promise<ReadonlyMap<string, string>>;
  pools(packageId: string): Promise<readonly PoolDetail[]>;
  pool(id: string, packageId: string): Promise<PoolDetail>;
}
