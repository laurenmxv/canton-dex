package com.openzeppelin.dex.settlements;

import static com.openzeppelin.dex.settlements.SettlementModels.*;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.liquidity.LiquidityModels;
import com.openzeppelin.dex.swaps.LedgerRejected;
import com.openzeppelin.dex.swaps.SwapFailure;
import java.math.BigDecimal;
import java.time.Clock;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public final class SettlementWorkflow {
  private static final Logger LOG = LoggerFactory.getLogger(SettlementWorkflow.class);
  private final SettlementStore store;
  private final SettlementLedger ledger;
  private final Clock clock;

  @Autowired
  public SettlementWorkflow(SettlementStore store, SettlementLedger ledger) {
    this(store, ledger, Clock.systemUTC());
  }

  SettlementWorkflow(SettlementStore store, SettlementLedger ledger, Clock clock) {
    this.store = store;
    this.ledger = ledger;
    this.clock = clock;
  }

  public Policy policy(String poolId, String family, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    return store.policy(poolId, family);
  }

  public Policy updatePolicy(String poolId, String family, UpdatePolicy input, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    return store.updatePolicy(poolId, family, input, clock.instant());
  }

  public Settlement run(String poolId, RunInput input, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    Optional<Settlement> existing =
        store.findIntent(poolId, input.idempotencyKey(), input.selection());
    if (existing.isPresent()) return samePool(existing.get(), poolId);
    Snapshot snapshot = ledger.snapshot(poolId);
    requireReady(snapshot);
    Optional<Pending> claimed =
        input.selection() == null
            ? store.claim(poolId, input.idempotencyKey(), Trigger.MANUAL, snapshot, clock.instant())
            : store.claim(
                poolId,
                input.idempotencyKey(),
                Trigger.MANUAL,
                snapshot,
                clock.instant(),
                input.selection());
    if (claimed.isPresent()) prepare(claimed.get(), snapshot);
    return store
        .find(input.idempotencyKey())
        .map(batch -> samePool(batch, poolId))
        .orElseThrow(
            () ->
                SwapFailure.conflict(
                    "QUEUE_NOT_READY", "There is no eligible FIFO prefix to settle"));
  }

  public Settlement get(UUID id, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    return store.get(id);
  }

  public List<Settlement> list(String poolId, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    return store.list(poolId);
  }

  public Monitoring monitoring(String poolId, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    return store.monitoring(poolId, ledger.snapshot(poolId), clock.instant());
  }

  public List<QueueRequest> queue(String poolId, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    return store.queue(poolId);
  }

  public Preview preview(
      String poolId, String family, UUID retryOf, UUID requestId, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    requireFamily(family);
    var snapshot = ledger.snapshot(poolId);
    requireReady(snapshot);
    var plan = store.plan(poolId, family, retryOf, requestId, snapshot, clock.instant());
    var steps =
        plan.requests().isEmpty()
            ? List.<PreviewStep>of()
            : ledger.preview(snapshot, plan.requests());
    if (!steps.stream().map(PreviewStep::request).toList().equals(plan.selection().requests()))
      throw new IllegalStateException("Preview differs from selected requests");
    boolean executable =
        plan.activeSettlementId() == null
            && !steps.isEmpty()
            && steps.stream().allMatch(step -> step.status() == PreviewStatus.VALID);
    return new Preview(plan.selection(), snapshot, steps, plan.activeSettlementId(), executable);
  }

  public void setDeferred(String poolId, RequestRef request, boolean deferred, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    store.setDeferred(poolId, request, deferred, clock.instant());
  }

  public History history(
      String poolId, String type, Status status, String before, int limit, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    return store.history(poolId, type, status, before, limit);
  }

  /** Recovery runs regardless of whether automatic dispatch is enabled. */
  @Scheduled(fixedDelay = 3000)
  public void reconcile() {
    for (Pending pending : store.pending()) {
      UUID id = pending.settlement().settlementId();
      try {
        if (pending.settlement().status() == Status.PREPARING) {
          prepare(pending, ledger.snapshot(pending.settlement().poolId()));
        } else if (store.beginRecovery(id, clock.instant())) {
          ledger.recover(pending).ifPresent(confirmation -> store.confirm(id, confirmation));
        }
      } catch (SettlementLedger.Excluded excluded) {
        store.excludeSubmission(id, excluded.code(), excluded.getMessage(), clock.instant());
      } catch (RuntimeException failure) {
        LOG.warn("Settlement {} reconciliation failed: {}", id, failure.toString());
      }
    }
  }

  @Scheduled(fixedDelay = 3000)
  public void automatic() {
    for (String poolId : store.automaticPools()) {
      try {
        Snapshot snapshot = ledger.snapshot(poolId);
        if (!Set.of("READY", "EMPTY").contains(snapshot.health())) continue;
        requireReady(snapshot);
        store
            .claim(poolId, UUID.randomUUID(), Trigger.AUTOMATIC, snapshot, clock.instant())
            .ifPresent(pending -> prepare(pending, snapshot));
      } catch (RuntimeException failure) {
        LOG.warn("Automatic settlement for pool {} failed: {}", poolId, failure.toString());
      }
    }
  }

  private void prepare(Pending pending, Snapshot snapshot) {
    UUID id = pending.settlement().settlementId();
    if (!Set.of("READY", "EMPTY").contains(snapshot.health())) {
      store.cancelPreparation(id, "POOL_NOT_READY", snapshot.reason(), clock.instant());
      return;
    }
    try {
      requireReady(snapshot);
      List<QueueRequest> requests = pending.requests();
      while (!requests.isEmpty()) {
        try {
          List<Fill> fills = ledger.preflight(snapshot, requests);
          validateFills(requests, fills);
          store.authorizeDispatch(id, fills, snapshot, clock.instant()).ifPresent(this::submit);
          return;
        } catch (SettlementLedger.Blocked blocked) {
          int index = indexOf(requests, blocked.request());
          if (index < 0)
            throw new IllegalStateException(
                "Preflight blocked a request outside this batch", blocked);
          if (pending.selection() != null
              || (pending.settlement().trigger() == Trigger.AUTOMATIC
                  && requests.getFirst() instanceof SwapRequest)) {
            store.rejectPreparation(
                id,
                blocked.request(),
                blocked.code(),
                blocked.getMessage(),
                snapshot.version(),
                clock.instant());
            return;
          }
          requests = requests.subList(0, index);
          if (!store.keepPrefix(
              id,
              requests.stream().map(QueueRequest::reference).toList(),
              blocked.request(),
              blocked.code(),
              blocked.getMessage(),
              snapshot.version(),
              clock.instant())) return;
        }
      }
    } catch (RuntimeException failure) {
      // Nothing has been sent unless authorizeDispatch changed the status; cancellation is CAS
      // protected.
      store.cancelPreparation(
          id, "PREFLIGHT_UNAVAILABLE", "Settlement preflight could not complete", clock.instant());
      LOG.warn("Settlement {} preflight failed: {}", id, failure.toString());
    }
  }

  private void submit(Pending pending) {
    UUID id = pending.settlement().settlementId();
    try {
      Confirmation confirmation = ledger.submit(pending);
      store.confirm(id, confirmation);
    } catch (SettlementLedger.Excluded excluded) {
      store.excludeSubmission(id, excluded.code(), excluded.getMessage(), clock.instant());
    } catch (LedgerRejected rejected) {
      store.rejectSubmission(id, rejected.code(), rejected.getMessage(), clock.instant());
    } catch (RuntimeException uncertain) {
      store.unresolved(id, clock.instant());
      LOG.warn("Settlement {} awaits confirmation: {}", id, uncertain.toString());
    }
  }

  private static Settlement samePool(Settlement batch, String poolId) {
    if (!batch.poolId().equals(poolId))
      throw SwapFailure.conflict(
          IDEMPOTENCY_CONFLICT, "This settlement key belongs to another pool");
    return batch;
  }

  private static void requireReady(Snapshot snapshot) {
    if (!Set.of("READY", "EMPTY").contains(snapshot.health()) || snapshot.reserves() == null)
      throw SwapFailure.conflict(
          "POOL_NOT_READY", "Pool is not ready for settlement: " + snapshot.health());
  }

  private static int indexOf(List<QueueRequest> requests, RequestRef reference) {
    for (int i = 0; i < requests.size(); i++)
      if (requests.get(i).reference().equals(reference)) return i;
    return -1;
  }

  private static void validateFills(List<QueueRequest> requests, List<Fill> fills) {
    if (!requests.stream()
        .map(QueueRequest::reference)
        .toList()
        .equals(fills.stream().map(Fill::reference).toList()))
      throw new IllegalStateException("Preflight outputs do not match the selected requests");
    for (int i = 0; i < requests.size(); i++) {
      var request = requests.get(i);
      var fill = fills.get(i);
      switch (fill) {
        case SwapFill swap ->
            requireOutput(
                swap.amountOut(), ((SwapRequest) request).request().minOut(), request.reference());
        case DepositFill deposit -> {
          var terms = (LiquidityModels.DepositTerms) ((LiquidityRequest) request).request().terms();
          requireOutput(deposit.actualLpOut(), terms.minLpOut(), request.reference());
        }
        case WithdrawalFill withdrawal -> {
          var terms =
              (LiquidityModels.WithdrawalTerms) ((LiquidityRequest) request).request().terms();
          requireOutput(withdrawal.actualBaseOut(), terms.minBaseOut(), request.reference());
          requireOutput(withdrawal.actualQuoteOut(), terms.minQuoteOut(), request.reference());
          if (new BigDecimal(withdrawal.actualLpBurned())
                  .compareTo(new BigDecimal(terms.lpAmount()))
              != 0)
            throw new IllegalStateException("Preflight burn differs from the signed LP amount");
        }
      }
    }
  }

  private static void requireOutput(String actual, String minimum, RequestRef request) {
    var amount = new BigDecimal(actual);
    if (amount.signum() <= 0 || amount.compareTo(new BigDecimal(minimum)) < 0)
      throw new SettlementLedger.Blocked(request, "MIN_OUT", "Minimum output cannot be met");
  }
}
