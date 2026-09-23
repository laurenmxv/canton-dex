package com.openzeppelin.dex.pools;

import static com.openzeppelin.dex.pools.PoolModels.*;
import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.tokens.InstrumentCatalog;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;

class PoolWorkflowTest {
  private final Account operator =
      new Account(UUID.randomUUID(), "issuer", "operator", "Operator", Account.Role.OPERATOR);
  private final Create input =
      new Create("A/B", new Instrument("admin", "A"), new Instrument("admin", "B"), "30");
  private final Progress store = new Progress();
  private final Ledger ledger = new Ledger();
  private final InstrumentCatalog catalog =
      () ->
          List.of(
              new InstrumentCatalog.Instrument("admin", "A", "A", 6),
              new InstrumentCatalog.Instrument("admin", "B", "B", 6));
  private final PoolWorkflow workflow = new PoolWorkflow(store, ledger, catalog);

  @Test
  void rejectedProposalReleasesPairAndAllowsCorrectedAttempt() {
    ledger.failure = new PoolLedger.Rejected(new IllegalArgumentException("invalid factory"));
    assertThat(workflow.create(input, operator).status()).isEqualTo(Status.FAILED);
    assertThat(store.claimed).isFalse();
    ledger.failure = null;
    assertThat(workflow.create(input, operator).status()).isEqualTo(Status.PENDING);
    assertThat(ledger.submissions).isEqualTo(2);
  }

  @Test
  void rejectedWithdrawalRetainsProposalAndCanBeRetried() {
    var p = workflow.create(input, operator);
    ledger.failure = new PoolLedger.Rejected(new IllegalArgumentException("permission denied"));
    assertThat(workflow.withdraw(p.proposalId(), operator).status()).isEqualTo(Status.PENDING);
    assertThat(store.claimed).isTrue();
    assertThat(store.get(p.proposalId()).error()).isNotBlank();
    ledger.failure = null;
    assertThat(workflow.withdraw(p.proposalId(), operator).status()).isEqualTo(Status.WITHDRAWN);
    assertThat(store.claimed).isFalse();
  }

  @Test
  void lostResponseIsRecoveredWithoutRetryAndKeepsPairReserved() {
    ledger.failure = new IllegalStateException("response lost");
    var p = workflow.create(input, operator);
    assertThat(p.status()).isEqualTo(Status.UNRESOLVED);
    assertThat(store.claimed).isTrue();
    ledger.evidence =
        List.of(new PoolLedger.Confirmation("proposal-cid", Status.PENDING, "update", null));
    new PoolWorkflow(store, ledger, catalog).reconcile();
    assertThat(store.get(p.proposalId()).status()).isEqualTo(Status.PENDING);
    assertThat(ledger.submissions).isEqualTo(1);
  }

  @Test
  void reconciliationFailureRetainsPhaseAndExposesErrorUntilSuccessfulRead() {
    var p = workflow.create(input, operator);
    ledger.recoveryFailure = true;
    workflow.reconcile();
    assertThat(store.get(p.proposalId()).status()).isEqualTo(Status.PENDING);
    assertThat(store.get(p.proposalId()).error()).isNotBlank();
    ledger.recoveryFailure = false;
    workflow.reconcile();
    assertThat(store.get(p.proposalId()).error()).isNull();
    assertThat(ledger.submissions).isEqualTo(1);
  }

  private static final class Ledger implements PoolLedger {
    RuntimeException failure;
    boolean recoveryFailure;
    int submissions;
    List<Confirmation> evidence = List.of();

    public String operator() {
      return "operator";
    }

    public String packageId() {
      return "package";
    }

    public long offset() {
      return 42;
    }

    public String factory(String dvo) {
      return "factory";
    }

    public List<Detail> pools(Map<String, String> names, String dvo) {
      return List.of();
    }

    public Confirmation propose(Proposal p, UUID command) {
      submissions++;
      if (failure != null) throw failure;
      return new Confirmation("proposal-cid", Status.PENDING, "update", null);
    }

    public Confirmation withdraw(Proposal p, UUID command) {
      submissions++;
      if (failure != null) throw failure;
      return new Confirmation(p.proposalCid(), Status.WITHDRAWN, "withdraw", null);
    }

    public List<Confirmation> recover(Pending p) {
      assertThat(p.beginOffset()).isEqualTo(42);
      if (recoveryFailure) throw new IllegalStateException("ledger unavailable");
      return evidence;
    }
  }

  private static final class Progress extends PoolStore {
    Proposal proposal;
    boolean claimed;

    Progress() {
      super(null, null, null);
    }

    public String dvo() {
      return "dvo";
    }

    public Map<String, String> names() {
      return Map.of();
    }

    public Proposal reserve(
        UUID id, Create input, ProposalTerms terms, String factoryId, UUID account, long offset) {
      if (claimed) throw new PoolConflict("Pair claimed");
      claimed = true;
      proposal =
          new Proposal(
              id,
              input.name(),
              terms,
              Status.SUBMITTING,
              Instant.EPOCH,
              Instant.EPOCH,
              "Operator",
              null,
              factoryId,
              null,
              null,
              null);
      return proposal;
    }

    public Proposal get(UUID id) {
      return proposal;
    }

    public List<Pending> pending() {
      return List.of(new Pending(proposal, proposal.proposalId(), 42));
    }

    public void proposed(UUID id, String cid, String updateId) {
      phase(Status.PENDING, cid, null);
    }

    public void unresolved(UUID id) {
      phase(Status.UNRESOLVED, proposal.proposalCid(), "Confirmation pending");
    }

    public void failedSubmission(UUID id, boolean withdrawal) {
      phase(
          withdrawal ? Status.PENDING : Status.FAILED, proposal.proposalCid(), "Command rejected");
      if (!withdrawal) claimed = false;
    }

    public boolean claimWithdrawal(UUID id, UUID command) {
      if (proposal.status() != Status.PENDING) return false;
      phase(Status.SUBMITTING, proposal.proposalCid(), null);
      return true;
    }

    public void finish(UUID id, Status status, String update, Detail detail) {
      phase(status, proposal.proposalCid(), null);
      claimed = detail != null;
    }

    public void reconciliationError(UUID id, boolean failed) {
      phase(proposal.status(), proposal.proposalCid(), failed ? "Refresh failed" : null);
    }

    void phase(Status status, String cid, String error) {
      proposal =
          new Proposal(
              proposal.proposalId(),
              proposal.name(),
              proposal.settings(),
              status,
              proposal.createdAt(),
              proposal.updatedAt(),
              proposal.proposedBy(),
              cid,
              proposal.factoryId(),
              null,
              null,
              error);
    }
  }
}
