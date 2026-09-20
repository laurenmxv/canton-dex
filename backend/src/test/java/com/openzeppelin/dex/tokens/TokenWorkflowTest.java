package com.openzeppelin.dex.tokens;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.onboarding.Onboarding;
import com.openzeppelin.dex.tokens.TokenModels.*;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

class TokenWorkflowTest {
  private final Account trader =
      new Account(UUID.randomUUID(), "issuer", "subject", "Trader", Account.Role.TRADER);
  private final MemoryStore store = new MemoryStore();
  private final Ledger ledger = new Ledger();
  private final TokenWorkflow workflow = new TokenWorkflow(store, ledger);

  @Test
  void repeatPreparationAndSubmissionDoNotMintTwice() {
    var first = workflow.prepare(trader, "caller-token");
    var repeated = workflow.prepare(trader, "caller-token");
    assertThat(repeated).isEqualTo(first);
    assertThat(ledger.grants).isEqualTo(1);
    assertThat(ledger.preparations).isEqualTo(1);
    var submission = new Submission(first.preparationId(), "valid");
    assertThat(workflow.submit(trader, "caller-token", submission).status())
        .isEqualTo(Status.COMPLETED);
    assertThat(workflow.submit(trader, "caller-token", submission).status())
        .isEqualTo(Status.COMPLETED);
    assertThat(ledger.claims).isEqualTo(1);
    assertThatThrownBy(() -> workflow.prepare(trader, "caller-token"))
        .isInstanceOf(TokenConflict.class);
  }

  @Test
  void lostClaimResponseIsRecoveredWithoutResubmission() {
    var preparation = workflow.prepare(trader, "caller-token");
    ledger.loseClaimResponse = true;
    var submission = new Submission(preparation.preparationId(), "valid");
    assertThat(workflow.submit(trader, "caller-token", submission).status())
        .isEqualTo(Status.UNRESOLVED);
    assertThatThrownBy(() -> workflow.prepare(trader, "caller-token"))
        .isInstanceOf(TokenConflict.class);
    assertThat(workflow.submit(trader, "caller-token", submission).status())
        .isEqualTo(Status.UNRESOLVED);
    assertThat(ledger.claims).isEqualTo(1);
    ledger.recoveredClaim = new Confirmation("receipt", "claim-update");
    assertThat(workflow.status(trader).status()).isEqualTo(Status.COMPLETED);
    assertThat(workflow.status(trader).updateId()).isEqualTo("claim-update");
    assertThat(ledger.claims).isEqualTo(1);
  }

  @Test
  void uncertainGrantIsNeverIssuedAgain() {
    ledger.loseGrantResponse = true;
    assertThatThrownBy(() -> workflow.prepare(trader, "caller-token"))
        .isInstanceOf(TokenConflict.class);
    assertThat(workflow.status(trader).status()).isEqualTo(Status.UNRESOLVED);
    assertThatThrownBy(() -> workflow.prepare(trader, "caller-token"))
        .isInstanceOf(TokenConflict.class);
    assertThat(ledger.grants).isEqualTo(1);
    ledger.recoveredGrant = new Confirmation("grant", "grant-update");
    workflow.prepare(trader, "caller-token");
    assertThat(ledger.grants).isEqualTo(1);
    assertThat(ledger.preparations).isEqualTo(1);
  }

  @Test
  void malformedSignatureDoesNotClaimSubmissionOrCallLedger() {
    var preparation = workflow.prepare(trader, "caller-token");
    assertThatThrownBy(
            () ->
                workflow.submit(
                    trader, "caller-token", new Submission(preparation.preparationId(), "invalid")))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(store.current.status()).isEqualTo(Status.PREPARED);
    assertThat(ledger.claims).isZero();
  }

  @Test
  void foreignPreparationDoesNotChangeClaim() {
    workflow.prepare(trader, "caller-token");
    assertThatThrownBy(
            () ->
                workflow.submit(trader, "caller-token", new Submission(UUID.randomUUID(), "valid")))
        .isInstanceOf(TokenConflict.class);
    assertThat(store.current.status()).isEqualTo(Status.PREPARED);
    assertThat(ledger.claims).isZero();
  }

  @Test
  void definitiveClaimRejectionAllowsFreshPreparation() {
    var preparation = workflow.prepare(trader, "caller-token");
    ledger.rejectClaim = true;
    assertThat(
            workflow
                .submit(
                    trader, "caller-token", new Submission(preparation.preparationId(), "valid"))
                .status())
        .isEqualTo(Status.AVAILABLE);
    ledger.rejectClaim = false;
    var fresh = workflow.prepare(trader, "caller-token");
    assertThat(fresh.preparationId()).isNotEqualTo(preparation.preparationId());
    assertThat(ledger.grants).isEqualTo(1);
    assertThat(
            workflow
                .submit(trader, "caller-token", new Submission(fresh.preparationId(), "valid"))
                .status())
        .isEqualTo(Status.COMPLETED);
  }

  @Test
  void provenExpiredClaimWithoutEffectAllowsFreshWalletSignature() {
    var original = workflow.prepare(trader, "caller-token");
    ledger.loseClaimResponse = true;
    workflow.submit(trader, "caller-token", new Submission(original.preparationId(), "valid"));
    ledger.provenMissingClaim = true;
    assertThat(workflow.status(trader).status()).isEqualTo(Status.AVAILABLE);
    var fresh = workflow.prepare(trader, "caller-token");
    assertThat(fresh.preparationId()).isNotEqualTo(original.preparationId());
    assertThat(ledger.grants).isEqualTo(1);
  }

  @Test
  void recoveryStartedBeforeLateRejectionKeepsOriginalGrantAttempt() {
    ledger.loseGrantResponse = true;
    assertThatThrownBy(() -> workflow.prepare(trader, "caller-token"))
        .isInstanceOf(TokenConflict.class);
    var original = store.current;
    workflow.status(trader);
    store.rejectedGrant(trader.id(), original.grantCommandId());
    assertThat(store.current.grantStatus()).isEqualTo(GrantStatus.UNRESOLVED);
    assertThat(store.current.grantCommandId()).isEqualTo(original.grantCommandId());
    assertThat(ledger.grants).isEqualTo(1);
  }

  @ParameterizedTest
  @EnumSource(ClaimOutcome.class)
  void replacedPreparationCannotBeExecutedOrChangedByEarlierSubmission(ClaimOutcome outcome) {
    var original = workflow.prepare(trader, "caller-token");
    var originalPrepared = store.current.prepared();
    var replacementId = UUID.randomUUID();
    var replacementPrepared =
        new Prepared(
            "replacement-transaction", "replacement-hash", 3, Instant.now().plusSeconds(300));
    store.afterClaimSubmission =
        () -> {
          store.rejected(trader.id(), original.preparationId());
          store.savePreparation(trader.id(), replacementId, replacementPrepared);
          store.claimSubmission(trader.id(), replacementId, 200);
        };
    ledger.rejectClaim = outcome == ClaimOutcome.REJECTED;
    ledger.loseClaimResponse = outcome == ClaimOutcome.UNKNOWN;

    var result =
        workflow.submit(trader, "caller-token", new Submission(original.preparationId(), "valid"));

    assertThat(ledger.submittedClaim.preparationId()).isEqualTo(original.preparationId());
    assertThat(ledger.submittedClaim.prepared()).isEqualTo(originalPrepared);
    assertThat(ledger.submittedClaim.claimBeginOffset()).isEqualTo(100);
    assertThat(result.status()).isEqualTo(Status.SUBMITTING);
    assertThat(store.current.preparationId()).isEqualTo(replacementId);
    assertThat(store.current.prepared()).isEqualTo(replacementPrepared);
    assertThat(store.current.claimBeginOffset()).isEqualTo(200);
    assertThat(store.current.updateId()).isNull();
    assertThat(store.current.errorCode()).isNull();
  }

  private enum ClaimOutcome {
    SUCCESS,
    REJECTED,
    UNKNOWN
  }

  private static final class Ledger implements TokenLedger {
    int grants, preparations, claims;
    boolean loseGrantResponse, loseClaimResponse, rejectClaim, provenMissingClaim;
    Confirmation recoveredGrant, recoveredClaim;
    Claim submittedClaim;

    public long ledgerEnd() {
      return 100;
    }

    public Confirmation issueGrant(Claim claim, Signer signer) {
      grants++;
      if (loseGrantResponse) throw new IllegalStateException("response lost");
      return new Confirmation("grant", "grant-update");
    }

    public Optional<Confirmation> recoverGrant(Claim claim, Signer signer) {
      return Optional.ofNullable(recoveredGrant);
    }

    public Prepared prepareClaim(Claim claim, Signer signer, String token, Instant expiresAt) {
      preparations++;
      return new Prepared("transaction", "hash", 3, expiresAt);
    }

    public Confirmation claim(Claim claim, Signer signer, String token, String signature) {
      claims++;
      submittedClaim = claim;
      if (rejectClaim) throw new TokenLedger.Rejected("Rejected before submission", null);
      if (loseClaimResponse) throw new IllegalStateException("response lost");
      return new Confirmation("receipt", "claim-update");
    }

    public Optional<Confirmation> recoverClaim(Claim claim, Signer signer) {
      if (provenMissingClaim)
        throw new TokenLedger.Rejected("Deadline passed with complete empty history", null);
      return Optional.ofNullable(recoveredClaim);
    }

    public Balances balances(Signer signer, String token) {
      return new Balances(List.of(), 100);
    }

    public void verify(Claim claim, Signer signer, String signature) {
      if (!signature.equals("valid")) throw new IllegalArgumentException("Invalid signature");
    }
  }

  private static final class MemoryStore extends TokenStore {
    Claim current;
    Runnable afterClaimSubmission;

    MemoryStore() {
      super(null);
    }

    @Override
    public Registry registry() {
      return new Registry("issuer", "rules", "package", "factory", "blob", "sync");
    }

    @Override
    public List<Token> tokens() {
      return List.of(new Token("USDC", "USDC", 6, "10000"));
    }

    @Override
    public Signer signer(Account account) {
      account.requireRole(Account.Role.TRADER);
      return new Signer(
          account.subject(),
          new Onboarding.PartyPreparation(
              UUID.randomUUID(),
              "trader",
              true,
              "public-key",
              "fingerprint",
              "hash",
              "sync",
              "CONFIRMED",
              "participant",
              List.of()));
    }

    @Override
    public Claim initialize(UUID id, String partyId) {
      if (current == null)
        current =
            new Claim(
                id,
                UUID.randomUUID(),
                UUID.randomUUID(),
                null,
                null,
                GrantStatus.PENDING,
                null,
                null,
                null,
                Status.AVAILABLE,
                null,
                null,
                null);
      return current;
    }

    @Override
    public Optional<Claim> get(UUID id) {
      return Optional.ofNullable(current);
    }

    @Override
    public boolean claimGrant(UUID id, long offset) {
      if (current.grantStatus() != GrantStatus.PENDING) return false;
      current =
          new Claim(
              id,
              current.grantId(),
              current.grantCommandId(),
              null,
              offset,
              GrantStatus.SUBMITTING,
              null,
              null,
              null,
              Status.AVAILABLE,
              null,
              null,
              null);
      return true;
    }

    @Override
    public void confirmGrant(UUID id, UUID commandId, Confirmation confirmation) {
      current =
          new Claim(
              id,
              current.grantId(),
              current.grantCommandId(),
              confirmation.contractId(),
              current.grantBeginOffset(),
              GrantStatus.CONFIRMED,
              current.preparationId(),
              current.prepared(),
              current.claimBeginOffset(),
              current.status(),
              null,
              null,
              null);
    }

    @Override
    public boolean beginGrantRecovery(UUID id, UUID commandId) {
      if (!current.grantCommandId().equals(commandId)
          || (current.grantStatus() != GrantStatus.SUBMITTING
              && current.grantStatus() != GrantStatus.UNRESOLVED)) return false;
      unresolvedGrant(id, commandId);
      return true;
    }

    @Override
    public void unresolvedGrant(UUID id, UUID commandId) {
      current =
          new Claim(
              id,
              current.grantId(),
              current.grantCommandId(),
              null,
              current.grantBeginOffset(),
              GrantStatus.UNRESOLVED,
              null,
              null,
              null,
              Status.AVAILABLE,
              null,
              "GRANT_UNRESOLVED",
              "Checking grant");
    }

    @Override
    public boolean savePreparation(UUID id, UUID preparationId, Prepared prepared) {
      current =
          new Claim(
              id,
              current.grantId(),
              current.grantCommandId(),
              current.grantCid(),
              current.grantBeginOffset(),
              current.grantStatus(),
              preparationId,
              prepared,
              null,
              Status.PREPARED,
              null,
              null,
              null);
      return true;
    }

    @Override
    public boolean claimSubmission(UUID id, UUID preparationId, long offset) {
      if (current.status() != Status.PREPARED || !current.preparationId().equals(preparationId))
        return false;
      current =
          new Claim(
              id,
              current.grantId(),
              current.grantCommandId(),
              current.grantCid(),
              current.grantBeginOffset(),
              current.grantStatus(),
              current.preparationId(),
              current.prepared(),
              offset,
              Status.SUBMITTING,
              null,
              null,
              null);
      if (afterClaimSubmission != null) {
        var callback = afterClaimSubmission;
        afterClaimSubmission = null;
        callback.run();
      }
      return true;
    }

    @Override
    public void complete(UUID id, UUID preparationId, Confirmation confirmation) {
      if (!matchesPending(preparationId)) return;
      state(Status.COMPLETED, confirmation.updateId());
    }

    @Override
    public void rejected(UUID id, UUID preparationId) {
      if (!matchesPending(preparationId)) return;
      current =
          new Claim(
              id,
              current.grantId(),
              current.grantCommandId(),
              current.grantCid(),
              current.grantBeginOffset(),
              current.grantStatus(),
              current.preparationId(),
              null,
              current.claimBeginOffset(),
              Status.AVAILABLE,
              null,
              "CLAIM_REJECTED",
              "Rejected");
    }

    @Override
    public void rejectedGrant(UUID id, UUID commandId) {
      if (current.grantStatus() != GrantStatus.SUBMITTING
          || !current.grantCommandId().equals(commandId)) return;
      current =
          new Claim(
              id,
              current.grantId(),
              current.grantCommandId(),
              null,
              current.grantBeginOffset(),
              GrantStatus.PENDING,
              null,
              null,
              null,
              Status.AVAILABLE,
              null,
              "GRANT_REJECTED",
              "Rejected");
    }

    @Override
    public void unresolved(UUID id, UUID preparationId) {
      if (!matchesPending(preparationId) || current.status() != Status.SUBMITTING) return;
      state(Status.UNRESOLVED, null);
    }

    private boolean matchesPending(UUID preparationId) {
      return current.preparationId().equals(preparationId)
          && (current.status() == Status.SUBMITTING || current.status() == Status.UNRESOLVED);
    }

    private void state(Status status, String updateId) {
      current =
          new Claim(
              current.accountId(),
              current.grantId(),
              current.grantCommandId(),
              current.grantCid(),
              current.grantBeginOffset(),
              current.grantStatus(),
              current.preparationId(),
              current.prepared(),
              current.claimBeginOffset(),
              status,
              updateId,
              null,
              null);
    }
  }
}
