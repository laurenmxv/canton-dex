import type { Account } from '../../../src/iam/accounts.js';
import type {
  Confirmation,
  LedgerStep,
  Onboarding,
  PartyPreparation,
  ReviewDecision,
} from '../../../src/onboarding/model.js';
import type {
  ExternalParties,
  OnboardingLedger,
  OnboardingProgress,
  Preparation,
} from '../../../src/onboarding/ports.js';
import type { PartySubmission } from '../../../src/onboarding/requests.js';

function unexpected(method: string): never {
  throw new Error(`Unexpected ${method}`);
}

/**
 * A durable-progress double for workflow tests; each test overrides the calls it expects.
 * PostgreSQL locking is exercised by the integration harness.
 */
export class ProgressDouble implements OnboardingProgress {
  review(_id: string, _caller: Account, _decision: ReviewDecision, _token: string): Promise<void> {
    unexpected('review');
  }
  get(_id: string): Promise<Onboarding> {
    unexpected('get');
  }
  getOwned(_id: string, _caller: Account): Promise<Onboarding> {
    unexpected('getOwned');
  }
  mine(_caller: Account): Promise<Onboarding | null> {
    unexpected('mine');
  }
  claimParty(_id: string, _caller: Account, _submission: PartySubmission): Promise<boolean> {
    unexpected('claimParty');
  }
  topology(_id: string): Promise<readonly string[]> {
    unexpected('topology');
  }
  confirmParty(_id: string): Promise<void> {
    unexpected('confirmParty');
  }
  unresolvedParty(_id: string): Promise<void> {
    unexpected('unresolvedParty');
  }
  deniedParty(_id: string): Promise<void> {
    unexpected('deniedParty');
  }
  conflictedParty(_id: string): Promise<void> {
    unexpected('conflictedParty');
  }
  pending(): Promise<readonly string[]> {
    unexpected('pending');
  }
  initializeLedgerSteps(_id: string): Promise<void> {
    return Promise.resolve();
  }
  claim(_id: string, _step: LedgerStep, _beginOffset: bigint): Promise<boolean> {
    unexpected('claim');
  }
  beginOffset(_id: string, _step: LedgerStep): Promise<bigint | null> {
    unexpected('beginOffset');
  }
  confirmed(_id: string, _step: LedgerStep, _result: Confirmation): Promise<void> {
    unexpected('confirmed');
  }
  unresolved(_id: string, _step: LedgerStep): Promise<void> {
    unexpected('unresolved');
  }
}

/** External parties that a test must not provision, prepare or allocate. */
export class PartiesDouble implements ExternalParties {
  enableUser(_operator: Account, _token: string, _account: Account): Promise<void> {
    unexpected('user provisioning');
  }
  prepare(
    _token: string,
    _hint: string,
    _key: string,
    _synchronizer: string,
    _participant: string,
  ): Promise<Preparation> {
    unexpected('party preparation');
  }
  allocate(
    _caller: Account,
    _token: string,
    _party: PartyPreparation,
    _transactions: readonly string[],
    _signature: string,
  ): Promise<void> {
    unexpected('party allocation');
  }
  confirmed(_token: string, _party: PartyPreparation): Promise<boolean> {
    unexpected('party lookup');
  }
}

/** A ledger that registration recovery must never call. */
export class LedgerDouble implements OnboardingLedger {
  readonly packageId = 'package';
  ledgerEnd(): Promise<bigint> {
    unexpected('ledger end');
  }
  attest(_commandId: string, _trader: string, _poolIds: readonly string[]): Promise<Confirmation> {
    unexpected('attestation');
  }
  grantAccess(_commandId: string, _trader: string, _poolId: string, _attestationId: string): Promise<Confirmation> {
    unexpected('pool access');
  }
  recover(
    _offset: bigint,
    _step: LedgerStep,
    _onboarding: Onboarding,
    _attestation: string | null,
  ): Promise<Confirmation | undefined> {
    unexpected('recovery');
  }
}

export const SILENT_LOG = { warn: () => undefined };

export const APPLICATION = { legalName: 'David', countryCode: 'AR', documentReferences: ['reference'], documents: [] };

export function party(status: PartyPreparation['status'], overrides: Partial<PartyPreparation> = {}): PartyPreparation {
  return {
    preparationId: 'preparation',
    partyId: 'david::key',
    confirmed: status === 'CONFIRMED',
    publicKey: 'key',
    publicKeyFingerprint: 'fingerprint',
    multiHash: 'hash',
    synchronizerId: 'synchronizer',
    status,
    participantId: 'participant',
    topologyTransactions: ['original-topology'],
    ...overrides,
  };
}
