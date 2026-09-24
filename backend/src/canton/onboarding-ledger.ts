import {
  ACCESS_STEP_PREFIX,
  ATTESTATION_STEP,
  type Confirmation,
  type LedgerStep,
  type Onboarding,
} from '../onboarding/model.js';
import type { OnboardingLedger } from '../onboarding/ports.js';
import { access, attestation, sameAccess, sameAttestation, type Access, type Attestation } from './contracts.js';
import type { Ledger, Transaction } from './ledger.js';
import { byName, DEX_PACKAGE_ID, isExactly, KycAttestation, PoolAccess, type DamlName } from './packages.js';

/** Checks that the transaction created exactly the expected operator-signed contract. */
function confirm(
  tx: Transaction,
  template: DamlName,
  matches: (payload: unknown) => boolean,
  issuer: string,
  trader: string,
): Confirmation {
  const [event] = tx.events;
  if (tx.events.length !== 1 || !event || !('created' in event)) {
    throw new Error('Unexpected onboarding transaction effects');
  }
  const created = event.created;
  if (
    !isExactly(created.templateId, template) ||
    created.signatories.length !== 1 ||
    created.signatories[0] !== issuer ||
    !created.observers.includes(trader)
  ) {
    throw new Error('Unexpected onboarding contract authority');
  }
  if (!matches(created.createArgument)) throw new Error('Onboarding command payload differs');
  return { contractId: created.contractId, updateId: tx.updateId, issuer };
}

/** The operator's KYC attestation and pool access contracts. */
export class CantonOnboardingLedger implements OnboardingLedger {
  readonly packageId = DEX_PACKAGE_ID;

  constructor(private readonly ledger: Ledger) {}

  ledgerEnd(): Promise<bigint> {
    return this.ledger.ledgerEnd();
  }

  async attest(commandId: string, trader: string, poolIds: readonly string[]): Promise<Confirmation> {
    const issuer = await this.ledger.primaryParty();
    const expected: Attestation = { venueOperator: issuer, trader, pools: [...poolIds] };
    const tx = await this.ledger.submit(
      commandId,
      issuer,
      [],
      [{ CreateCommand: { templateId: byName(KycAttestation), createArguments: expected } }],
    );
    return confirm(tx, KycAttestation, (payload) => sameAttestation(expected, attestation(payload)), issuer, trader);
  }

  async grantAccess(commandId: string, trader: string, poolId: string, attestationId: string): Promise<Confirmation> {
    const issuer = await this.ledger.primaryParty();
    const expected: Access = { venueOperator: issuer, trader, poolCid: poolId, attestationCid: attestationId };
    const tx = await this.ledger.submit(
      commandId,
      issuer,
      [],
      [{ CreateCommand: { templateId: byName(PoolAccess), createArguments: expected } }],
    );
    return confirm(tx, PoolAccess, (payload) => sameAccess(expected, access(payload)), issuer, trader);
  }

  async recover(
    beginOffset: bigint,
    step: LedgerStep,
    onboarding: Onboarding,
    attestationId: string | null,
  ): Promise<Confirmation | undefined> {
    const issuer = await this.ledger.primaryParty();
    const trader = onboarding.party?.partyId;
    if (trader === undefined) throw new Error('Onboarding has no registered party');
    const transactions = (await this.ledger.transactions(beginOffset, issuer)).filter(
      (tx) => tx.commandId === step.commandId,
    );
    const [tx] = transactions;
    if (!tx) return undefined;
    if (transactions.length !== 1) throw new Error('Multiple transactions for the onboarding command');
    if (step.key === ATTESTATION_STEP) {
      const expected: Attestation = { venueOperator: issuer, trader, pools: onboarding.review?.approvedPoolIds ?? [] };
      return confirm(tx, KycAttestation, (payload) => sameAttestation(expected, attestation(payload)), issuer, trader);
    }
    const expected: Access = {
      venueOperator: issuer,
      trader,
      poolCid: step.key.slice(ACCESS_STEP_PREFIX.length),
      attestationCid: attestationId ?? '',
    };
    return confirm(tx, PoolAccess, (payload) => sameAccess(expected, access(payload)), issuer, trader);
  }
}
