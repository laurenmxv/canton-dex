import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Account } from '../../../src/iam/accounts.js';
import {
  PartyAlreadyExists,
  type Onboarding,
  type PartyPreparation,
  type PartyStatus,
} from '../../../src/onboarding/model.js';
import type { PartySubmission } from '../../../src/onboarding/requests.js';
import { OnboardingWorkflow } from '../../../src/onboarding/workflow.js';
import { AccessDenied, Conflict } from '../../../src/platform/errors.js';
import { APPLICATION, LedgerDouble, party, PartiesDouble, ProgressDouble, SILENT_LOG } from './progress.js';

const TOPOLOGY = 'original-signed-topology';
const RELEASE_TIMEOUT_MS = 5_000;

const david: Account = { id: randomUUID(), issuer: 'issuer', subject: 'david', displayName: 'David', role: 'TRADER' };
const signature: PartySubmission = { preparationId: randomUUID(), signature: 'signature' };

interface Latch {
  readonly reached: Promise<undefined>;
  release(): void;
}

function latch(): Latch {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return {
    reached: promise,
    release: () => {
      resolve(undefined);
    },
  };
}

/** Signals `entered`, then waits until the test releases `released`. */
async function pause(entered: Latch, released: Latch): Promise<void> {
  entered.release();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Concurrent operation was not released'));
    }, RELEASE_TIMEOUT_MS);
  });
  try {
    await Promise.race([released.reached, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

class Progress extends ProgressDouble {
  readonly id = randomUUID();
  status: PartyStatus = 'PREPARED';
  afterOwnedRead: () => Promise<void> = () => Promise.resolve();

  override claimParty(_id: string, caller: Account): Promise<boolean> {
    expect(caller).toBe(david);
    if (this.status === 'CONFLICT') return Promise.reject(new PartyAlreadyExists());
    if (this.status !== 'PREPARED') return Promise.resolve(false);
    this.status = 'SUBMITTING';
    return Promise.resolve(true);
  }

  override pending(): Promise<readonly string[]> {
    return Promise.resolve(this.status === 'UNRESOLVED' ? [this.id] : []);
  }

  override unresolvedParty(): Promise<void> {
    if (this.status === 'SUBMITTING') this.status = 'UNRESOLVED';
    return Promise.resolve();
  }

  override conflictedParty(): Promise<void> {
    if (this.status === 'SUBMITTING') this.status = 'CONFLICT';
    return Promise.resolve();
  }

  override deniedParty(): Promise<void> {
    if (this.status === 'SUBMITTING') this.status = 'PREPARED';
    return Promise.resolve();
  }

  override confirmParty(): Promise<void> {
    if (this.status === 'CONFIRMED') return Promise.resolve();
    if (this.status !== 'SUBMITTING' && this.status !== 'UNRESOLVED') {
      return Promise.reject(new Conflict('Party was not submitted'));
    }
    this.status = 'CONFIRMED';
    return Promise.resolve();
  }

  override async getOwned(): Promise<Onboarding> {
    const current = await this.get();
    await this.afterOwnedRead();
    return current;
  }

  override get(): Promise<Onboarding> {
    return Promise.resolve({
      id: this.id,
      accountId: david.id,
      application: APPLICATION,
      status: this.status,
      partyMode: 'external',
      createdAt: '1970-01-01T00:00:00Z',
      review: null,
      party: party(this.status, { preparationId: signature.preparationId, topologyTransactions: [TOPOLOGY] }),
      ledgerSteps: [],
      suggestedPartyHint: 'david',
    });
  }
}

class Parties extends PartiesDouble {
  allocations = 0;
  confirmations = 0;
  isConfirmed = false;
  failure: Error | undefined;
  duringAllocation: () => Promise<void> = () => Promise.resolve();
  duringConfirmation: () => Promise<void> = () => Promise.resolve();
  readonly tokens: string[] = [];

  override async allocate(
    caller: Account,
    token: string,
    party: PartyPreparation,
    transactions: readonly string[],
  ): Promise<void> {
    expect(party.preparationId).toBe(signature.preparationId);
    expect(caller).toBe(david);
    expect(transactions).toEqual([TOPOLOGY]);
    this.allocations += 1;
    this.tokens.push(token);
    await this.duringAllocation();
    if (this.failure) throw this.failure;
  }

  override async confirmed(): Promise<boolean> {
    this.confirmations += 1;
    await this.duringConfirmation();
    return this.isConfirmed;
  }
}

describe('party registration recovery', () => {
  it('stops registration for an existing party without binding or issuing contracts', async () => {
    const store = new Progress();
    const parties = new Parties();
    parties.failure = new PartyAlreadyExists();
    parties.isConfirmed = true;
    const workflow = new OnboardingWorkflow(store, new LedgerDouble(), parties, SILENT_LOG);
    parties.duringAllocation = async () => {
      await workflow.getOwned(store.id, david, 'poll-token');
      expect(store.status).toBe('SUBMITTING');
      expect(parties.confirmations).toBe(0);
    };
    await expect(workflow.submitParty(store.id, david, signature, 'token')).rejects.toBeInstanceOf(PartyAlreadyExists);
    expect(store.status).toBe('CONFLICT');
    const restarted = new OnboardingWorkflow(store, new LedgerDouble(), parties, SILENT_LOG);
    expect((await restarted.getOwned(store.id, david, 'fresh-token')).party?.confirmed).toBe(false);
    await expect(restarted.submitParty(store.id, david, signature, 'fresh-token')).rejects.toBeInstanceOf(
      PartyAlreadyExists,
    );
    await restarted.reconcile();
    expect(store.status).toBe('CONFLICT');
    expect(parties.allocations).toBe(1);
    expect(parties.confirmations).toBe(0);
  });

  it('never resubmits an uncertain allocation and recovers without the user token', async () => {
    const store = new Progress();
    const parties = new Parties();
    parties.failure = new Error('Response lost after possible registration');
    await new OnboardingWorkflow(store, new LedgerDouble(), parties, SILENT_LOG).submitParty(
      store.id,
      david,
      signature,
      'short-lived-token',
    );
    expect(store.status).toBe('UNRESOLVED');
    const restarted = new OnboardingWorkflow(store, new LedgerDouble(), parties, SILENT_LOG);
    await restarted.submitParty(store.id, david, signature, 'fresh-token');
    await restarted.reconcile();
    expect(parties.allocations).toBe(1);
    expect(store.status).toBe('UNRESOLVED');
    parties.isConfirmed = true;
    await restarted.getOwned(store.id, david, 'new-login-token');
    await restarted.reconcile();
    expect(store.status).toBe('CONFIRMED');
    expect(parties.allocations).toBe(1);
  });

  it('allows a manual retry with a fresh token after a definitive authorization rejection', async () => {
    const store = new Progress();
    const parties = new Parties();
    parties.failure = new AccessDenied('Expired user token');
    const workflow = new OnboardingWorkflow(store, new LedgerDouble(), parties, SILENT_LOG);
    await expect(workflow.submitParty(store.id, david, signature, 'expired-token')).rejects.toBeInstanceOf(
      AccessDenied,
    );
    expect(store.status).toBe('PREPARED');
    parties.failure = undefined;
    parties.isConfirmed = true;
    await workflow.submitParty(store.id, david, signature, 'fresh-token');
    expect(store.status).toBe('CONFIRMED');
    expect(parties.tokens).toEqual(['expired-token', 'fresh-token']);
  });

  it.each([
    ['confirmed', true],
    ['unconfirmed', true],
    ['failed', true],
    ['confirmed', false],
    ['unconfirmed', false],
    ['failed', false],
  ])(
    'never lets a stale poll (%s, during retry: %s) override a retried registration',
    async (lookupResult, duringRetry) => {
      const store = new Progress();
      const parties = new Parties();
      const workflow = new OnboardingWorkflow(store, new LedgerDouble(), parties, SILENT_LOG);
      const [allocationStarted, rejectAllocation, snapshotRead, returnSnapshot] = [latch(), latch(), latch(), latch()];
      const [lookupStarted, finishLookup, retryStarted, returnConflict] = [latch(), latch(), latch(), latch()];
      parties.failure = new AccessDenied('Expired user token');
      parties.duringAllocation = () => pause(allocationStarted, rejectAllocation);
      store.afterOwnedRead = async () => {
        store.afterOwnedRead = () => Promise.resolve();
        await pause(snapshotRead, returnSnapshot);
      };
      parties.isConfirmed = lookupResult === 'confirmed';
      parties.duringConfirmation = async () => {
        await pause(lookupStarted, finishLookup);
        if (lookupResult === 'failed') throw new AccessDenied('Poll token expired');
      };

      const first = workflow.submitParty(store.id, david, signature, 'expired');
      await allocationStarted.reached;
      const poll = workflow.getOwned(store.id, david, 'poll-token');
      await snapshotRead.reached;

      // The GET keeps the old SUBMITTING snapshot after the rejected allocation finishes.
      rejectAllocation.release();
      await expect(first).rejects.toBeInstanceOf(AccessDenied);
      expect(store.status).toBe('PREPARED');
      returnSnapshot.release();
      await lookupStarted.reached;

      parties.failure = new PartyAlreadyExists();
      parties.duringAllocation = () => pause(retryStarted, returnConflict);
      const retry = workflow.submitParty(store.id, david, signature, 'fresh');
      await retryStarted.reached;
      if (duringRetry) {
        finishLookup.release();
        expect((await poll).party?.status).toBe('SUBMITTING');
      }
      returnConflict.release();
      await expect(retry).rejects.toBeInstanceOf(PartyAlreadyExists);
      if (!duringRetry) {
        finishLookup.release();
        expect((await poll).party?.status).toBe('CONFLICT');
      }
      expect((await workflow.getOwned(store.id, david, 'fresh')).party?.status).toBe('CONFLICT');
      await expect(workflow.submitParty(store.id, david, signature, 'fresh')).rejects.toBeInstanceOf(
        PartyAlreadyExists,
      );
      await workflow.reconcile();
      expect(parties.allocations).toBe(2);
      expect(parties.confirmations).toBe(1);
    },
  );
});
