package com.openzeppelin.dex.onboarding;

import com.openzeppelin.dex.iam.Account;
import java.util.UUID;
import org.slf4j.*;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public final class OnboardingWorkflow {
  private static final Logger LOG = LoggerFactory.getLogger(OnboardingWorkflow.class);
  private final OnboardingStore store;
  private final OnboardingLedger ledger;
  private final ExternalParties parties;

  public OnboardingWorkflow(
      OnboardingStore store, OnboardingLedger ledger, ExternalParties parties) {
    this.store = store;
    this.ledger = ledger;
    this.parties = parties;
  }

  public Onboarding review(UUID id, Account caller, ReviewDecision decision, String accessToken) {
    store.review(id, caller, decision, accessToken);
    return store.get(id);
  }

  public Onboarding submitParty(
      UUID id, Account caller, PartySubmission submission, String accessToken) {
    if (store.claimParty(id, caller, submission)) {
      try {
        parties.allocate(
            caller, accessToken, store.get(id).party(), store.topology(id), submission.signature());
        if (parties.confirmed(accessToken, store.get(id).party())) store.confirmParty(id);
        else store.unresolvedParty(id);
      } catch (org.springframework.security.access.AccessDeniedException e) {
        store.deniedParty(id);
        throw e;
      } catch (RuntimeException e) {
        store.unresolvedParty(id);
        LOG.warn("External party submission {} needs reconciliation: {}", id, e.toString());
      }
    }
    return store.getOwned(id, caller);
  }

  public Onboarding mine(Account caller, String accessToken) {
    return refreshParty(store.mine(caller), caller, accessToken);
  }

  public Onboarding getOwned(UUID id, Account caller, String accessToken) {
    return refreshParty(store.getOwned(id, caller), caller, accessToken);
  }

  private Onboarding refreshParty(Onboarding current, Account caller, String accessToken) {
    if (current != null
        && current.party() != null
        && !current.party().confirmed()
        && java.util.Set.of("SUBMITTING", "UNRESOLVED").contains(current.party().status())) {
      boolean confirmed;
      try {
        confirmed = parties.confirmed(accessToken, current.party());
      } catch (RuntimeException e) {
        store.unresolvedParty(current.id());
        LOG.warn("External party {} remains unconfirmed: {}", current.id(), e.toString());
        return store.getOwned(current.id(), caller);
      }
      if (confirmed) store.confirmParty(current.id());
      else store.unresolvedParty(current.id());
      return store.getOwned(current.id(), caller);
    }
    return current;
  }

  @Scheduled(fixedDelay = 3000)
  public synchronized void reconcile() {
    for (UUID id : store.pending()) {
      try {
        advance(id);
      } catch (RuntimeException e) {
        LOG.warn("Onboarding {} remains pending: {}", id, e.toString());
      }
    }
  }

  private void advance(UUID id) {
    var current = store.get(id);
    // A fresh owner request reconciles registration; the worker never stores user tokens.
    if (!current.party().confirmed()) return;
    store.initializeLedgerSteps(id);
    current = store.get(id);
    String attestationId = null;
    for (var step : current.ledgerSteps()) {
      if (step.status() == LedgerStep.Status.CONFIRMED) {
        if (step.key().equals("attestation")) attestationId = step.contractId();
        continue;
      }
      try {
        OnboardingLedger.Confirmation result;
        if (step.status() == LedgerStep.Status.PENDING) {
          long offset = ledger.ledgerEnd();
          if (!store.claim(id, step, offset)) return;
          result =
              step.key().equals("attestation")
                  ? ledger.attest(
                      step.commandId().toString(),
                      current.party().partyId(),
                      current.review().approvedPoolIds())
                  : ledger.grantAccess(
                      step.commandId().toString(),
                      current.party().partyId(),
                      step.key().substring("access:".length()),
                      attestationId);
        } else {
          Long offset = store.beginOffset(id, step);
          if (offset == null) return;
          var recovered = ledger.recover(offset, step, current, attestationId);
          if (recovered.isEmpty()) {
            store.unresolved(id, step);
            return;
          }
          result = recovered.get();
        }
        store.confirmed(id, step, result);
        if (step.key().equals("attestation")) attestationId = result.contractId();
      } catch (RuntimeException e) {
        store.unresolved(id, step);
        LOG.warn(
            "Onboarding {} command {} needs reconciliation: {}",
            id,
            step.commandId(),
            e.toString());
        return;
      }
    }
  }
}
