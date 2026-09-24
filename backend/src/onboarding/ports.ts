import type { Account } from '../iam/accounts.js';
import type { Confirmation, LedgerStep, Onboarding, PartyPreparation, ReviewDecision } from './model.js';
import type { PartySubmission } from './requests.js';

/** A generated external-party topology for the wallet to sign. */
export interface Preparation {
  readonly partyId: string;
  readonly fingerprint: string;
  readonly multiHash: string;
  readonly transactions: readonly string[];
  readonly participantId: string;
}

/** Wallet-authorized registration: Ledger API rights belong to the caller, never the backend. */
export interface ExternalParties {
  enableUser(operator: Account, accessToken: string, account: Account): Promise<void>;
  prepare(
    accessToken: string,
    hint: string,
    publicKey: string,
    synchronizer: string,
    participantId: string,
  ): Promise<Preparation>;
  allocate(
    caller: Account,
    accessToken: string,
    party: PartyPreparation,
    transactions: readonly string[],
    signature: string,
  ): Promise<void>;
  confirmed(accessToken: string, party: PartyPreparation): Promise<boolean>;
}

/** The operator's KYC attestation and pool access commands. */
export interface OnboardingLedger {
  readonly packageId: string;
  ledgerEnd(): Promise<bigint>;
  attest(commandId: string, trader: string, poolIds: readonly string[]): Promise<Confirmation>;
  grantAccess(commandId: string, trader: string, poolId: string, attestationId: string): Promise<Confirmation>;
  /** The command's confirmed effect since `beginOffset`, or undefined when the history has none. */
  recover(
    beginOffset: bigint,
    step: LedgerStep,
    onboarding: Onboarding,
    attestationId: string | null,
  ): Promise<Confirmation | undefined>;
}

/** The durable onboarding progress that the workflow reads and advances. */
export interface OnboardingProgress {
  review(id: string, caller: Account, decision: ReviewDecision, accessToken: string): Promise<void>;
  get(id: string): Promise<Onboarding>;
  getOwned(id: string, caller: Account): Promise<Onboarding>;
  mine(caller: Account): Promise<Onboarding | null>;
  claimParty(id: string, caller: Account, submission: PartySubmission): Promise<boolean>;
  topology(id: string): Promise<readonly string[]>;
  confirmParty(id: string): Promise<void>;
  unresolvedParty(id: string): Promise<void>;
  deniedParty(id: string): Promise<void>;
  conflictedParty(id: string): Promise<void>;
  pending(): Promise<readonly string[]>;
  initializeLedgerSteps(id: string): Promise<void>;
  claim(id: string, step: LedgerStep, beginOffset: bigint): Promise<boolean>;
  beginOffset(id: string, step: LedgerStep): Promise<bigint | null>;
  confirmed(id: string, step: LedgerStep, result: Confirmation): Promise<void>;
  unresolved(id: string, step: LedgerStep): Promise<void>;
}
