/**
 * Reads balances and serves the development faucet.
 *
 * @remarks
 * Reading token material from an adapter does not imply invoking this business workflow. The
 * faucet is local development support.
 *
 * @packageDocumentation
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Account } from '../iam/accounts.js';
import { Conflict, NotFound } from '../platform/errors.js';
import { clockNanos, instantText, isFuture } from '../platform/time.js';
import {
  claimPreparation,
  claimResult,
  submittingAt,
  tokenAmount,
  type Balances,
  type Claim,
  type FaucetResult,
  type Preparation,
  type Signer,
  type Submission,
} from './model.js';
import { GrantNotSubmitted, TokenRejected, type TokenLedger, type TokenProgress } from './ports.js';

const SIGNING_WINDOW_NANOS = 5n * 60n * 1_000_000_000n;
const GRANT_RECONCILING = 'The test token grant is being reconciled; retry after it is confirmed';

function present(claim: Claim | undefined): Claim {
  if (!claim) throw new NotFound();
  return claim;
}

/**
 * The one-time development token claim: the operator grants the bundle once per party, and the
 * trader's wallet signs the claim that mints it. A lost grant or claim response is reconciled
 * from ledger evidence, never issued or signed again.
 */
export class TokenWorkflow {
  constructor(
    private readonly store: TokenProgress,
    private readonly ledger: TokenLedger,
    private readonly log: Pick<FastifyBaseLogger, 'warn'>,
  ) {}

  async balances(account: Account, callerToken: string): Promise<Balances> {
    return this.ledger.balances(await this.store.signer(account), callerToken);
  }

  async status(account: Account): Promise<FaucetResult> {
    const signer = await this.store.signer(account);
    const claim = await this.store.get(account.id);
    if (!claim) return { status: 'AVAILABLE', updateId: null, errorCode: null, error: null };
    return claimResult(await this.reconcile(claim, signer));
  }

  async prepare(account: Account, callerToken: string): Promise<Preparation> {
    const signer = await this.store.signer(account);
    let claim = await this.reconcile(await this.store.initialize(account.id, signer.party.partyId), signer);
    if (claim.status === 'COMPLETED') throw new Conflict('This account already received its test tokens');
    if (claim.status === 'SUBMITTING' || claim.status === 'UNRESOLVED') {
      throw new Conflict('The signed claim is being reconciled; do not submit another claim');
    }
    claim = await this.ensureGrant(claim, signer);
    if (claim.prepared === null || !isFuture(claim.prepared.expiresAt)) {
      const expiresAt = instantText(clockNanos() + SIGNING_WINDOW_NANOS);
      const prepared = await this.ledger.prepareClaim(claim, signer, callerToken, expiresAt);
      await this.store.savePreparation(account.id, randomUUID(), prepared);
      claim = present(await this.store.get(account.id));
    }
    if (claim.status !== 'PREPARED') throw new Conflict('The test token claim is already being submitted');
    const issuer = (await this.store.registry()).issuerPartyId;
    const amounts = (await this.store.tokens()).map((token) => tokenAmount(token, issuer));
    return claimPreparation(claim, signer, amounts);
  }

  async submit(account: Account, callerToken: string, submission: Submission): Promise<FaucetResult> {
    const signer = await this.store.signer(account);
    const current = present(await this.store.get(account.id));
    if (submission.preparationId !== current.preparationId) {
      throw new Conflict('Preparation does not belong to this test token claim');
    }
    if (current.status !== 'PREPARED') return claimResult(await this.reconcile(current, signer));
    if (current.prepared === null || !isFuture(current.prepared.expiresAt)) {
      throw new Conflict('The signing request expired; prepare it again');
    }
    this.ledger.verify(current, signer, submission.signature);
    const offset = await this.ledger.ledgerEnd();
    const claim = submittingAt(current, offset);
    const preparationId = submission.preparationId;
    if (!(await this.store.claimSubmission(account.id, preparationId, offset))) {
      return claimResult(present(await this.store.get(account.id)));
    }
    try {
      await this.store.complete(
        account.id,
        preparationId,
        await this.ledger.claim(claim, signer, callerToken, submission.signature),
      );
    } catch (error) {
      if (error instanceof TokenRejected) {
        await this.store.rejected(account.id, preparationId);
      } else {
        await this.store.unresolved(account.id, preparationId);
        this.log.warn(
          { err: error, account: account.id, grant: claim.grantId },
          'Test token claim needs reconciliation',
        );
      }
    }
    return claimResult(present(await this.store.get(account.id)));
  }

  private async ensureGrant(current: Claim, signer: Signer): Promise<Claim> {
    if (current.grantStatus === 'CONFIRMED') return current;
    if (current.grantStatus !== 'PENDING') throw new Conflict(GRANT_RECONCILING);
    if (!(await this.store.claimGrant(current.accountId, await this.ledger.ledgerEnd()))) {
      throw new Conflict('The test token grant is being prepared');
    }
    const claim = present(await this.store.get(current.accountId));
    try {
      await this.store.confirmGrant(claim.accountId, claim.grantCommandId, await this.ledger.issueGrant(claim, signer));
    } catch (error) {
      if (error instanceof GrantNotSubmitted) {
        await this.store.excludeGrant(claim.accountId, claim.grantCommandId);
        throw new Conflict('The test token grant could not be prepared; retry the request');
      }
      if (error instanceof TokenRejected) {
        await this.store.rejectedGrant(claim.accountId, claim.grantCommandId);
        throw new Conflict('The participant rejected grant creation; retry the request');
      }
      await this.store.unresolvedGrant(claim.accountId, claim.grantCommandId);
      this.log.warn({ err: error, grant: claim.grantId }, 'Test token grant needs reconciliation');
      throw new Conflict(GRANT_RECONCILING);
    }
    return present(await this.store.get(claim.accountId));
  }

  private async reconcile(claim: Claim, signer: Signer): Promise<Claim> {
    if (
      (claim.grantStatus === 'SUBMITTING' || claim.grantStatus === 'UNRESOLVED') &&
      (await this.store.beginGrantRecovery(claim.accountId, claim.grantCommandId))
    ) {
      try {
        const grant = await this.ledger.recoverGrant(claim, signer);
        if (grant) await this.store.confirmGrant(claim.accountId, claim.grantCommandId, grant);
      } catch (error) {
        if (!(error instanceof GrantNotSubmitted)) throw error;
        await this.store.excludeGrant(claim.accountId, claim.grantCommandId);
      }
    }
    if ((claim.status === 'SUBMITTING' || claim.status === 'UNRESOLVED') && claim.preparationId !== null) {
      try {
        const receipt = await this.ledger.recoverClaim(claim, signer);
        if (receipt) await this.store.complete(claim.accountId, claim.preparationId, receipt);
      } catch (error) {
        if (!(error instanceof TokenRejected)) throw error;
        await this.store.rejected(claim.accountId, claim.preparationId);
      }
    }
    return present(await this.store.get(claim.accountId));
  }
}
