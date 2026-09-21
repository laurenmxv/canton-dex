package com.openzeppelin.dex.pools;

import static com.openzeppelin.dex.pools.PoolModels.*;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.tokens.InstrumentCatalog;
import java.time.Instant;
import java.util.*;
import org.slf4j.*;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public final class PoolWorkflow {
  private static final Logger LOG = LoggerFactory.getLogger(PoolWorkflow.class);
  private final PoolStore store;
  private final PoolLedger ledger;
  private final InstrumentCatalog catalog;
  private Instant refreshed = Instant.EPOCH;

  public PoolWorkflow(PoolStore store, PoolLedger ledger, InstrumentCatalog catalog) {
    this.store = store;
    this.ledger = ledger;
    this.catalog = catalog;
  }

  /**
   * What a proposal may be built from.
   *
   * <p>The instruments are the ones the venue has registered, which is the same catalogue every
   * balance is read against.
   */
  public Options options() {
    try {
      return new Options(
          ledger.factory(store.dvo()),
          store.dvo(),
          ledger.operator(),
          catalog.instruments().stream().map(PoolWorkflow::registered).toList());
    } catch (RuntimeException e) {
      LOG.warn("Pool settings could not be read: {}", e.toString());
      throw new PoolUnavailable("Pool settings could not be read. Try again.");
    }
  }

  private static RegisteredInstrument registered(InstrumentCatalog.Instrument instrument) {
    return new RegisteredInstrument(
        instrument.admin(), instrument.id(), instrument.symbol(), instrument.decimals());
  }

  public synchronized Proposal create(Create input, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    var options = options();
    Terms terms;
    try {
      terms = input.terms(options);
    } catch (IllegalArgumentException e) {
      // The venue answers a caller error with one fixed sentence, so the reason
      // the proposal was refused is only ever readable here.
      LOG.info("Pool proposal refused: {}", e.getMessage());
      throw e;
    }
    refreshPools();
    UUID id = UUID.randomUUID();
    long offset = ledger.offset();
    var proposal = store.reserve(id, input, terms, options.factoryId(), caller.id(), offset);
    try {
      apply(id, ledger.propose(proposal, id));
    } catch (PoolLedger.Rejected e) {
      store.failedSubmission(id, false);
      LOG.warn("Pool proposal {} rejected: {}", id, e.getCause().toString());
    } catch (RuntimeException e) {
      store.unresolved(id);
      LOG.warn("Pool proposal {} awaits confirmation: {}", id, e.toString());
    }
    return store.get(id);
  }

  public synchronized Proposal withdraw(UUID id, Account caller) {
    caller.requireRole(Account.Role.OPERATOR);
    var p = store.get(id);
    if (p.status() == Status.WITHDRAWN) return p;
    UUID command = UUID.randomUUID();
    if (!store.claimWithdrawal(id, command))
      throw new PoolConflict("Only a pending proposal can be withdrawn");
    try {
      apply(id, ledger.withdraw(p, command));
    } catch (PoolLedger.Rejected e) {
      store.failedSubmission(id, true);
      LOG.warn("Pool withdrawal {} rejected: {}", id, e.getCause().toString());
    } catch (RuntimeException e) {
      store.unresolved(id);
      LOG.warn("Pool withdrawal {} awaits confirmation: {}", id, e.toString());
    }
    return store.get(id);
  }

  public synchronized List<Detail> pools() {
    if (refreshed.isBefore(Instant.now().minusSeconds(10))) refreshPools();
    return store.pools(ledger.packageId());
  }

  public synchronized Detail pool(String id) {
    pools();
    return store.pool(id, ledger.packageId());
  }

  private void refreshPools() {
    try {
      for (var pool : ledger.pools(store.names(), store.dvo())) store.save(pool);
      refreshed = Instant.now();
    } catch (RuntimeException e) {
      LOG.warn("Pool refresh failed: {}", e.toString());
      throw new PoolUnavailable("Pools could not be refreshed. Try again.");
    }
  }

  @Scheduled(fixedDelay = 3000)
  public synchronized void reconcile() {
    for (var pending : store.pending()) {
      try {
        for (var result : ledger.recover(pending)) apply(pending.proposal().proposalId(), result);
        store.reconciliationError(pending.proposal().proposalId(), false);
      } catch (RuntimeException e) {
        store.reconciliationError(pending.proposal().proposalId(), true);
        LOG.warn(
            "Pool proposal {} reconciliation failed: {}",
            pending.proposal().proposalId(),
            e.toString());
      }
    }
  }

  private void apply(UUID id, PoolLedger.Confirmation c) {
    if (c.status() == Status.PENDING) store.proposed(id, c.proposalCid(), c.updateId());
    else {
      store.finish(id, c.status(), c.updateId(), c.pool());
      if (c.status() == Status.CREATED) refreshed = Instant.EPOCH;
    }
  }
}
