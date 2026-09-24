import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LedgerRejected } from '../../../src/canton/http.js';
import type { Account } from '../../../src/iam/accounts.js';
import type { Confirmation, LedgerStep, Onboarding, StepStatus } from '../../../src/onboarding/model.js';
import type { OnboardingLedger } from '../../../src/onboarding/ports.js';
import { OnboardingWorkflow } from '../../../src/onboarding/workflow.js';
import { NotFound } from '../../../src/platform/errors.js';
import { APPLICATION, party, PartiesDouble, ProgressDouble, SILENT_LOG } from './progress.js';

class LostResponseLedger implements OnboardingLedger {
  readonly packageId = 'package';
  submissions = 0;
  accesses = 0;
  evidence = false;

  ledgerEnd(): Promise<bigint> {
    return Promise.resolve(42n);
  }

  attest(): Promise<Confirmation> {
    this.submissions += 1;
    return Promise.reject(new Error('Injected loss after ledger acceptance'));
  }

  grantAccess(_commandId: string, _trader: string, _pool: string, attestation: string): Promise<Confirmation> {
    expect(attestation).toBe('confirmed-attestation');
    this.accesses += 1;
    return Promise.resolve({ contractId: 'confirmed-access', updateId: 'update-access', issuer: 'operator' });
  }

  recover(offset: bigint, step: LedgerStep): Promise<Confirmation | undefined> {
    expect(offset).toBe(42n);
    expect(step.key).toBe('attestation');
    return Promise.resolve(
      this.evidence
        ? { contractId: 'confirmed-attestation', updateId: 'update-attestation', issuer: 'operator' }
        : undefined,
    );
  }
}

/** Durable ledger-step progress of one approved onboarding with a confirmed party. */
class StoredProgress extends ProgressDouble {
  readonly id = randomUUID();
  readonly steps: LedgerStep[] = [
    { key: 'attestation', commandId: randomUUID(), status: 'PENDING', contractId: null, updateId: null, issuer: null },
    { key: 'access:pool', commandId: randomUUID(), status: 'PENDING', contractId: null, updateId: null, issuer: null },
  ];
  offset: bigint | null = null;

  override pending(): Promise<readonly string[]> {
    return Promise.resolve([this.id]);
  }

  override get(): Promise<Onboarding> {
    return Promise.resolve({
      id: this.id,
      accountId: randomUUID(),
      application: APPLICATION,
      status: 'LEDGER_PENDING',
      partyMode: 'external',
      createdAt: '1970-01-01T00:00:00Z',
      review: {
        decision: 'APPROVED',
        approvedPoolIds: ['pool'],
        reviewedBy: randomUUID(),
        reviewedAt: '1970-01-01T00:00:00Z',
        partyHint: 'david',
      },
      party: party('CONFIRMED', { partyId: 'david' }),
      ledgerSteps: this.steps.map((step) => ({ ...step })),
      suggestedPartyHint: 'david',
    });
  }

  override claim(_id: string, step: LedgerStep, beginOffset: bigint): Promise<boolean> {
    this.offset = beginOffset;
    this.replace(step, 'SUBMITTING');
    return Promise.resolve(true);
  }

  override beginOffset(): Promise<bigint | null> {
    return Promise.resolve(this.offset);
  }

  override unresolved(_id: string, step: LedgerStep): Promise<void> {
    this.replace(step, 'UNRESOLVED');
    return Promise.resolve();
  }

  override confirmed(_id: string, step: LedgerStep, result: Confirmation): Promise<void> {
    this.replace(step, 'CONFIRMED', result);
    return Promise.resolve();
  }

  private replace(step: LedgerStep, status: StepStatus, result?: Confirmation): void {
    const index = step.key === 'attestation' ? 0 : 1;
    this.steps[index] = {
      ...step,
      status,
      contractId: result?.contractId ?? null,
      updateId: result?.updateId ?? null,
      issuer: result?.issuer ?? null,
    };
  }
}

/** One onboarding whose party registration is interrupted in `status`. */
class RegistrationProgress extends ProgressDouble {
  readonly id = randomUUID();
  readonly owner: Account = {
    id: randomUUID(),
    issuer: 'issuer',
    subject: 'david',
    displayName: 'David',
    role: 'TRADER',
  };

  constructor(private status: 'SUBMITTING' | 'UNRESOLVED') {
    super();
  }

  override mine(caller: Account): Promise<Onboarding | null> {
    return this.getOwned(this.id, caller);
  }

  override getOwned(requested: string, caller: Account): Promise<Onboarding> {
    if (requested !== this.id || caller !== this.owner) return Promise.reject(new NotFound());
    return this.get();
  }

  override pending(): Promise<readonly string[]> {
    return Promise.resolve([this.id]);
  }

  override unresolvedParty(): Promise<void> {
    if (this.status === 'SUBMITTING') this.status = 'UNRESOLVED';
    return Promise.resolve();
  }

  override get(): Promise<Onboarding> {
    return Promise.resolve({
      id: this.id,
      accountId: this.owner.id,
      application: APPLICATION,
      status: `PARTY_${this.status}`,
      partyMode: 'external',
      createdAt: '1970-01-01T00:00:00Z',
      review: null,
      party: party(this.status),
      ledgerSteps: [],
      suggestedPartyHint: 'david',
    });
  }
}

/** A party lookup that never confirms, optionally failing. */
class UnconfirmedParty extends PartiesDouble {
  failure: Error | undefined;
  lookups = 0;

  override confirmed(): Promise<boolean> {
    this.lookups += 1;
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(false);
  }
}

describe('onboarding workflow', () => {
  it('blocks access after a lost attestation response, and a new worker recovers without resubmitting', async () => {
    const store = new StoredProgress();
    const ledger = new LostResponseLedger();
    await new OnboardingWorkflow(store, ledger, new PartiesDouble(), SILENT_LOG).reconcile();
    expect(store.steps[0]?.status).toBe('UNRESOLVED');
    expect(ledger.accesses).toBe(0);
    expect(ledger.submissions).toBe(1);
    ledger.evidence = true;
    // The worker is stateless; a replacement starts exclusively from durable progress.
    await new OnboardingWorkflow(store, ledger, new PartiesDouble(), SILENT_LOG).reconcile();
    expect(ledger.submissions).toBe(1);
    expect(ledger.accesses).toBe(1);
    expect(store.steps.every((step) => step.status === 'CONFIRMED')).toBe(true);
    expect(store.steps[0]?.contractId).toBe('confirmed-attestation');
  });

  it('never resends or advances dependent permissions on inconclusive evidence', async () => {
    const store = new StoredProgress();
    const ledger = new LostResponseLedger();
    const worker = new OnboardingWorkflow(store, ledger, new PartiesDouble(), SILENT_LOG);
    for (let pass = 0; pass < 4; pass += 1) await worker.reconcile();
    expect(ledger.submissions).toBe(1);
    expect(ledger.accesses).toBe(0);
    expect(store.steps[0]?.status).toBe('UNRESOLVED');
    expect(store.steps[1]?.status).toBe('PENDING');
  });

  it('keeps owned reads unresolved after a failed party lookup, without advancing the ledger', async () => {
    for (const initial of ['SUBMITTING', 'UNRESOLVED'] as const) {
      const store = new RegistrationProgress(initial);
      const ledger = new LostResponseLedger();
      const parties = new UnconfirmedParty();
      parties.failure = new LedgerRejected(403, 'NA', 7, 'A security-sensitive error has been received');
      const workflow = new OnboardingWorkflow(store, ledger, parties, SILENT_LOG);

      const mine = await workflow.mine(store.owner, 'fresh-owner-token');
      expect(mine?.id).toBe(store.id);
      expect(mine?.party?.status).toBe('UNRESOLVED');
      expect(mine?.party?.confirmed).toBe(false);
      expect((await workflow.getOwned(store.id, store.owner, 'next-owner-token')).party?.status).toBe('UNRESOLVED');
      await workflow.reconcile();
      expect(parties.lookups).toBe(2);
      expect(ledger.submissions).toBe(0);
      expect(ledger.accesses).toBe(0);
      expect(mine?.ledgerSteps).toEqual([]);

      const stranger: Account = {
        id: randomUUID(),
        issuer: 'issuer',
        subject: 'bob',
        displayName: 'Bob',
        role: 'TRADER',
      };
      await expect(workflow.getOwned(store.id, stranger, 'foreign-token')).rejects.toBeInstanceOf(NotFound);
      expect(parties.lookups).toBe(2);
    }
  });

  it('also marks an interrupted submission unresolved after an inconclusive party lookup', async () => {
    const store = new RegistrationProgress('SUBMITTING');
    const ledger = new LostResponseLedger();
    const workflow = new OnboardingWorkflow(store, ledger, new UnconfirmedParty(), SILENT_LOG);
    expect((await workflow.mine(store.owner, 'fresh-owner-token'))?.party?.status).toBe('UNRESOLVED');
    await workflow.reconcile();
    expect(ledger.submissions).toBe(0);
    expect(ledger.accesses).toBe(0);
  });
});
