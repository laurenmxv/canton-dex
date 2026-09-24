import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { requireRole, type Account } from '../../../src/iam/accounts.js';
import { Conflict, InvalidRequest } from '../../../src/platform/errors.js';
import type {
  Balances,
  Claim,
  Confirmation,
  Prepared,
  Registry,
  Signer,
  TestToken,
} from '../../../src/tokens/model.js';
import { GrantNotSubmitted, TokenRejected, type TokenLedger, type TokenProgress } from '../../../src/tokens/ports.js';
import { TokenWorkflow } from '../../../src/tokens/workflow.js';

const SILENT_LOG = { warn: () => undefined };
const TOKEN = 'caller-token';
const TRADER: Account = {
  id: randomUUID(),
  issuer: 'issuer',
  subject: 'subject',
  displayName: 'Trader',
  role: 'TRADER',
};

function inFiveMinutes(): string {
  return new Date(Date.now() + 300_000).toISOString();
}

class Ledger implements TokenLedger {
  grants = 0;
  preparations = 0;
  claims = 0;
  loseGrantResponse = false;
  loseClaimResponse = false;
  rejectClaim = false;
  provenMissingClaim = false;
  grantNotSubmitted = false;
  recoveredGrant: Confirmation | undefined;
  recoveredClaim: Confirmation | undefined;
  submittedClaim: Claim | undefined;

  ledgerEnd(): Promise<bigint> {
    return Promise.resolve(100n);
  }

  issueGrant(): Promise<Confirmation> {
    this.grants += 1;
    if (this.grantNotSubmitted) return Promise.reject(new GrantNotSubmitted('Command was not prepared'));
    if (this.loseGrantResponse) return Promise.reject(new Error('response lost'));
    return Promise.resolve({ contractId: 'grant', updateId: 'grant-update' });
  }

  recoverGrant(): Promise<Confirmation | undefined> {
    if (this.grantNotSubmitted) return Promise.reject(new GrantNotSubmitted('Command was not prepared'));
    return Promise.resolve(this.recoveredGrant);
  }

  prepareClaim(_claim: Claim, _signer: Signer, _token: string, expiresAt: string): Promise<Prepared> {
    this.preparations += 1;
    return Promise.resolve({
      preparedTransaction: 'transaction',
      preparedTransactionHash: 'hash',
      hashingSchemeVersion: 3,
      expiresAt,
    });
  }

  claim(claim: Claim): Promise<Confirmation> {
    this.claims += 1;
    this.submittedClaim = claim;
    if (this.rejectClaim) return Promise.reject(new TokenRejected('Rejected before submission'));
    if (this.loseClaimResponse) return Promise.reject(new Error('response lost'));
    return Promise.resolve({ contractId: 'receipt', updateId: 'claim-update' });
  }

  recoverClaim(): Promise<Confirmation | undefined> {
    if (this.provenMissingClaim) {
      return Promise.reject(new TokenRejected('Deadline passed with complete empty history'));
    }
    return Promise.resolve(this.recoveredClaim);
  }

  balances(): Promise<Balances> {
    return Promise.resolve({ balances: [], asOfOffset: 100n });
  }

  verify(_claim: Claim, _signer: Signer, signature: string): void {
    if (signature !== 'valid') throw new InvalidRequest('Invalid signature');
  }
}

/** One account's claim, with the same compare-and-set rules as the SQL store. */
class MemoryStore implements TokenProgress {
  current: Claim | undefined;
  afterClaimSubmission: (() => Promise<void>) | undefined;

  private claim(): Claim {
    if (!this.current) throw new Error('No claim');
    return this.current;
  }

  registry(): Promise<Registry> {
    return Promise.resolve({
      issuerPartyId: 'issuer',
      rulesId: 'rules',
      packageId: 'package',
      faucetFactoryId: 'factory',
      rulesCreatedEventBlob: 'blob',
      synchronizerId: 'sync',
    });
  }

  tokens(): Promise<readonly TestToken[]> {
    return Promise.resolve([{ symbol: 'USDC', instrumentId: 'USDC', decimals: 6, initialClaimAmount: '10000' }]);
  }

  signer(account: Account): Promise<Signer> {
    requireRole(account, 'TRADER');
    return Promise.resolve({
      userId: account.subject,
      party: {
        preparationId: randomUUID(),
        partyId: 'trader',
        confirmed: true,
        publicKey: 'public-key',
        publicKeyFingerprint: 'fingerprint',
        multiHash: 'hash',
        synchronizerId: 'sync',
        status: 'CONFIRMED',
        participantId: 'participant',
        topologyTransactions: [],
      },
    });
  }

  initialize(accountId: string): Promise<Claim> {
    this.current ??= {
      accountId,
      grantId: randomUUID(),
      grantCommandId: randomUUID(),
      grantCid: null,
      grantBeginOffset: null,
      grantStatus: 'PENDING',
      preparationId: null,
      prepared: null,
      claimBeginOffset: null,
      status: 'AVAILABLE',
      updateId: null,
      errorCode: null,
      error: null,
    };
    return Promise.resolve(this.current);
  }

  get(): Promise<Claim | undefined> {
    return Promise.resolve(this.current);
  }

  claimGrant(accountId: string, offset: bigint): Promise<boolean> {
    const claim = this.claim();
    if (claim.grantStatus !== 'PENDING') return Promise.resolve(false);
    this.current = {
      ...claim,
      accountId,
      grantCommandId: randomUUID(),
      grantCid: null,
      grantBeginOffset: offset,
      grantStatus: 'SUBMITTING',
      preparationId: null,
      prepared: null,
      claimBeginOffset: null,
      status: 'AVAILABLE',
      updateId: null,
      errorCode: null,
      error: null,
    };
    return Promise.resolve(true);
  }

  confirmGrant(_accountId: string, _commandId: string, confirmation: Confirmation): Promise<void> {
    this.current = {
      ...this.claim(),
      grantCid: confirmation.contractId,
      grantStatus: 'CONFIRMED',
      updateId: null,
      errorCode: null,
      error: null,
    };
    return Promise.resolve();
  }

  async beginGrantRecovery(accountId: string, commandId: string): Promise<boolean> {
    const claim = this.claim();
    if (
      claim.grantCommandId !== commandId ||
      (claim.grantStatus !== 'SUBMITTING' && claim.grantStatus !== 'UNRESOLVED')
    ) {
      return false;
    }
    await this.unresolvedGrant(accountId, commandId);
    return true;
  }

  unresolvedGrant(_accountId: string, _commandId: string): Promise<void> {
    this.current = {
      ...this.claim(),
      grantCid: null,
      grantStatus: 'UNRESOLVED',
      preparationId: null,
      prepared: null,
      claimBeginOffset: null,
      status: 'AVAILABLE',
      updateId: null,
      errorCode: 'GRANT_UNRESOLVED',
      error: 'Checking grant',
    };
    return Promise.resolve();
  }

  savePreparation(_accountId: string, preparationId: string, prepared: Prepared): Promise<boolean> {
    this.current = {
      ...this.claim(),
      preparationId,
      prepared,
      claimBeginOffset: null,
      status: 'PREPARED',
      updateId: null,
      errorCode: null,
      error: null,
    };
    return Promise.resolve(true);
  }

  async claimSubmission(_accountId: string, preparationId: string, offset: bigint): Promise<boolean> {
    const claim = this.claim();
    if (claim.status !== 'PREPARED' || claim.preparationId !== preparationId) return false;
    this.current = {
      ...claim,
      claimBeginOffset: offset,
      status: 'SUBMITTING',
      updateId: null,
      errorCode: null,
      error: null,
    };
    const callback = this.afterClaimSubmission;
    this.afterClaimSubmission = undefined;
    await callback?.();
    return true;
  }

  complete(_accountId: string, preparationId: string, confirmation: Confirmation): Promise<void> {
    if (this.matchesPending(preparationId)) this.state('COMPLETED', confirmation.updateId);
    return Promise.resolve();
  }

  rejected(_accountId: string, preparationId: string): Promise<void> {
    if (this.matchesPending(preparationId)) {
      this.current = {
        ...this.claim(),
        prepared: null,
        status: 'AVAILABLE',
        updateId: null,
        errorCode: 'CLAIM_REJECTED',
        error: 'Rejected',
      };
    }
    return Promise.resolve();
  }

  rejectedGrant(_accountId: string, commandId: string): Promise<void> {
    this.resetGrant(commandId, false);
    return Promise.resolve();
  }

  excludeGrant(_accountId: string, commandId: string): Promise<void> {
    this.resetGrant(commandId, true);
    return Promise.resolve();
  }

  private resetGrant(commandId: string, neverSubmitted: boolean): void {
    const claim = this.claim();
    const resettable = claim.grantStatus === 'SUBMITTING' || (neverSubmitted && claim.grantStatus === 'UNRESOLVED');
    if (!resettable || claim.grantCommandId !== commandId) return;
    this.current = {
      ...claim,
      grantCid: null,
      grantStatus: 'PENDING',
      preparationId: null,
      prepared: null,
      claimBeginOffset: null,
      status: 'AVAILABLE',
      updateId: null,
      errorCode: 'GRANT_REJECTED',
      error: 'Rejected',
    };
  }

  unresolved(_accountId: string, preparationId: string): Promise<void> {
    if (this.matchesPending(preparationId) && this.claim().status === 'SUBMITTING') this.state('UNRESOLVED', null);
    return Promise.resolve();
  }

  private matchesPending(preparationId: string): boolean {
    const claim = this.claim();
    return claim.preparationId === preparationId && (claim.status === 'SUBMITTING' || claim.status === 'UNRESOLVED');
  }

  private state(status: Claim['status'], updateId: string | null): void {
    this.current = { ...this.claim(), status, updateId, errorCode: null, error: null };
  }
}

function fixture() {
  const store = new MemoryStore();
  const ledger = new Ledger();
  return { store, ledger, workflow: new TokenWorkflow(store, ledger, SILENT_LOG) };
}

describe('token workflow', () => {
  it('a repeated preparation and submission do not mint twice', async () => {
    const { ledger, workflow } = fixture();
    const first = await workflow.prepare(TRADER, TOKEN);
    const repeated = await workflow.prepare(TRADER, TOKEN);
    expect(repeated).toEqual(first);
    expect(ledger.grants).toBe(1);
    expect(ledger.preparations).toBe(1);
    const submission = { preparationId: first.preparationId, signature: 'valid' };
    expect((await workflow.submit(TRADER, TOKEN, submission)).status).toBe('COMPLETED');
    expect((await workflow.submit(TRADER, TOKEN, submission)).status).toBe('COMPLETED');
    expect(ledger.claims).toBe(1);
    await expect(workflow.prepare(TRADER, TOKEN)).rejects.toBeInstanceOf(Conflict);
  });

  it('a lost claim response is recovered without resubmission', async () => {
    const { ledger, workflow } = fixture();
    const preparation = await workflow.prepare(TRADER, TOKEN);
    ledger.loseClaimResponse = true;
    const submission = { preparationId: preparation.preparationId, signature: 'valid' };
    expect((await workflow.submit(TRADER, TOKEN, submission)).status).toBe('UNRESOLVED');
    await expect(workflow.prepare(TRADER, TOKEN)).rejects.toBeInstanceOf(Conflict);
    expect((await workflow.submit(TRADER, TOKEN, submission)).status).toBe('UNRESOLVED');
    expect(ledger.claims).toBe(1);
    ledger.recoveredClaim = { contractId: 'receipt', updateId: 'claim-update' };
    expect((await workflow.status(TRADER)).status).toBe('COMPLETED');
    expect((await workflow.status(TRADER)).updateId).toBe('claim-update');
    expect(ledger.claims).toBe(1);
  });

  it('an uncertain grant is never issued again', async () => {
    const { ledger, workflow } = fixture();
    ledger.loseGrantResponse = true;
    await expect(workflow.prepare(TRADER, TOKEN)).rejects.toBeInstanceOf(Conflict);
    expect((await workflow.status(TRADER)).status).toBe('UNRESOLVED');
    await expect(workflow.prepare(TRADER, TOKEN)).rejects.toBeInstanceOf(Conflict);
    expect(ledger.grants).toBe(1);
    ledger.recoveredGrant = { contractId: 'grant', updateId: 'grant-update' };
    await workflow.prepare(TRADER, TOKEN);
    expect(ledger.grants).toBe(1);
    expect(ledger.preparations).toBe(1);
  });

  it('a malformed signature does not claim the submission or call the ledger', async () => {
    const { store, ledger, workflow } = fixture();
    const preparation = await workflow.prepare(TRADER, TOKEN);
    await expect(
      workflow.submit(TRADER, TOKEN, { preparationId: preparation.preparationId, signature: 'invalid' }),
    ).rejects.toBeInstanceOf(InvalidRequest);
    expect(store.current?.status).toBe('PREPARED');
    expect(ledger.claims).toBe(0);
  });

  it('a foreign preparation does not change the claim', async () => {
    const { store, ledger, workflow } = fixture();
    await workflow.prepare(TRADER, TOKEN);
    await expect(
      workflow.submit(TRADER, TOKEN, { preparationId: randomUUID(), signature: 'valid' }),
    ).rejects.toBeInstanceOf(Conflict);
    expect(store.current?.status).toBe('PREPARED');
    expect(ledger.claims).toBe(0);
  });

  it('a definitive claim rejection allows a fresh preparation', async () => {
    const { ledger, workflow } = fixture();
    const preparation = await workflow.prepare(TRADER, TOKEN);
    ledger.rejectClaim = true;
    const rejected = await workflow.submit(TRADER, TOKEN, {
      preparationId: preparation.preparationId,
      signature: 'valid',
    });
    expect(rejected.status).toBe('AVAILABLE');
    ledger.rejectClaim = false;
    const fresh = await workflow.prepare(TRADER, TOKEN);
    expect(fresh.preparationId).not.toBe(preparation.preparationId);
    expect(ledger.grants).toBe(1);
    const completed = await workflow.submit(TRADER, TOKEN, { preparationId: fresh.preparationId, signature: 'valid' });
    expect(completed.status).toBe('COMPLETED');
  });

  it('a proven expired claim without effect allows a fresh wallet signature', async () => {
    const { ledger, workflow } = fixture();
    const original = await workflow.prepare(TRADER, TOKEN);
    ledger.loseClaimResponse = true;
    await workflow.submit(TRADER, TOKEN, { preparationId: original.preparationId, signature: 'valid' });
    ledger.provenMissingClaim = true;
    expect((await workflow.status(TRADER)).status).toBe('AVAILABLE');
    const fresh = await workflow.prepare(TRADER, TOKEN);
    expect(fresh.preparationId).not.toBe(original.preparationId);
    expect(ledger.grants).toBe(1);
  });

  it('a recovery started before a late rejection keeps the original grant attempt', async () => {
    const { store, ledger, workflow } = fixture();
    ledger.loseGrantResponse = true;
    await expect(workflow.prepare(TRADER, TOKEN)).rejects.toBeInstanceOf(Conflict);
    const original = store.current;
    if (!original) throw new Error('No claim');
    await workflow.status(TRADER);
    await store.rejectedGrant(TRADER.id, original.grantCommandId);
    expect(store.current?.grantStatus).toBe('UNRESOLVED');
    expect(store.current?.grantCommandId).toBe(original.grantCommandId);
    expect(ledger.grants).toBe(1);
    ledger.grantNotSubmitted = true;
    expect((await workflow.status(TRADER)).status).toBe('AVAILABLE');
    ledger.loseGrantResponse = false;
    ledger.grantNotSubmitted = false;
    await workflow.prepare(TRADER, TOKEN);
    expect(ledger.grants).toBe(2);
    expect(store.current?.grantCommandId).not.toBe(original.grantCommandId);
  });

  it('a grant preparation failure allows another attempt without reconciliation', async () => {
    const { store, ledger, workflow } = fixture();
    ledger.grantNotSubmitted = true;
    await expect(workflow.prepare(TRADER, TOKEN)).rejects.toBeInstanceOf(Conflict);
    expect(store.current?.grantStatus).toBe('PENDING');
    ledger.grantNotSubmitted = false;
    await workflow.prepare(TRADER, TOKEN);
    expect(ledger.grants).toBe(2);
    expect(ledger.preparations).toBe(1);
  });

  it.each(['SUCCESS', 'REJECTED', 'UNKNOWN'] as const)(
    'a replaced preparation cannot be executed or changed by an earlier submission (%s)',
    async (outcome) => {
      const { store, ledger, workflow } = fixture();
      const original = await workflow.prepare(TRADER, TOKEN);
      const originalPrepared = store.current?.prepared;
      const replacementId = randomUUID();
      const replacementPrepared: Prepared = {
        preparedTransaction: 'replacement-transaction',
        preparedTransactionHash: 'replacement-hash',
        hashingSchemeVersion: 3,
        expiresAt: inFiveMinutes(),
      };
      store.afterClaimSubmission = async () => {
        await store.rejected(TRADER.id, original.preparationId);
        await store.savePreparation(TRADER.id, replacementId, replacementPrepared);
        await store.claimSubmission(TRADER.id, replacementId, 200n);
      };
      ledger.rejectClaim = outcome === 'REJECTED';
      ledger.loseClaimResponse = outcome === 'UNKNOWN';

      const result = await workflow.submit(TRADER, TOKEN, {
        preparationId: original.preparationId,
        signature: 'valid',
      });

      expect(ledger.submittedClaim?.preparationId).toBe(original.preparationId);
      expect(ledger.submittedClaim?.prepared).toEqual(originalPrepared);
      expect(ledger.submittedClaim?.claimBeginOffset).toBe(100n);
      expect(result.status).toBe('SUBMITTING');
      expect(store.current?.preparationId).toBe(replacementId);
      expect(store.current?.prepared).toEqual(replacementPrepared);
      expect(store.current?.claimBeginOffset).toBe(200n);
      expect(store.current?.updateId).toBeNull();
      expect(store.current?.errorCode).toBeNull();
    },
  );
});
