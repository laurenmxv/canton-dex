package com.openzeppelin.dex.settlements;

import static com.openzeppelin.dex.settlements.SettlementModels.*;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.swaps.LedgerRejected;
import com.openzeppelin.dex.swaps.SwapFailure;
import com.openzeppelin.dex.swaps.SwapModels.Swap;
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

  public Policy policy(String poolId, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    return store.policy(poolId);
  }

  public Policy updatePolicy(String poolId, UpdatePolicy input, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    return store.updatePolicy(poolId, input, clock.instant());
  }

  public Settlement run(String poolId, RunInput input, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    Optional<Settlement> existing = store.find(input.idempotencyKey());
    if (existing.isPresent()) return samePool(existing.get(), poolId);
    Snapshot snapshot = ledger.snapshot(poolId);
    requireReady(snapshot);
    Optional<Pending> claimed =
        store.claim(poolId, input.idempotencyKey(), Trigger.MANUAL, snapshot, clock.instant());
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

  public List<Swap> queue(String poolId, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    return store.queue(poolId);
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
        if (!"READY".equals(snapshot.health())) continue;
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
    if (!"READY".equals(snapshot.health())) {
      store.cancelPreparation(id, "POOL_NOT_READY", snapshot.reason(), clock.instant());
      return;
    }
    try {
      requireReady(snapshot);
      List<Swap> swaps = pending.swaps();
      while (!swaps.isEmpty()) {
        try {
          List<Fill> fills = ledger.preflight(snapshot, swaps);
          validateFills(swaps, fills);
          store.authorizeDispatch(id, fills, snapshot, clock.instant()).ifPresent(this::submit);
          return;
        } catch (SettlementLedger.Blocked blocked) {
          int index = indexOf(swaps, blocked.swapId());
          if (index < 0)
            throw new IllegalStateException(
                "Preflight blocked a request outside this batch", blocked);
          if (pending.settlement().trigger() == Trigger.AUTOMATIC) {
            store.rejectPreparation(
                id,
                blocked.swapId(),
                blocked.code(),
                blocked.getMessage(),
                snapshot.version(),
                clock.instant());
            return;
          }
          swaps = swaps.subList(0, index);
          if (!store.keepPrefix(
              id,
              swaps.stream().map(Swap::swapId).toList(),
              blocked.swapId(),
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
          "IDEMPOTENCY_CONFLICT", "This settlement key belongs to another pool");
    return batch;
  }

  private static void requireReady(Snapshot snapshot) {
    if (!"READY".equals(snapshot.health()))
      throw SwapFailure.conflict(
          "POOL_NOT_READY", "Pool is not ready for settlement: " + snapshot.health());
    if (snapshot.reserves() == null
        || new BigDecimal(snapshot.reserves().baseReserve()).signum() <= 0
        || new BigDecimal(snapshot.reserves().quoteReserve()).signum() <= 0)
      throw SwapFailure.conflict("POOL_NOT_READY", "Pool reserves must be positive");
  }

  private static int indexOf(List<Swap> swaps, UUID swapId) {
    for (int i = 0; i < swaps.size(); i++) if (swaps.get(i).swapId().equals(swapId)) return i;
    return -1;
  }

  private static void validateFills(List<Swap> swaps, List<Fill> fills) {
    if (!swaps.stream()
        .map(Swap::swapId)
        .toList()
        .equals(fills.stream().map(Fill::swapId).toList()))
      throw new IllegalStateException("Preflight outputs do not match the FIFO batch");
    for (int i = 0; i < swaps.size(); i++) {
      BigDecimal amount = new BigDecimal(fills.get(i).amountOut());
      if (amount.signum() <= 0 || amount.compareTo(new BigDecimal(swaps.get(i).minOut())) < 0)
        throw new SettlementLedger.Blocked(
            swaps.get(i).swapId(), "MIN_OUT", "Minimum output cannot be met");
    }
  }
}
