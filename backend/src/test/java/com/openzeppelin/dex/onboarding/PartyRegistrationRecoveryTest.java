package com.openzeppelin.dex.onboarding;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.iam.Account;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.security.access.AccessDeniedException;

class PartyRegistrationRecoveryTest {
  private final Account david =
      new Account(UUID.randomUUID(), "issuer", "david", "David", Account.Role.TRADER);
  private final PartySubmission signature = new PartySubmission(UUID.randomUUID(), "signature");

  @Test
  void existingPartyStopsRegistrationWithoutBindingOrIssuingContracts() {
    var store = new Progress();
    var parties = new Parties();
    parties.failure = new PartyAlreadyExists();
    parties.confirmed = true;
    var workflow = new OnboardingWorkflow(store, null, parties);
    parties.duringAllocation =
        () -> {
          workflow.getOwned(store.id, david, "poll-token");
          assertThat(store.status).isEqualTo("SUBMITTING");
          assertThat(parties.confirmations).isZero();
        };
    assertThatThrownBy(() -> workflow.submitParty(store.id, david, signature, "token"))
        .isInstanceOf(PartyAlreadyExists.class);
    assertThat(store.status).isEqualTo("CONFLICT");
    var restarted = new OnboardingWorkflow(store, null, parties);
    assertThat(restarted.getOwned(store.id, david, "fresh-token").party().confirmed()).isFalse();
    assertThatThrownBy(() -> restarted.submitParty(store.id, david, signature, "fresh-token"))
        .isInstanceOf(PartyAlreadyExists.class);
    restarted.reconcile();
    assertThat(store.status).isEqualTo("CONFLICT");
    assertThat(parties.allocations).isEqualTo(1);
    assertThat(parties.confirmations).isZero();
  }

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

  @ParameterizedTest
  @CsvSource({
    "confirmed, true",
    "unconfirmed, true",
    "failed, true",
    "confirmed, false",
    "unconfirmed, false",
    "failed, false"
  })
  void stalePollCannotOverrideARetriedRegistration(String lookupResult, boolean duringRetry)
      throws Exception {
    var store = new Progress();
    var parties = new Parties();
    var workflow = new OnboardingWorkflow(store, null, parties);
    var allocationStarted = new CountDownLatch(1);
    var rejectAllocation = new CountDownLatch(1);
    var snapshotRead = new CountDownLatch(1);
    var returnSnapshot = new CountDownLatch(1);
    var lookupStarted = new CountDownLatch(1);
    var finishLookup = new CountDownLatch(1);
    var retryStarted = new CountDownLatch(1);
    var returnConflict = new CountDownLatch(1);
    parties.failure = new AccessDeniedException("Expired user token");
    parties.duringAllocation = () -> await(allocationStarted, rejectAllocation);
    store.afterOwnedRead =
        () -> {
          store.afterOwnedRead = () -> {};
          await(snapshotRead, returnSnapshot);
        };
    parties.confirmed = lookupResult.equals("confirmed");
    parties.duringConfirmation =
        () -> {
          await(lookupStarted, finishLookup);
          if (lookupResult.equals("failed")) throw new AccessDeniedException("Poll token expired");
        };

    var executor = Executors.newVirtualThreadPerTaskExecutor();
    try {
      var first = executor.submit(() -> workflow.submitParty(store.id, david, signature, "expired"));
      assertThat(allocationStarted.await(5, TimeUnit.SECONDS)).isTrue();
      var poll = executor.submit(() -> workflow.getOwned(store.id, david, "poll-token"));
      assertThat(snapshotRead.await(5, TimeUnit.SECONDS)).isTrue();

      // The GET keeps the old SUBMITTING snapshot after the rejected allocation finishes.
      rejectAllocation.countDown();
      assertThatThrownBy(() -> first.get(5, TimeUnit.SECONDS))
          .hasCauseInstanceOf(AccessDeniedException.class);
      assertThat(store.status).isEqualTo("PREPARED");
      returnSnapshot.countDown();
      assertThat(lookupStarted.await(5, TimeUnit.SECONDS)).isTrue();

      parties.failure = new PartyAlreadyExists();
      parties.duringAllocation = () -> await(retryStarted, returnConflict);
      var retry = executor.submit(() -> workflow.submitParty(store.id, david, signature, "fresh"));
      assertThat(retryStarted.await(5, TimeUnit.SECONDS)).isTrue();
      if (duringRetry) {
        finishLookup.countDown();
        assertThat(poll.get(5, TimeUnit.SECONDS).party().status()).isEqualTo("SUBMITTING");
      }
      returnConflict.countDown();
      assertThatThrownBy(() -> retry.get(5, TimeUnit.SECONDS))
          .hasCauseInstanceOf(PartyAlreadyExists.class);
      if (!duringRetry) {
        finishLookup.countDown();
        assertThat(poll.get(5, TimeUnit.SECONDS).party().status()).isEqualTo("CONFLICT");
      }
      assertThat(workflow.getOwned(store.id, david, "fresh").party().status()).isEqualTo("CONFLICT");
      assertThatThrownBy(() -> workflow.submitParty(store.id, david, signature, "fresh"))
          .isInstanceOf(PartyAlreadyExists.class);
      workflow.reconcile();
      assertThat(parties.allocations).isEqualTo(2);
      assertThat(parties.confirmations).isEqualTo(1);
    } finally {
      rejectAllocation.countDown();
      returnSnapshot.countDown();
      finishLookup.countDown();
      returnConflict.countDown();
      executor.close();
    }
  }

  private static void await(CountDownLatch entered, CountDownLatch released) {
    entered.countDown();
    try {
      assertThat(released.await(5, TimeUnit.SECONDS)).as("Concurrent operation released").isTrue();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new AssertionError(e);
    }
  }

  private final class Progress extends OnboardingStore {
    final UUID id = UUID.randomUUID();
    volatile String status = "PREPARED";
    Runnable afterOwnedRead = () -> {};

    Progress() {
      super(null, null, null, null, null, null);
    }

    @Override
    synchronized boolean claimParty(UUID id, Account caller, PartySubmission submission) {
      assertThat(caller).isEqualTo(david);
      if (status.equals("CONFLICT")) throw new PartyAlreadyExists();
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
    synchronized void unresolvedParty(UUID ignored) {
      if (status.equals("SUBMITTING")) status = "UNRESOLVED";
    }

    @Override
    synchronized void conflictedParty(UUID ignored) {
      if (status.equals("SUBMITTING")) status = "CONFLICT";
    }

    @Override
    synchronized void deniedParty(UUID ignored) {
      if (status.equals("SUBMITTING")) status = "PREPARED";
    }

    @Override
    synchronized void confirmParty(UUID ignored) {
      if (status.equals("CONFIRMED")) return;
      if (!Set.of("SUBMITTING", "UNRESOLVED").contains(status))
        throw new OnboardingConflict("Party was not submitted");
      status = "CONFIRMED";
    }

    @Override
    void initializeLedgerSteps(UUID ignored) {}

    @Override
    public Onboarding getOwned(UUID ignored, Account caller) {
      var current = get(id);
      afterOwnedRead.run();
      return current;
    }

    @Override
    synchronized Onboarding get(UUID ignored) {
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
    int confirmations;
    boolean confirmed;
    RuntimeException failure;
    Runnable duringAllocation = () -> {};
    Runnable duringConfirmation = () -> {};
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
      duringAllocation.run();
      if (failure != null) throw failure;
    }

    public boolean confirmed(String token, Onboarding.PartyPreparation party) {
      confirmations++;
      duringConfirmation.run();
      return confirmed;
    }
  }
}
