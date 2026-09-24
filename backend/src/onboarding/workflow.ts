import { Mutex } from 'async-mutex';
import type { FastifyBaseLogger } from 'fastify';
import type { Account } from '../iam/accounts.js';
import { AccessDenied } from '../platform/errors.js';
import {
  ACCESS_STEP_PREFIX,
  ATTESTATION_STEP,
  PartyAlreadyExists,
  type Confirmation,
  type Onboarding,
  type PartyPreparation,
  type PartyStatus,
  type ReviewDecision,
} from './model.js';
import type { ExternalParties, OnboardingLedger, OnboardingProgress } from './ports.js';
import type { PartySubmission } from './requests.js';

const REGISTERING: readonly PartyStatus[] = ['SUBMITTING', 'UNRESOLVED'];

function registering(onboarding: Onboarding): onboarding is Onboarding & { party: PartyPreparation } {
  return onboarding.party !== null && !onboarding.party.confirmed && REGISTERING.includes(onboarding.party.status);
}

/**
 * External-party registration and the operator's attestation and access commands. A lost
 * registration or command response becomes UNRESOLVED and is reconciled from ledger evidence;
 * it is never resubmitted. The reconciliation worker holds no user token.
 */
export class OnboardingWorkflow {
  /** Registrations in flight in this process; a status poll never reconciles one of them. */
  private readonly activeRegistrations = new Map<string, number>();
  /** Serializes a poll's final check-and-update with the start of a registration. */
  private readonly registrationLock = new Mutex();

  constructor(
    private readonly store: OnboardingProgress,
    private readonly ledger: OnboardingLedger,
    private readonly parties: ExternalParties,
    private readonly log: Pick<FastifyBaseLogger, 'warn'>,
  ) {}

  async review(id: string, caller: Account, decision: ReviewDecision, accessToken: string): Promise<Onboarding> {
    await this.store.review(id, caller, decision, accessToken);
    return this.store.get(id);
  }

  async submitParty(
    id: string,
    caller: Account,
    submission: PartySubmission,
    accessToken: string,
  ): Promise<Onboarding> {
    await this.registrationLock.runExclusive(() => {
      this.activeRegistrations.set(id, (this.activeRegistrations.get(id) ?? 0) + 1);
    });
    try {
      return await this.allocateParty(id, caller, submission, accessToken);
    } finally {
      await this.registrationLock.runExclusive(() => {
        const count = this.activeRegistrations.get(id) ?? 1;
        if (count === 1) this.activeRegistrations.delete(id);
        else this.activeRegistrations.set(id, count - 1);
      });
    }
  }

  private async allocateParty(
    id: string,
    caller: Account,
    submission: PartySubmission,
    accessToken: string,
  ): Promise<Onboarding> {
    if (await this.store.claimParty(id, caller, submission)) {
      try {
        const topology = await this.store.topology(id);
        await this.parties.allocate(caller, accessToken, await this.preparedParty(id), topology, submission.signature);
        if (await this.parties.confirmed(accessToken, await this.preparedParty(id))) await this.store.confirmParty(id);
        else await this.store.unresolvedParty(id);
      } catch (error) {
        if (error instanceof PartyAlreadyExists) {
          await this.store.conflictedParty(id);
          throw error;
        }
        if (error instanceof AccessDenied) {
          await this.store.deniedParty(id);
          throw error;
        }
        await this.store.unresolvedParty(id);
        this.log.warn({ err: error, onboarding: id }, 'External party submission needs reconciliation');
      }
    }
    return this.store.getOwned(id, caller);
  }

  private async preparedParty(id: string): Promise<PartyPreparation> {
    const { party } = await this.store.get(id);
    if (!party) throw new Error('A claimed registration has no prepared party');
    return party;
  }

  async mine(caller: Account, accessToken: string): Promise<Onboarding | null> {
    const current = await this.store.mine(caller);
    return current === null ? null : this.refreshParty(current, caller, accessToken);
  }

  async getOwned(id: string, caller: Account, accessToken: string): Promise<Onboarding> {
    return this.refreshParty(await this.store.getOwned(id, caller), caller, accessToken);
  }

  /** A fresh owner request, with the owner's token, reconciles an interrupted registration. */
  private async refreshParty(current: Onboarding, caller: Account, accessToken: string): Promise<Onboarding> {
    // Wait for the allocation result before reconciling a concurrent status poll.
    if (!registering(current) || this.activeRegistrations.has(current.id)) return current;
    let confirmed = false;
    try {
      confirmed = await this.parties.confirmed(accessToken, current.party);
    } catch (error) {
      this.log.warn({ err: error, onboarding: current.id }, 'External party remains unconfirmed');
    }
    await this.finishPartyRefresh(current.id, confirmed);
    return this.store.getOwned(current.id, caller);
  }

  /** A retry may have started or finished while the Canton lookup was in flight. */
  private async finishPartyRefresh(id: string, confirmed: boolean): Promise<void> {
    await this.registrationLock.runExclusive(async () => {
      if (this.activeRegistrations.has(id)) return;
      if (!registering(await this.store.get(id))) return;
      if (confirmed) await this.store.confirmParty(id);
      else await this.store.unresolvedParty(id);
    });
  }

  /** One reconciliation pass; the worker loop never runs two at once. */
  async reconcile(): Promise<void> {
    for (const id of await this.store.pending()) {
      try {
        await this.advance(id);
      } catch (error) {
        this.log.warn({ err: error, onboarding: id }, 'Onboarding remains pending');
      }
    }
  }

  private async advance(id: string): Promise<void> {
    // A fresh owner request reconciles registration; the worker never stores user tokens.
    if ((await this.store.get(id)).party?.confirmed !== true) return;
    await this.store.initializeLedgerSteps(id);
    const current = await this.store.get(id);
    const trader = current.party?.partyId;
    const pools = current.review?.approvedPoolIds;
    if (trader === undefined || pools === undefined) return;
    let attestationId: string | null = null;
    for (const step of current.ledgerSteps) {
      if (step.status === 'CONFIRMED') {
        if (step.key === ATTESTATION_STEP) attestationId = step.contractId;
        continue;
      }
      try {
        let result: Confirmation;
        if (step.status === 'PENDING') {
          const offset = await this.ledger.ledgerEnd();
          if (!(await this.store.claim(id, step, offset))) return;
          result =
            step.key === ATTESTATION_STEP
              ? await this.ledger.attest(step.commandId, trader, pools)
              : await this.grantAccess(
                  step.commandId,
                  trader,
                  step.key.slice(ACCESS_STEP_PREFIX.length),
                  attestationId,
                );
        } else {
          const offset = await this.store.beginOffset(id, step);
          if (offset === null) return;
          const recovered = await this.ledger.recover(offset, step, current, attestationId);
          if (!recovered) {
            await this.store.unresolved(id, step);
            return;
          }
          result = recovered;
        }
        await this.store.confirmed(id, step, result);
        if (step.key === ATTESTATION_STEP) attestationId = result.contractId;
      } catch (error) {
        await this.store.unresolved(id, step);
        this.log.warn(
          { err: error, onboarding: id, command: step.commandId },
          'Onboarding command needs reconciliation',
        );
        return;
      }
    }
  }

  private async grantAccess(
    commandId: string,
    trader: string,
    poolId: string,
    attestationId: string | null,
  ): Promise<Confirmation> {
    if (attestationId === null) throw new Error('Pool access requires a confirmed attestation');
    return this.ledger.grantAccess(commandId, trader, poolId, attestationId);
  }
}
