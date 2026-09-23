package com.openzeppelin.dex.tokens;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.tokens.TokenModels.*;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class TokenWorkflow {
  private static final Logger LOG = LoggerFactory.getLogger(TokenWorkflow.class);
  private static final Duration SIGNING_WINDOW = Duration.ofMinutes(5);
  private final TokenStore store;
  private final TokenLedger ledger;

  public TokenWorkflow(TokenStore store, TokenLedger ledger) {
    this.store = store;
    this.ledger = ledger;
  }

  public Balances balances(Account account, String callerToken) {
    return ledger.balances(store.signer(account), callerToken);
  }

  public Result status(Account account) {
    var signer = store.signer(account);
    var claim = store.get(account.id());
    if (claim.isEmpty()) return new Result(Status.AVAILABLE, null, null, null);
    return reconcile(claim.get(), signer).result();
  }

  public Preparation prepare(Account account, String callerToken) {
    var signer = store.signer(account);
    var claim = reconcile(store.initialize(account.id(), signer.party().partyId()), signer);
    if (claim.status() == Status.COMPLETED)
      throw new TokenConflict("This account already received its test tokens");
    if (claim.status() == Status.SUBMITTING || claim.status() == Status.UNRESOLVED)
      throw new TokenConflict("The signed claim is being reconciled; do not submit another claim");
    claim = ensureGrant(claim, signer);
    if (claim.prepared() == null || !claim.prepared().expiresAt().isAfter(Instant.now())) {
      var preparationId = UUID.randomUUID();
      var prepared =
          ledger.prepareClaim(claim, signer, callerToken, Instant.now().plus(SIGNING_WINDOW));
      store.savePreparation(account.id(), preparationId, prepared);
      claim = store.get(account.id()).orElseThrow();
    }
    if (claim.status() != Status.PREPARED)
      throw new TokenConflict("The test token claim is already being submitted");
    var issuer = store.registry().issuerPartyId();
    return claim.preparation(signer, store.tokens().stream().map(t -> t.amount(issuer)).toList());
  }

  public Result submit(Account account, String callerToken, Submission submission) {
    var signer = store.signer(account);
    var claim = store.get(account.id()).orElseThrow();
    if (!submission.preparationId().equals(claim.preparationId()))
      throw new TokenConflict("Preparation does not belong to this test token claim");
    if (claim.status() != Status.PREPARED) return reconcile(claim, signer).result();
    if (!claim.prepared().expiresAt().isAfter(Instant.now()))
      throw new TokenConflict("The signing request expired; prepare it again");
    ledger.verify(claim, signer, submission.signature());
    claim = claim.submittingAt(ledger.ledgerEnd());
    if (!store.claimSubmission(account.id(), claim.preparationId(), claim.claimBeginOffset()))
      return store.get(account.id()).orElseThrow().result();
    try {
      store.complete(
          account.id(),
          claim.preparationId(),
          ledger.claim(claim, signer, callerToken, submission.signature()));
    } catch (TokenLedger.Rejected failure) {
      store.rejected(account.id(), claim.preparationId());
    } catch (RuntimeException failure) {
      store.unresolved(account.id(), claim.preparationId());
      LOG.warn(
          "Test token claim needs reconciliation: account={}, grant={}",
          account.id(),
          claim.grantId(),
          failure);
    }
    return store.get(account.id()).orElseThrow().result();
  }

  private Claim ensureGrant(Claim claim, Signer signer) {
    if (claim.grantStatus() == GrantStatus.CONFIRMED) return claim;
    if (claim.grantStatus() != GrantStatus.PENDING)
      throw new TokenConflict(
          "The test token grant is being reconciled; retry after it is confirmed");
    if (!store.claimGrant(claim.accountId(), ledger.ledgerEnd()))
      throw new TokenConflict("The test token grant is being prepared");
    claim = store.get(claim.accountId()).orElseThrow();
    try {
      store.confirmGrant(
          claim.accountId(), claim.grantCommandId(), ledger.issueGrant(claim, signer));
    } catch (TokenLedger.GrantNotSubmitted failure) {
      store.excludeGrant(claim.accountId(), claim.grantCommandId());
      throw new TokenConflict("The test token grant could not be prepared; retry the request");
    } catch (TokenLedger.Rejected failure) {
      store.rejectedGrant(claim.accountId(), claim.grantCommandId());
      throw new TokenConflict("The participant rejected grant creation; retry the request");
    } catch (RuntimeException failure) {
      store.unresolvedGrant(claim.accountId(), claim.grantCommandId());
      LOG.warn("Test token grant needs reconciliation: grant={}", claim.grantId(), failure);
      throw new TokenConflict(
          "The test token grant is being reconciled; retry after it is confirmed");
    }
    return store.get(claim.accountId()).orElseThrow();
  }

  private Claim reconcile(Claim claim, Signer signer) {
    if ((claim.grantStatus() == GrantStatus.SUBMITTING
            || claim.grantStatus() == GrantStatus.UNRESOLVED)
        && store.beginGrantRecovery(claim.accountId(), claim.grantCommandId())) {
      try {
        ledger
            .recoverGrant(claim, signer)
            .ifPresent(c -> store.confirmGrant(claim.accountId(), claim.grantCommandId(), c));
      } catch (TokenLedger.GrantNotSubmitted notSent) {
        store.excludeGrant(claim.accountId(), claim.grantCommandId());
      }
    }
    if (claim.status() == Status.SUBMITTING || claim.status() == Status.UNRESOLVED) {
      try {
        ledger
            .recoverClaim(claim, signer)
            .ifPresent(c -> store.complete(claim.accountId(), claim.preparationId(), c));
      } catch (TokenLedger.Rejected noEffect) {
        store.rejected(claim.accountId(), claim.preparationId());
      }
    }
    return store.get(claim.accountId()).orElseThrow();
  }
}
