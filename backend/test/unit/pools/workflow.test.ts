import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Account } from '../../../src/iam/accounts.js';
import { Conflict } from '../../../src/platform/errors.js';
import type {
  CreateProposal,
  LedgerPool,
  PendingProposal,
  PoolDetail,
  Proposal,
  ProposalStatus,
  ProposalTerms,
} from '../../../src/pools/model.js';
import { PoolRejected, type PoolConfirmation, type PoolLedger, type PoolProgress } from '../../../src/pools/ports.js';
import { PoolWorkflow } from '../../../src/pools/workflow.js';
import type { InstrumentCatalog } from '../../../src/tokens/model.js';

const SILENT_LOG = { info: () => undefined, warn: () => undefined };
const OPERATOR: Account = {
  id: randomUUID(),
  issuer: 'issuer',
  subject: 'operator',
  displayName: 'Operator',
  role: 'OPERATOR',
};
const INPUT: CreateProposal = {
  name: 'A/B',
  baseInstrumentId: { admin: 'admin', id: 'A' },
  quoteInstrumentId: { admin: 'admin', id: 'B' },
  feeBps: '30',
};
const CATALOG: InstrumentCatalog = {
  instruments: () =>
    Promise.resolve([
      { admin: 'admin', id: 'A', symbol: 'A', decimals: 6 },
      { admin: 'admin', id: 'B', symbol: 'B', decimals: 6 },
    ]),
};

class Ledger implements PoolLedger {
  readonly packageId = 'package';
  failure: Error | undefined;
  recoveryFailure = false;
  submissions = 0;
  evidence: PoolConfirmation[] = [];

  operator(): Promise<string> {
    return Promise.resolve('operator');
  }

  offset(): Promise<bigint> {
    return Promise.resolve(42n);
  }

  factory(): Promise<string> {
    return Promise.resolve('factory');
  }

  pools(): Promise<LedgerPool[]> {
    return Promise.resolve([]);
  }

  propose(): Promise<PoolConfirmation> {
    this.submissions += 1;
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({ proposalCid: 'proposal-cid', status: 'PENDING', updateId: 'update', pool: null });
  }

  withdraw(proposal: Proposal): Promise<PoolConfirmation> {
    this.submissions += 1;
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({
      proposalCid: proposal.proposalCid ?? '',
      status: 'WITHDRAWN',
      updateId: 'withdraw',
      pool: null,
    });
  }

  recover(pending: PendingProposal): Promise<PoolConfirmation[]> {
    expect(pending.beginOffset).toBe(42n);
    if (this.recoveryFailure) return Promise.reject(new Error('ledger unavailable'));
    return Promise.resolve(this.evidence);
  }
}

/** One proposal's durable progress and whether it holds its pair claim. */
class Progress implements PoolProgress {
  proposal: Proposal | undefined;
  claimed = false;

  private current(): Proposal {
    if (!this.proposal) throw new Error('No proposal');
    return this.proposal;
  }

  private phase(status: ProposalStatus, proposalCid: string | null, error: string | null): void {
    this.proposal = { ...this.current(), status, proposalCid, poolId: null, updateId: null, error };
  }

  dvo(): Promise<string> {
    return Promise.resolve('dvo');
  }

  names(): Promise<ReadonlyMap<string, string>> {
    return Promise.resolve(new Map());
  }

  reserve(id: string, input: CreateProposal, settings: ProposalTerms, factoryId: string): Promise<Proposal> {
    if (this.claimed) return Promise.reject(new Conflict('Pair claimed'));
    this.claimed = true;
    this.proposal = {
      proposalId: id,
      name: input.name,
      settings,
      status: 'SUBMITTING',
      createdAt: '1970-01-01T00:00:00Z',
      updatedAt: '1970-01-01T00:00:00Z',
      proposedBy: 'Operator',
      proposalCid: null,
      factoryId,
      poolId: null,
      updateId: null,
      error: null,
    };
    return Promise.resolve(this.proposal);
  }

  get(): Promise<Proposal> {
    return Promise.resolve(this.current());
  }

  pending(): Promise<readonly PendingProposal[]> {
    const proposal = this.current();
    return Promise.resolve([{ proposal, commandId: proposal.proposalId, beginOffset: 42n }]);
  }

  proposed(_id: string, proposalCid: string): Promise<void> {
    this.phase('PENDING', proposalCid, null);
    return Promise.resolve();
  }

  unresolved(): Promise<void> {
    this.phase('UNRESOLVED', this.current().proposalCid, 'Confirmation pending');
    return Promise.resolve();
  }

  failedSubmission(_id: string, withdrawal: boolean): Promise<void> {
    this.phase(withdrawal ? 'PENDING' : 'FAILED', this.current().proposalCid, 'Command rejected');
    if (!withdrawal) this.claimed = false;
    return Promise.resolve();
  }

  claimWithdrawal(): Promise<boolean> {
    if (this.current().status !== 'PENDING') return Promise.resolve(false);
    this.phase('SUBMITTING', this.current().proposalCid, null);
    return Promise.resolve(true);
  }

  finish(_id: string, status: ProposalStatus, _updateId: string, pool: LedgerPool | null): Promise<void> {
    this.phase(status, this.current().proposalCid, null);
    this.claimed = pool !== null;
    return Promise.resolve();
  }

  reconciliationError(_id: string, failed: boolean): Promise<void> {
    this.phase(this.current().status, this.current().proposalCid, failed ? 'Refresh failed' : null);
    return Promise.resolve();
  }

  save(): Promise<void> {
    return Promise.reject(new Error('Unexpected save'));
  }

  pools(): Promise<readonly PoolDetail[]> {
    return Promise.reject(new Error('Unexpected pools'));
  }

  pool(): Promise<PoolDetail> {
    return Promise.reject(new Error('Unexpected pool'));
  }
}

function fixture() {
  const store = new Progress();
  const ledger = new Ledger();
  return { store, ledger, workflow: new PoolWorkflow(store, ledger, CATALOG, SILENT_LOG) };
}

describe('pool workflow', () => {
  it('a rejected proposal releases its pair and allows a corrected attempt', async () => {
    const { store, ledger, workflow } = fixture();
    ledger.failure = new PoolRejected(new Error('invalid factory'));
    expect((await workflow.create(INPUT, OPERATOR)).status).toBe('FAILED');
    expect(store.claimed).toBe(false);
    ledger.failure = undefined;
    expect((await workflow.create(INPUT, OPERATOR)).status).toBe('PENDING');
    expect(ledger.submissions).toBe(2);
  });

  it('a rejected withdrawal retains the proposal and can be retried', async () => {
    const { store, ledger, workflow } = fixture();
    const proposal = await workflow.create(INPUT, OPERATOR);
    ledger.failure = new PoolRejected(new Error('permission denied'));
    expect((await workflow.withdraw(proposal.proposalId, OPERATOR)).status).toBe('PENDING');
    expect(store.claimed).toBe(true);
    expect((await store.get()).error).toMatch(/\S/);
    ledger.failure = undefined;
    expect((await workflow.withdraw(proposal.proposalId, OPERATOR)).status).toBe('WITHDRAWN');
    expect(store.claimed).toBe(false);
  });

  it('a lost response is recovered without a retry and keeps the pair reserved', async () => {
    const { store, ledger, workflow } = fixture();
    ledger.failure = new Error('response lost');
    const proposal = await workflow.create(INPUT, OPERATOR);
    expect(proposal.status).toBe('UNRESOLVED');
    expect(store.claimed).toBe(true);
    ledger.evidence = [{ proposalCid: 'proposal-cid', status: 'PENDING', updateId: 'update', pool: null }];
    await new PoolWorkflow(store, ledger, CATALOG, SILENT_LOG).reconcile();
    expect((await store.get()).status).toBe('PENDING');
    expect(ledger.submissions).toBe(1);
  });

  it('a reconciliation failure retains the phase and exposes an error until a successful read', async () => {
    const { store, ledger, workflow } = fixture();
    await workflow.create(INPUT, OPERATOR);
    ledger.recoveryFailure = true;
    await workflow.reconcile();
    expect((await store.get()).status).toBe('PENDING');
    expect((await store.get()).error).toMatch(/\S/);
    ledger.recoveryFailure = false;
    await workflow.reconcile();
    expect((await store.get()).error).toBeNull();
    expect(ledger.submissions).toBe(1);
  });
});
