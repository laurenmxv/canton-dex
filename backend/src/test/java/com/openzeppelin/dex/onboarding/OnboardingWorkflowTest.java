package com.openzeppelin.dex.onboarding;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.iam.Account;
import io.grpc.Status;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;

class OnboardingWorkflowTest {
  @Test
  void lostAttestationResponseBlocksAccessAndANewWorkerRecoversWithoutResubmitting() {
    var store = new StoredProgress();
    var ledger = new LostResponseLedger();
    new OnboardingWorkflow(store, ledger, null).reconcile();
    assertThat(store.steps.getFirst().status()).isEqualTo(LedgerStep.Status.UNRESOLVED);
    assertThat(ledger.accesses).isZero();
    assertThat(ledger.submissions).isEqualTo(1);
    ledger.evidence = true;
    // The worker is stateless; a replacement starts exclusively from durable progress.
    new OnboardingWorkflow(store, ledger, null).reconcile();
    assertThat(ledger.submissions).isEqualTo(1);
    assertThat(ledger.accesses).isEqualTo(1);
    assertThat(store.steps).allMatch(s -> s.status() == LedgerStep.Status.CONFIRMED);
    assertThat(store.steps.getFirst().contractId()).isEqualTo("confirmed-attestation");
  }

  @Test
  void inconclusiveEvidenceNeverResendsOrAdvancesDependentPermissions() {
    var store = new StoredProgress();
    var ledger = new LostResponseLedger();
    var worker = new OnboardingWorkflow(store, ledger, null);
    for (int i = 0; i < 4; i++) worker.reconcile();
    assertThat(ledger.submissions).isEqualTo(1);
    assertThat(ledger.accesses).isZero();
    assertThat(store.steps.getFirst().status()).isEqualTo(LedgerStep.Status.UNRESOLVED);
    assertThat(store.steps.get(1).status()).isEqualTo(LedgerStep.Status.PENDING);
  }

  @Test
  void failedPartyLookupPreservesOwnedReadsAsUnresolvedWithoutAdvancingTheLedger() {
    for (String initial : List.of("SUBMITTING", "UNRESOLVED")) {
      var store = new RegistrationProgress(initial);
      var ledger = new LostResponseLedger();
      var parties = new UnconfirmedParty();
      parties.failure = Status.PERMISSION_DENIED.asRuntimeException();
      var workflow = new OnboardingWorkflow(store, ledger, parties);

      var mine = workflow.mine(store.owner, "fresh-owner-token");
      assertThat(mine.id()).isEqualTo(store.id);
      assertThat(mine.party().status()).isEqualTo("UNRESOLVED");
      assertThat(mine.party().confirmed()).isFalse();
      assertThat(workflow.getOwned(store.id, store.owner, "next-owner-token").party().status())
          .isEqualTo("UNRESOLVED");
      workflow.reconcile();
      assertThat(parties.lookups).isEqualTo(2);
      assertThat(ledger.submissions).isZero();
      assertThat(ledger.accesses).isZero();
      assertThat(mine.ledgerSteps()).isEmpty();

      var stranger = new Account(UUID.randomUUID(), "issuer", "bob", "Bob", Account.Role.TRADER);
      assertThatThrownBy(() -> workflow.getOwned(store.id, stranger, "foreign-token"))
          .isInstanceOf(NoSuchElementException.class);
      assertThat(parties.lookups).isEqualTo(2);
    }
  }

  @Test
  void inconclusivePartyLookupAlsoMarksInterruptedSubmissionUnresolved() {
    var store = new RegistrationProgress("SUBMITTING");
    var ledger = new LostResponseLedger();
    var workflow = new OnboardingWorkflow(store, ledger, new UnconfirmedParty());
    assertThat(workflow.mine(store.owner, "fresh-owner-token").party().status())
        .isEqualTo("UNRESOLVED");
    workflow.reconcile();
    assertThat(ledger.submissions).isZero();
    assertThat(ledger.accesses).isZero();
  }

  private static final class UnconfirmedParty implements ExternalParties {
    RuntimeException failure;
    int lookups;

    public void enableUser(Account operator, String accessToken, Account account) {
      throw new AssertionError("Reading an onboarding must not provision a user");
    }

    public Preparation prepare(
        String token, String hint, String key, String sync, String participant) {
      throw new AssertionError("Reading an onboarding must not prepare a party");
    }

    public void allocate(
        Account caller,
        String token,
        Onboarding.PartyPreparation party,
        List<String> transactions,
        String signature) {
      throw new AssertionError("An uncertain allocation must not be resubmitted");
    }

    public boolean confirmed(String token, Onboarding.PartyPreparation party) {
      lookups++;
      if (failure != null) throw failure;
      return false;
    }
  }

  private static final class RegistrationProgress extends OnboardingStore {
    final UUID id = UUID.randomUUID();
    final Account owner =
        new Account(UUID.randomUUID(), "issuer", "david", "David", Account.Role.TRADER);
    String status;

    RegistrationProgress(String status) {
      super(null, null, null, null, null, null);
      this.status = status;
    }

    @Override
    public Onboarding mine(Account caller) {
      return getOwned(id, caller);
    }

    @Override
    public Onboarding getOwned(UUID requested, Account caller) {
      if (!requested.equals(id) || !caller.equals(owner)) throw new NoSuchElementException();
      return get(id);
    }

    @Override
    List<UUID> pending() {
      return List.of(id);
    }

    @Override
    void unresolvedParty(UUID ignored) {
      if (status.equals("SUBMITTING")) status = "UNRESOLVED";
    }

    @Override
    Onboarding get(UUID ignored) {
      return new Onboarding(
          id,
          owner.id(),
          null,
          "PARTY_" + status,
          "external",
          Instant.EPOCH,
          null,
          new Onboarding.PartyPreparation(
              UUID.randomUUID(),
              "david::key",
              false,
              "key",
              "fingerprint",
              "hash",
              "synchronizer",
              status,
              "participant",
              List.of("original-topology")),
          List.of(),
          "david");
    }
  }

  private static final class LostResponseLedger implements OnboardingLedger {
    int submissions;
    int accesses;
    boolean evidence;

    public String packageId() {
      return "package";
    }

    public long ledgerEnd() {
      return 42;
    }

    public Confirmation attest(String commandId, String trader, List<String> pools) {
      submissions++;
      throw new IllegalStateException("Injected loss after ledger acceptance");
    }

    public Confirmation grantAccess(
        String commandId, String trader, String pool, String attestation) {
      assertThat(attestation).isEqualTo("confirmed-attestation");
      accesses++;
      return new Confirmation("confirmed-access", "update-access", "operator");
    }

    public Optional<Confirmation> recover(
        long offset, LedgerStep step, Onboarding onboarding, String attestation) {
      assertThat(offset).isEqualTo(42);
      assertThat(step.key()).isEqualTo("attestation");
      return evidence
          ? Optional.of(new Confirmation("confirmed-attestation", "update-attestation", "operator"))
          : Optional.empty();
    }
  }

  /**
   * A small durable-progress double; PostgreSQL locking is exercised by the integration harness.
   */
  private static final class StoredProgress extends OnboardingStore {
    final UUID id = UUID.randomUUID();
    final List<LedgerStep> steps =
        new ArrayList<>(
            List.of(
                new LedgerStep(
                    "attestation", UUID.randomUUID(), LedgerStep.Status.PENDING, null, null, null),
                new LedgerStep(
                    "access:pool",
                    UUID.randomUUID(),
                    LedgerStep.Status.PENDING,
                    null,
                    null,
                    null)));
    Long offset;

    StoredProgress() {
      super(null, null, null, null, null, null);
    }

    @Override
    List<UUID> pending() {
      return List.of(id);
    }

    @Override
    Onboarding get(UUID ignored) {
      return new Onboarding(
          id,
          UUID.randomUUID(),
          null,
          "LEDGER_PENDING",
          "external",
          Instant.EPOCH,
          new Onboarding.Review(
              ReviewDecision.Decision.APPROVED,
              List.of("pool"),
              UUID.randomUUID(),
              Instant.EPOCH,
              "david"),
          new Onboarding.PartyPreparation(
              UUID.randomUUID(),
              "david",
              true,
              null,
              null,
              null,
              null,
              "CONFIRMED",
              "participant::test",
              List.of()),
          steps,
          "david");
    }

    @Override
    void initializeLedgerSteps(UUID ignored) {}

    @Override
    boolean claim(UUID ignored, LedgerStep step, long beginOffset) {
      offset = beginOffset;
      replace(step, LedgerStep.Status.SUBMITTING, null);
      return true;
    }

    @Override
    Long beginOffset(UUID ignored, LedgerStep step) {
      return offset;
    }

    @Override
    void unresolved(UUID ignored, LedgerStep step) {
      replace(step, LedgerStep.Status.UNRESOLVED, null);
    }

    @Override
    void confirmed(UUID ignored, LedgerStep step, OnboardingLedger.Confirmation result) {
      replace(step, LedgerStep.Status.CONFIRMED, result);
    }

    private void replace(
        LedgerStep step, LedgerStep.Status status, OnboardingLedger.Confirmation result) {
      int i = step.key().equals("attestation") ? 0 : 1;
      steps.set(
          i,
          new LedgerStep(
              step.key(),
              step.commandId(),
              status,
              result == null ? null : result.contractId(),
              result == null ? null : result.updateId(),
              result == null ? null : result.issuer()));
    }
  }
}
