import type { Account } from '../iam/accounts.js';
import type { Balances, Claim, Confirmation, Prepared, Registry, Signer, TestToken } from './model.js';

/** Definite proof that a test-token command has no effect. */
export class TokenRejected extends Error {}

/** The durable grant command could not be built, so no attempt was or will be sent. */
export class GrantNotSubmitted extends Error {}

/** The operator's grant command and the trader's signed claim. */
export interface TokenLedger {
  ledgerEnd(): Promise<bigint>;
  issueGrant(claim: Claim, signer: Signer): Promise<Confirmation>;
  /** The grant's committed effect, or undefined while the outcome stays unknown. */
  recoverGrant(claim: Claim, signer: Signer): Promise<Confirmation | undefined>;
  prepareClaim(claim: Claim, signer: Signer, callerToken: string, expiresAt: string): Promise<Prepared>;
  claim(claim: Claim, signer: Signer, callerToken: string, signature: string): Promise<Confirmation>;
  /** The claim's committed effect, or undefined while the outcome stays unknown. */
  recoverClaim(claim: Claim, signer: Signer): Promise<Confirmation | undefined>;
  balances(signer: Signer, callerToken: string): Promise<Balances>;
  /** Validates a wallet signature before any durable submission work. */
  verify(claim: Claim, signer: Signer, signature: string): void;
}

/** The durable faucet claims; every transition is a compare-and-set on the current attempt. */
export interface TokenProgress {
  registry(): Promise<Registry>;
  tokens(): Promise<readonly TestToken[]>;
  signer(account: Account): Promise<Signer>;
  initialize(accountId: string, partyId: string): Promise<Claim>;
  get(accountId: string): Promise<Claim | undefined>;
  claimGrant(accountId: string, offset: bigint): Promise<boolean>;
  confirmGrant(accountId: string, commandId: string, confirmation: Confirmation): Promise<void>;
  beginGrantRecovery(accountId: string, commandId: string): Promise<boolean>;
  unresolvedGrant(accountId: string, commandId: string): Promise<void>;
  savePreparation(accountId: string, preparationId: string, prepared: Prepared): Promise<boolean>;
  claimSubmission(accountId: string, preparationId: string, offset: bigint): Promise<boolean>;
  complete(accountId: string, preparationId: string, confirmation: Confirmation): Promise<void>;
  rejected(accountId: string, preparationId: string): Promise<void>;
  rejectedGrant(accountId: string, commandId: string): Promise<void>;
  /** Like `rejectedGrant`, and also for a grant under recovery, because none was ever sent. */
  excludeGrant(accountId: string, commandId: string): Promise<void>;
  unresolved(accountId: string, preparationId: string): Promise<void>;
}
