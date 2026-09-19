package com.openzeppelin.dex.onboarding;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.iam.Account;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.AccessDeniedException;

class PartyRegistrationRecoveryTest {
  private final Account david =
      new Account(UUID.randomUUID(), "issuer", "david", "David", Account.Role.TRADER);
  private final PartySubmission signature = new PartySubmission(UUID.randomUUID(), "signature");

  @Test
  void uncertainAllocationIsNeverResubmittedAndCanRecoverWithoutTheUserToken() {
    var store = new Progress();
    var parties = new Parties();
    parties.failure = new IllegalStateException("Response lost after possible registration");
    new OnboardingWorkflow(store, null, parties)
        .submitParty(store.id, david, signature, "short-lived-token");
    assertThat(store.status).isEqualTo("UNRESOLVED");
    var restarted = new OnboardingWorkflow(store, null, parties);
    restarted.submitParty(store.id, david, signature, "fresh-token");
    restarted.reconcile();
    assertThat(parties.allocations).isEqualTo(1);
    assertThat(store.status).isEqualTo("UNRESOLVED");
    parties.confirmed = true;
    restarted.getOwned(store.id, david, "new-login-token");
    restarted.reconcile();
    assertThat(store.status).isEqualTo("CONFIRMED");
    assertThat(parties.allocations).isEqualTo(1);
  }

  @Test
  void definitiveAuthorizationRejectionAllowsAManualRetryWithAFreshToken() {
    var store = new Progress();
    var parties = new Parties();
    parties.failure = new AccessDeniedException("Expired user token");
    var workflow = new OnboardingWorkflow(store, null, parties);
    assertThatThrownBy(() -> workflow.submitParty(store.id, david, signature, "expired-token"))
        .isInstanceOf(AccessDeniedException.class);
    assertThat(store.status).isEqualTo("PREPARED");
    parties.failure = null;
    parties.confirmed = true;
    workflow.submitParty(store.id, david, signature, "fresh-token");
    assertThat(store.status).isEqualTo("CONFIRMED");
    assertThat(parties.tokens).containsExactly("expired-token", "fresh-token");
  }

  private final class Progress extends OnboardingStore {
    final UUID id = UUID.randomUUID();
    String status = "PREPARED";

    Progress() {
      super(null, null, null, null, null, null);
    }

    @Override
    boolean claimParty(UUID id, Account caller, PartySubmission submission) {
      assertThat(caller).isEqualTo(david);
      if (!status.equals("PREPARED")) return false;
      status = "SUBMITTING";
      return true;
    }

    @Override
    List<String> topology(UUID ignored) {
      return List.of("original-signed-topology");
    }

    @Override
    List<UUID> pending() {
      return status.equals("UNRESOLVED") ? List.of(id) : List.of();
    }

    @Override
    void unresolvedParty(UUID ignored) {
      status = "UNRESOLVED";
    }

    @Override
    void deniedParty(UUID ignored) {
      status = "PREPARED";
    }

    @Override
    void confirmParty(UUID ignored) {
      status = "CONFIRMED";
    }

    @Override
    void initializeLedgerSteps(UUID ignored) {}

    @Override
    public Onboarding getOwned(UUID ignored, Account caller) {
      return get(id);
    }

    @Override
    Onboarding get(UUID ignored) {
      return new Onboarding(
          id,
          david.id(),
          null,
          status,
          "external",
          Instant.EPOCH,
          null,
          new Onboarding.PartyPreparation(
              signature.preparationId(),
              "david::key",
              status.equals("CONFIRMED"),
              "key",
              "fingerprint",
              "hash",
              "synchronizer",
              status,
              "participant",
              List.of("original-signed-topology")),
          List.of(),
          "david");
    }
  }

  private final class Parties implements ExternalParties {
    int allocations;
    boolean confirmed;
    RuntimeException failure;
    final List<String> tokens = new ArrayList<>();

    public void enableUser(Account operator, String accessToken, Account account) {
      throw new AssertionError("No provisioning during registration recovery");
    }

    public boolean known(String id) {
      return false;
    }

    public Preparation prepare(
        String token, String hint, String key, String sync, String participant) {
      throw new AssertionError();
    }

    public void allocate(
        Account caller,
        String token,
        Onboarding.PartyPreparation party,
        List<String> transactions,
        String signature) {
      assertThat(caller).isEqualTo(david);
      assertThat(transactions).containsExactly("original-signed-topology");
      allocations++;
      tokens.add(token);
      if (failure != null) throw failure;
    }

    public boolean confirmed(String token, Onboarding.PartyPreparation party) {
      return confirmed;
    }
  }
}
