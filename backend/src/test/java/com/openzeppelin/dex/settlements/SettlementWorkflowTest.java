package com.openzeppelin.dex.settlements;

import static com.openzeppelin.dex.settlements.SettlementModels.*;
import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.liquidity.LiquidityModels;
import com.openzeppelin.dex.pools.PoolModels.Instrument;
import com.openzeppelin.dex.swaps.LedgerRejected;
import com.openzeppelin.dex.swaps.SwapModels;
import com.openzeppelin.dex.swaps.SwapModels.Swap;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class SettlementWorkflowTest {
  private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");
  private static final Clock CLOCK = Clock.fixed(NOW, ZoneOffset.UTC);
  private static final Account OPERATOR =
      new Account(UUID.randomUUID(), "issuer", "operator", "Operator", Account.Role.OPERATOR);
  private static final Reserves RESERVES = new Reserves("state", "100", "200", "2", "20000");
  private static final Snapshot SNAPSHOT =
      new Snapshot("pool", "state-v1", RESERVES, "30", "READY", null, NOW, 42, "100", "2");
  private final Progress store = new Progress();
  private final Ledger ledger = new Ledger();
  private final SettlementWorkflow workflow = new SettlementWorkflow(store, ledger, CLOCK);

  @Test
  void configuredBatchMaximumMustFitTheDamlLimitAtStartup() {
    for (int invalid : new int[] {0, 21, Integer.MIN_VALUE, Integer.MAX_VALUE}) {
      assertThatThrownBy(() -> new SettlementStore(null, null, null, invalid))
          .as("maximum batch size %s", invalid)
          .isInstanceOf(IllegalArgumentException.class);
    }
    for (int supported : new int[] {1, 20}) {
      assertThatCode(() -> new SettlementStore(null, null, null, supported))
          .as("maximum batch size %s", supported)
          .doesNotThrowAnyException();
    }
  }

  @Test
  void manualSettlementAndRepeatedKeySubmitExactlyOnce() {
    store.queued = List.of(swap(1), swap(2));
    RunInput input = new RunInput(UUID.randomUUID());
    Settlement result = workflow.run("pool", input, OPERATOR);
    assertThat(result.status()).isEqualTo(Status.CONFIRMED);
    assertThat(ledger.submitted.requests())
        .extracting(QueueRequest::reference)
        .containsExactly(store.queued.get(0).reference(), store.queued.get(1).reference());
    assertThat(workflow.run("pool", input, OPERATOR)).isEqualTo(result);
    assertThat(ledger.submissions).isEqualTo(1);
    assertThatThrownBy(() -> workflow.run("another-pool", input, OPERATOR))
        .hasMessageContaining("another pool");
  }

  @Test
  void manualPreflightSettlesValidPrefixAndKeepsBlockedSuffixOut() {
    store.queued = List.of(swap(1), swap(2), swap(3));
    ledger.blockedId = store.queued.get(1).reference();
    Settlement result = workflow.run("pool", new RunInput(UUID.randomUUID()), OPERATOR);
    assertThat(result.status()).isEqualTo(Status.CONFIRMED);
    assertThat(ledger.submitted.requests())
        .extracting(QueueRequest::reference)
        .containsExactly(store.queued.getFirst().reference());
    assertThat(store.blocked).isEqualTo(ledger.blockedId);
    assertThat(ledger.preflights).isEqualTo(2);
  }

  @Test
  void automaticNeverSubmitsPartialBatchAfterPreflightFailure() {
    store.queued = List.of(swap(1), swap(2), swap(3));
    store.automaticEnabled = true;
    ledger.blockedId = store.queued.get(1).reference();
    workflow.automatic();
    assertThat(store.batch.status()).isEqualTo(Status.REJECTED);
    assertThat(store.blockedVersion).isEqualTo(SNAPSHOT.version());
    workflow.automatic();
    workflow.automatic();
    assertThat(ledger.preflights).isEqualTo(1);
    assertThat(ledger.submissions).isZero();
  }

  @Test
  void automaticLiquiditySubmitsTheValidPrefixAndReconcilesItAfterALostResponse() {
    for (var kind : LiquidityModels.Kind.values()) {
      var store = new Progress();
      var ledger = new Ledger();
      var workflow = new SettlementWorkflow(store, ledger, CLOCK);
      var first = liquidity(1, kind, LiquidityModels.Status.READY);
      var second = liquidity(2, kind, LiquidityModels.Status.READY);
      var blocked = liquidity(3, kind, LiquidityModels.Status.READY);
      store.queued = List.of(first, second, blocked);
      store.automaticEnabled = true;
      ledger.blockedId = blocked.reference();
      ledger.failure = new IllegalStateException("response lost");
      workflow.automatic();
      assertThat(store.batch.status()).isEqualTo(Status.UNRESOLVED);
      assertThat(ledger.submitted.requests()).containsExactly(first, second);
      assertThat(store.blocked).isEqualTo(blocked.reference());
      assertThat(ledger.preflights).isEqualTo(2);
      ledger.evidence = Optional.of(confirmation(ledger.submitted));
      new SettlementWorkflow(store, ledger, CLOCK).reconcile();
      assertThat(store.batch.status()).isEqualTo(Status.CONFIRMED);
      assertThat(store.batch.fills())
          .extracting(Fill::requestId)
          .containsExactly(first.reference().requestId(), second.reference().requestId());
      assertThat(ledger.submissions).isEqualTo(1);
    }
  }

  @Test
  void lostResponseIsRecoveredAfterRestartEvenWithAutomaticDisabled() {
    store.queued = List.of(swap(1));
    ledger.failure = new IllegalStateException("response lost");
    Settlement result = workflow.run("pool", new RunInput(UUID.randomUUID()), OPERATOR);
    assertThat(result.status()).isEqualTo(Status.UNRESOLVED);
    assertThat(ledger.submitted.commandId()).isEqualTo(result.settlementId());
    assertThat(ledger.submitted.beginOffset()).isEqualTo(42);
    workflow.reconcile();
    assertThat(store.batch.status()).isEqualTo(Status.UNRESOLVED);
    ledger.evidence = Optional.of(confirmation(ledger.submitted));
    new SettlementWorkflow(store, ledger, CLOCK).reconcile();
    assertThat(store.batch.status()).isEqualTo(Status.CONFIRMED);
    assertThat(ledger.submissions).isEqualTo(1);
  }

  @Test
  void provenExclusionReleasesAnUnknownBatchWithoutResubmittingAndAllowsAFreshBatch() {
    store.queued = List.of(swap(1));
    ledger.failure = new IllegalStateException("response lost");
    Settlement original = workflow.run("pool", new RunInput(UUID.randomUUID()), OPERATOR);
    assertThat(original.status()).isEqualTo(Status.UNRESOLVED);

    ledger.recoveryFailure =
        new SettlementLedger.Excluded("INPUT_CONSUMED", "Original batch can no longer commit");
    new SettlementWorkflow(store, ledger, CLOCK).reconcile();
    assertThat(store.batch.settlementId()).isEqualTo(original.settlementId());
    assertThat(store.batch.status()).isEqualTo(Status.REJECTED);
    assertThat(store.exclusionCode).isEqualTo("INPUT_CONSUMED");
    assertThat(store.pending()).isEmpty();
    assertThat(ledger.submissions).isEqualTo(1);
    assertThat(ledger.recoveries).isEqualTo(1);

    ledger.failure = null;
    ledger.recoveryFailure = null;
    store.queued = List.of(swap(2));
    Settlement fresh = workflow.run("pool", new RunInput(UUID.randomUUID()), OPERATOR);
    assertThat(fresh.settlementId()).isNotEqualTo(original.settlementId());
    assertThat(fresh.status()).isEqualTo(Status.CONFIRMED);
    assertThat(ledger.submissions).isEqualTo(2);
  }

  @Test
  void durablePreparationFailureReleasesThePoolBeforeOrAfterRestart() {
    var notPrepared = new SettlementLedger.Excluded("COMMAND_NOT_PREPARED", "No command was sent");
    store.queued = List.of(swap(1));
    ledger.failure = notPrepared;
    assertThat(workflow.run("pool", new RunInput(UUID.randomUUID()), OPERATOR).status())
        .isEqualTo(Status.REJECTED);
    assertThat(store.pending()).isEmpty();

    ledger.failure = new IllegalStateException("response lost before preparation result");
    workflow.run("pool", new RunInput(UUID.randomUUID()), OPERATOR);
    ledger.recoveryFailure = notPrepared;
    new SettlementWorkflow(store, ledger, CLOCK).reconcile();
    assertThat(store.exclusionCode).isEqualTo("COMMAND_NOT_PREPARED");
    assertThat(store.pending()).isEmpty();
    ledger.failure = null;
    ledger.recoveryFailure = null;
    assertThat(workflow.run("pool", new RunInput(UUID.randomUUID()), OPERATOR).status())
        .isEqualTo(Status.CONFIRMED);
  }

  @Test
  void rejectedRecoveryAttemptDoesNotProveTheOriginalUnknownBatchHadNoEffect() {
    store.queued = List.of(swap(1));
    ledger.failure = new IllegalStateException("response lost");
    Settlement original = workflow.run("pool", new RunInput(UUID.randomUUID()), OPERATOR);
    ledger.recoveryFailure = new LedgerRejected("REPLAY_REJECTED", "Recovery attempt rejected");
    workflow.reconcile();

    assertThat(store.batch.settlementId()).isEqualTo(original.settlementId());
    assertThat(store.batch.status()).isEqualTo(Status.UNRESOLVED);
    assertThat(store.pending()).hasSize(1);
    assertThat(store.exclusionCode).isNull();
    assertThat(ledger.submissions).isEqualTo(1);
    assertThat(ledger.recoveries).isEqualTo(1);
  }

  @Test
  void definitiveRejectionBlocksAutomaticRetryUntilSnapshotChanges() {
    store.queued = List.of(swap(1), swap(2), swap(3));
    store.automaticEnabled = true;
    ledger.failure = new LedgerRejected("MIN_OUT", "Output changed");
    workflow.automatic();
    workflow.automatic();
    assertThat(store.batch.status()).isEqualTo(Status.REJECTED);
    assertThat(ledger.submissions).isEqualTo(1);
    ledger.snapshot =
        new Snapshot("pool", "state-v2", RESERVES, "30", "READY", null, NOW, 43, "100", "2");
    ledger.failure = null;
    workflow.automatic();
    assertThat(store.batch.status()).isEqualTo(Status.CONFIRMED);
    assertThat(ledger.submissions).isEqualTo(2);
  }

  @Test
  void disablingDuringPreflightReturnsWithoutWaitingAndPreventsDispatch() throws Exception {
    store.queued = List.of(swap(1), swap(2), swap(3));
    store.automaticEnabled = true;
    CountDownLatch entered = new CountDownLatch(1);
    CountDownLatch released = new CountDownLatch(1);
    ledger.beforePreflight = () -> await(entered, released);
    try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
      Future<?> operation = executor.submit(workflow::automatic);
      assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
      var policy =
          executor
              .submit(() -> workflow.updatePolicy("pool", new UpdatePolicy(false, 3, 0), OPERATOR))
              .get(2, TimeUnit.SECONDS);
      assertThat(policy.automaticEnabled()).isFalse();
      released.countDown();
      operation.get(2, TimeUnit.SECONDS);
    } finally {
      released.countDown();
    }
    assertThat(ledger.submissions).isZero();
    assertThat(store.batch.status()).isEqualTo(Status.CANCELLED);
  }

  @Test
  void disablingAfterAuthorizationAllowsAlreadySubmittedBatchToFinish() throws Exception {
    store.queued = List.of(swap(1), swap(2), swap(3));
    store.automaticEnabled = true;
    CountDownLatch entered = new CountDownLatch(1);
    CountDownLatch released = new CountDownLatch(1);
    ledger.beforeSubmit = () -> await(entered, released);
    try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
      Future<?> operation = executor.submit(workflow::automatic);
      assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
      executor
          .submit(() -> workflow.updatePolicy("pool", new UpdatePolicy(false, 3, 0), OPERATOR))
          .get(2, TimeUnit.SECONDS);
      released.countDown();
      operation.get(2, TimeUnit.SECONDS);
    } finally {
      released.countDown();
    }
    assertThat(store.batch.status()).isEqualTo(Status.CONFIRMED);
    assertThat(ledger.submissions).isEqualTo(1);
  }

  @Test
  void fifoStopsAtUnknownOrWithdrawalEvenAfterTheirDeadline() {
    QueueRequest ready = swap(1);
    for (SwapModels.Status uncertain :
        List.of(
            SwapModels.Status.SUBMITTING,
            SwapModels.Status.UNRESOLVED,
            SwapModels.Status.WITHDRAWING,
            SwapModels.Status.WITHDRAWAL_UNRESOLVED)) {
      QueueRequest barrier = swap(2, uncertain, NOW.minusSeconds(1));
      assertThat(SettlementStore.prefix(List.of(ready, barrier, swap(3)), 5))
          .containsExactly(ready);
      assertThat(SettlementStore.prefix(List.of(barrier, ready), 5)).isEmpty();
    }
  }

  @Test
  void preparedBatchAfterRestartUsesFreshSnapshotBeforeAuthorization() {
    store.queued = List.of(swap(1));
    store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, SNAPSHOT, NOW);
    ledger.snapshot =
        new Snapshot("pool", "new-state", RESERVES, "30", "READY", null, NOW, 99, "100", "2");
    workflow.reconcile();
    assertThat(ledger.submitted.stateVersion()).isEqualTo("new-state");
    assertThat(ledger.submitted.beginOffset()).isEqualTo(99);
    assertThat(ledger.submissions).isEqualTo(1);
  }

  @Test
  void invalidFillOrderCannotReachSubmission() {
    store.queued = List.of(swap(1), swap(2));
    ledger.reverseFills = true;
    assertThat(workflow.run("pool", new RunInput(UUID.randomUUID()), OPERATOR).status())
        .isEqualTo(Status.CANCELLED);
    assertThat(ledger.submissions).isZero();
  }

  @Test
  void independentFamiliesRotateAndPreserveTheirOwnFifo() {
    var firstSwap = swap(1);
    var secondSwap = swap(2);
    var deposit = liquidity(1, LiquidityModels.Kind.DEPOSIT, LiquidityModels.Status.READY);
    var laterDeposit = liquidity(2, LiquidityModels.Kind.DEPOSIT, LiquidityModels.Status.READY);
    var withdrawal = liquidity(1, LiquidityModels.Kind.WITHDRAW, LiquidityModels.Status.READY);
    var laterWithdrawal = liquidity(2, LiquidityModels.Kind.WITHDRAW, LiquidityModels.Status.READY);
    List<QueueRequest> queues =
        List.of(laterWithdrawal, withdrawal, laterDeposit, secondSwap, deposit, firstSwap);
    assertThat(SettlementStore.select(queues, 5, null, Set.of(), true))
        .containsExactly(firstSwap, secondSwap);
    assertThat(SettlementStore.select(queues, 5, "swap", Set.of(), true))
        .containsExactly(deposit, laterDeposit);
    assertThat(SettlementStore.select(queues, 1, "swap", Set.of(), true)).containsExactly(deposit);
    assertThat(SettlementStore.select(List.of(deposit, laterDeposit), 5, null, Set.of(), true))
        .containsExactly(deposit, laterDeposit);
    assertThat(SettlementStore.select(queues, 5, "deposit", Set.of(), true))
        .containsExactly(withdrawal, laterWithdrawal);
    assertThat(SettlementStore.select(queues, 1, "deposit", Set.of(), true))
        .containsExactly(withdrawal);
    assertThat(
            SettlementStore.select(List.of(withdrawal, laterWithdrawal), 5, null, Set.of(), true))
        .containsExactly(withdrawal, laterWithdrawal);
    assertThat(SettlementStore.select(queues, 5, "withdraw", Set.of(), true))
        .containsExactly(firstSwap, secondSwap);
    assertThat(SettlementStore.select(List.of(firstSwap), 5, null, Set.of(), true)).isEmpty();
  }

  @Test
  void blockedOrUncertainFamilyDoesNotBlockOtherFamilies() {
    var swap = swap(1);
    var recovering =
        liquidity(1, LiquidityModels.Kind.WITHDRAW, LiquidityModels.Status.RECOVERY_UNRESOLVED);
    var laterWithdrawal = liquidity(2, LiquidityModels.Kind.WITHDRAW, LiquidityModels.Status.READY);
    var deposit = liquidity(1, LiquidityModels.Kind.DEPOSIT, LiquidityModels.Status.BLOCKED);
    List<QueueRequest> queues = List.of(recovering, laterWithdrawal, swap, deposit);
    assertThat(SettlementStore.select(queues, 1, "swap", Set.of("deposit"), true))
        .containsExactly(swap);
    assertThat(
            SettlementStore.select(
                List.of(recovering, laterWithdrawal, deposit), 5, "swap", Set.of(), true))
        .containsExactly(deposit);
  }

  @Test
  void initializationRemainsIndividualAndLiquidityBatchesStopAtUnresolvedRequests() {
    var initial =
        liquidity(
            2,
            LiquidityModels.Kind.DEPOSIT,
            LiquidityModels.Status.READY,
            LiquidityModels.Mode.INITIAL);
    var first = liquidity(1, LiquidityModels.Kind.DEPOSIT, LiquidityModels.Status.READY);
    var later = liquidity(3, LiquidityModels.Kind.DEPOSIT, LiquidityModels.Status.READY);
    assertThat(SettlementStore.prefix(List.of(initial, later), 5)).containsExactly(initial);
    assertThat(SettlementStore.prefix(List.of(first, initial, later), 5)).containsExactly(first);
    for (var kind : LiquidityModels.Kind.values()) {
      var ready = liquidity(1, kind, LiquidityModels.Status.READY);
      var recovering = liquidity(2, kind, LiquidityModels.Status.RECOVERY_UNRESOLVED);
      var tail = liquidity(3, kind, LiquidityModels.Status.READY);
      assertThat(SettlementStore.prefix(List.of(ready, recovering, tail), 5))
          .containsExactly(ready);
    }
  }

  private static LiquidityRequest liquidity(
      long sequence, LiquidityModels.Kind kind, LiquidityModels.Status status) {
    return liquidity(sequence, kind, status, LiquidityModels.Mode.PROPORTIONAL);
  }

  private static LiquidityRequest liquidity(
      long sequence,
      LiquidityModels.Kind kind,
      LiquidityModels.Status status,
      LiquidityModels.Mode mode) {
    LiquidityModels.Terms terms =
        new LiquidityModels.WithdrawalTerms(
            "pool",
            "Pool",
            "trader",
            new Instrument("issuer", "A"),
            new Instrument("issuer", "B"),
            new Instrument("dvo", "LP"),
            "1",
            "1",
            "2",
            "0.99",
            "1.98",
            NOW.plusSeconds(60));
    if (kind == LiquidityModels.Kind.DEPOSIT)
      terms =
          new LiquidityModels.DepositTerms(
              "pool",
              "Pool",
              "trader",
              terms.baseInstrument(),
              terms.quoteInstrument(),
              terms.lpInstrument(),
              mode,
              "1",
              "2",
              "1",
              "2",
              "0",
              "0",
              "1",
              "0.99",
              "1.98",
              "2.02",
              null,
              NOW.plusSeconds(60));
    return new LiquidityRequest(
        new LiquidityModels.Request(
            UUID.randomUUID(),
            UUID.randomUUID(),
            kind,
            terms,
            status,
            sequence,
            NOW,
            NOW,
            NOW,
            null,
            null,
            List.of("a", "b", "c"),
            null,
            null,
            null,
            false));
  }

  private static void await(CountDownLatch entered, CountDownLatch released) {
    entered.countDown();
    try {
      if (!released.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test timed out");
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }

  static SwapRequest swap(long sequence) {
    return swap(sequence, SwapModels.Status.READY, NOW.plusSeconds(60));
  }

  static SwapRequest swap(long sequence, SwapModels.Status status, Instant deadline) {
    return new SwapRequest(
        new Swap(
            UUID.randomUUID(),
            UUID.randomUUID(),
            "pool",
            "Pool",
            "trader",
            SwapModels.Direction.BaseToQuote,
            new Instrument("issuer", "A"),
            new Instrument("issuer", "B"),
            "10",
            "18",
            "0.03",
            "15",
            deadline,
            status,
            sequence,
            NOW,
            NOW,
            NOW,
            null,
            null,
            List.of("allocation"),
            "request-update",
            null,
            null,
            false));
  }

  private static Confirmation confirmation(Pending pending) {
    return new Confirmation(
        pending.settlement().fills(),
        RESERVES,
        new Reserves("after", "110", "182", "1.6545", "20020"),
        "settlement-update",
        44,
        NOW);
  }

  private static final class Ledger implements SettlementLedger {
    Snapshot snapshot = SNAPSHOT;
    RequestRef blockedId;
    int preflights;
    int submissions;
    int recoveries;
    boolean reverseFills;
    RuntimeException failure;
    RuntimeException recoveryFailure;
    Pending submitted;
    Runnable beforePreflight = () -> {};
    Runnable beforeSubmit = () -> {};
    Optional<Confirmation> evidence = Optional.empty();

    public Snapshot snapshot(String poolId) {
      return snapshot;
    }

    public List<PreviewStep> preview(Snapshot snapshot, List<QueueRequest> requests) {
      return List.of();
    }

    public List<Fill> preflight(Snapshot snapshot, List<QueueRequest> swaps) {
      preflights++;
      beforePreflight.run();
      if (swaps.stream().anyMatch(swap -> swap.reference().equals(blockedId)))
        throw new SettlementLedger.Blocked(blockedId, "MIN_OUT", "Minimum output cannot be met");
      List<Fill> fills =
          swaps.stream()
              .map(
                  request ->
                      (Fill)
                          switch (request) {
                            case SwapRequest swap ->
                                new SwapFill(
                                    swap.reference().requestId(),
                                    "18",
                                    swap.request().outputInstrument());
                            case LiquidityRequest liquidity ->
                                liquidity.request().kind() == LiquidityModels.Kind.DEPOSIT
                                    ? new DepositFill(
                                        liquidity.reference().requestId(), "1", "2", "0", "0", "1")
                                    : new WithdrawalFill(
                                        liquidity.reference().requestId(), "1", "1", "2");
                          })
              .toList();
      return reverseFills ? fills.reversed() : fills;
    }

    public Confirmation submit(Pending pending) {
      submissions++;
      submitted = pending;
      beforeSubmit.run();
      if (failure != null) throw failure;
      return confirmation(pending);
    }

    public Optional<Confirmation> recover(Pending pending) {
      recoveries++;
      if (recoveryFailure != null) throw recoveryFailure;
      return evidence;
    }
  }

  private static final class Progress extends SettlementStore {
    List<QueueRequest> queued = List.of();
    List<QueueRequest> claimed = List.of();
    Settlement batch;
    String stateVersion;
    long beginOffset;
    boolean automaticEnabled;
    long policyVersion;
    int batchSize = 3;
    RequestRef blocked;
    String blockedVersion;
    String lastProcessedFamily;
    String exclusionCode;

    Progress() {
      super(null, null, null, 10);
    }

    public synchronized Optional<Settlement> findIntent(
        String poolId, UUID id, Selection selection) {
      return find(id);
    }

    public synchronized Optional<Settlement> find(UUID id) {
      return batch != null && batch.settlementId().equals(id)
          ? Optional.of(batch)
          : Optional.empty();
    }

    public synchronized Settlement get(UUID id) {
      return batch;
    }

    public synchronized Policy updatePolicy(String poolId, UpdatePolicy input, Instant now) {
      automaticEnabled = input.automaticEnabled();
      batchSize = input.batchSize();
      policyVersion++;
      return new Policy(poolId, automaticEnabled, batchSize, 10, policyVersion, now);
    }

    public synchronized List<String> automaticPools() {
      return automaticEnabled ? List.of("pool") : List.of();
    }

    public synchronized Optional<Pending> claim(
        String poolId, UUID id, Trigger trigger, Snapshot snapshot, Instant now) {
      if (trigger == Trigger.AUTOMATIC && !automaticEnabled) return Optional.empty();
      Set<String> blockedFamilies =
          Objects.equals(blockedVersion, snapshot.version()) ? Set.of("swap") : Set.of();
      claimed =
          SettlementStore.select(
              queued,
              batchSize,
              lastProcessedFamily,
              trigger == Trigger.AUTOMATIC ? blockedFamilies : Set.of(),
              trigger == Trigger.AUTOMATIC);
      if (claimed.isEmpty()) return Optional.empty();
      lastProcessedFamily = claimed.getFirst().type();
      batch =
          new Settlement(
              id,
              poolId,
              trigger,
              Status.PREPARING,
              claimed.stream().map(QueueRequest::reference).toList(),
              List.of(),
              snapshot.reserves(),
              null,
              policyVersion,
              now,
              now,
              null,
              null,
              null,
              null);
      stateVersion = snapshot.version();
      beginOffset = snapshot.ledgerOffset();
      return Optional.of(pending(id));
    }

    public synchronized Pending pending(UUID id) {
      return new Pending(batch, claimed, batch.settlementId(), beginOffset, stateVersion);
    }

    public synchronized List<Pending> pending() {
      return batch != null
              && Set.of(Status.PREPARING, Status.SUBMITTING, Status.UNRESOLVED)
                  .contains(batch.status())
          ? List.of(pending(batch.settlementId()))
          : List.of();
    }

    public synchronized boolean keepPrefix(
        UUID id,
        List<RequestRef> prefix,
        RequestRef blockedId,
        String code,
        String reason,
        String version,
        Instant now) {
      blocked = blockedId;
      blockedVersion = version;
      claimed = claimed.stream().filter(swap -> prefix.contains(swap.reference())).toList();
      batch =
          new Settlement(
              batch.settlementId(),
              batch.poolId(),
              batch.trigger(),
              prefix.isEmpty() ? Status.REJECTED : Status.PREPARING,
              prefix,
              List.of(),
              batch.before(),
              null,
              batch.policyVersion(),
              batch.createdAt(),
              now,
              null,
              code,
              reason,
              null);
      return true;
    }

    public synchronized void rejectPreparation(
        UUID id, RequestRef blockedId, String code, String reason, String version, Instant now) {
      blocked = blockedId;
      blockedVersion = version;
      phase(Status.REJECTED, List.of());
    }

    public synchronized void cancelPreparation(UUID id, String code, String reason, Instant now) {
      if (batch.status() == Status.PREPARING) phase(Status.CANCELLED, List.of());
    }

    public synchronized Optional<Pending> authorizeDispatch(
        UUID id, List<Fill> fills, Snapshot snapshot, Instant now) {
      if (batch.status() != Status.PREPARING) return Optional.empty();
      if (batch.trigger() == Trigger.AUTOMATIC
          && (!automaticEnabled || batch.policyVersion() != policyVersion)) {
        phase(Status.CANCELLED, List.of());
        return Optional.empty();
      }
      stateVersion = snapshot.version();
      beginOffset = snapshot.ledgerOffset();
      phase(Status.SUBMITTING, fills);
      return Optional.of(pending(id));
    }

    public synchronized void unresolved(UUID id, Instant now) {
      phase(Status.UNRESOLVED, batch.fills());
    }

    public synchronized void rejectSubmission(UUID id, String code, String reason, Instant now) {
      if (batch.status() != Status.SUBMITTING) return;
      blockedVersion = stateVersion;
      phase(Status.REJECTED, batch.fills());
    }

    public synchronized boolean beginRecovery(UUID id, Instant now) {
      if (batch == null
          || !batch.settlementId().equals(id)
          || !Set.of(Status.SUBMITTING, Status.UNRESOLVED).contains(batch.status())) return false;
      phase(Status.UNRESOLVED, batch.fills());
      return true;
    }

    public synchronized void excludeSubmission(UUID id, String code, String reason, Instant now) {
      if (batch == null
          || !batch.settlementId().equals(id)
          || !Set.of(Status.SUBMITTING, Status.UNRESOLVED).contains(batch.status())) return;
      exclusionCode = code;
      phase(Status.REJECTED, batch.fills());
    }

    public synchronized void confirm(UUID id, Confirmation confirmation) {
      phase(Status.CONFIRMED, confirmation.fills());
    }

    private void phase(Status status, List<Fill> fills) {
      batch =
          new Settlement(
              batch.settlementId(),
              batch.poolId(),
              batch.trigger(),
              status,
              batch.requests(),
              fills,
              batch.before(),
              batch.after(),
              batch.policyVersion(),
              batch.createdAt(),
              NOW,
              batch.updateId(),
              batch.errorCode(),
              batch.error(),
              null);
    }
  }
}
