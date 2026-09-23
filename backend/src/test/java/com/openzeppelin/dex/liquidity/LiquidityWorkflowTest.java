package com.openzeppelin.dex.liquidity;

import static com.openzeppelin.dex.liquidity.LiquidityModels.*;
import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.pools.PoolModels.Instrument;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.AccessDeniedException;
import tools.jackson.databind.json.JsonMapper;

class LiquidityWorkflowTest {
  private static final Instant NOW = Instant.parse("2026-09-22T12:00:00Z");
  private static final Account TRADER =
      new Account(UUID.randomUUID(), "issuer", "trader", "Trader", Account.Role.TRADER);
  private static final Instrument BASE = new Instrument("issuer", "BASE");
  private static final Instrument QUOTE = new Instrument("issuer", "QUOTE");
  private static final Instrument LP = new Instrument("dvo", "LP");
  private static final String SIGNATURE = Base64.getEncoder().encodeToString(new byte[64]);
  private final TestClock clock = new TestClock();
  private final Progress store = new Progress(clock);
  private final Ledger ledger = new Ledger(clock);
  private final LiquidityWorkflow workflow = new LiquidityWorkflow(store, ledger, clock);

  @Test
  void depositAndWithdrawalKeepSignedTermsAndDispatchEachPreparationOnce() {
    for (Kind kind : Kind.values()) {
      var prepared = prepare(kind);
      assertThat(prepared.action()).isEqualTo(Action.SUBMIT);
      assertThat(prepared.recoveryEffects()).isEmpty();
      assertThat(workflow.submit(kind, TRADER, "token", signed(prepared)).status())
          .isEqualTo(Status.READY);
      workflow.submit(kind, TRADER, "token", signed(prepared));
      assertThat(store.get(prepared.requestId()).terms()).isEqualTo(prepared.terms());
    }
    assertThat(ledger.submissions).isEqualTo(2);
    assertThat(ledger.verifications).isEqualTo(2);
  }

  @Test
  void ownershipKindAndSignatureAreCheckedBeforeDispatch() {
    var prepared = prepare(Kind.DEPOSIT);
    var stranger = new Account(UUID.randomUUID(), "issuer", "other", "Other", Account.Role.TRADER);
    assertThatThrownBy(() -> workflow.get(prepared.requestId(), Kind.DEPOSIT, stranger))
        .isInstanceOf(NoSuchElementException.class);
    assertThatThrownBy(() -> workflow.submit(Kind.WITHDRAW, TRADER, "token", signed(prepared)))
        .isInstanceOf(NoSuchElementException.class);
    ledger.badSignature = true;
    assertThatThrownBy(() -> workflow.submit(Kind.DEPOSIT, TRADER, "token", signed(prepared)))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(ledger.submissions).isZero();
    assertThat(store.get(prepared.requestId()).status()).isEqualTo(Status.PREPARED);
    var operator =
        new Account(UUID.randomUUID(), "issuer", "operator", "Operator", Account.Role.OPERATOR);
    assertThatThrownBy(() -> workflow.positions(operator, "token"))
        .isInstanceOf(AccessDeniedException.class);
  }

  @Test
  void preparedQuoteCannotChangeSignedLimitsOrReuseAnExpiredPreparation() {
    var quote =
        workflow.quoteDeposit(TRADER, "token", new DepositQuoteInput("pool", "10", "25", 100));
    var input =
        new PrepareDepositInput(
            quote.quoteId(),
            quote.minLpOut(),
            quote.minRatio(),
            quote.maxRatio(),
            quote.settlementDeadline());
    var prepared = workflow.prepareDeposit(TRADER, "token", input);
    assertThat(workflow.prepareDeposit(TRADER, "token", input)).isEqualTo(prepared);
    assertThatThrownBy(
            () ->
                workflow.prepareDeposit(
                    TRADER,
                    "token",
                    new PrepareDepositInput(
                        quote.quoteId(),
                        "8",
                        quote.minRatio(),
                        quote.maxRatio(),
                        quote.settlementDeadline())))
        .isInstanceOfSatisfying(
            LiquidityFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("IDEMPOTENCY_CONFLICT"));
    clock.now = prepared.expiresAt();
    assertThatThrownBy(() -> workflow.prepareDeposit(TRADER, "token", input))
        .isInstanceOfSatisfying(
            LiquidityFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("PREPARATION_EXPIRED"));
    assertThat(ledger.preparations).isEqualTo(1);
  }

  @Test
  void revocationBlocksCachedPreparationsAndDispatchWithoutHidingProgress() {
    for (Kind kind : Kind.values()) {
      var prepared = prepare(kind);
      var request = store.get(prepared.requestId());
      var terms = prepared.terms();
      ledger.accessRevoked = true;
      assertThatThrownBy(
              () -> {
                if (terms instanceof DepositTerms deposit)
                  workflow.prepareDeposit(
                      TRADER,
                      "token",
                      new PrepareDepositInput(
                          request.quoteId(),
                          deposit.minLpOut(),
                          deposit.minRatio(),
                          deposit.maxRatio(),
                          deposit.settlementDeadline()));
                else {
                  var withdrawal = (WithdrawalTerms) terms;
                  workflow.prepareWithdrawal(
                      TRADER,
                      "token",
                      new PrepareWithdrawalInput(
                          request.quoteId(),
                          withdrawal.minBaseOut(),
                          withdrawal.minQuoteOut(),
                          withdrawal.settlementDeadline()));
                }
              })
          .isInstanceOfSatisfying(
              LiquidityFailure.class,
              failure -> assertThat(failure.code()).isEqualTo("POOL_ACCESS_REQUIRED"));
      assertThatThrownBy(() -> workflow.submit(kind, TRADER, "token", signed(prepared)))
          .isInstanceOfSatisfying(
              LiquidityFailure.class,
              failure -> assertThat(failure.code()).isEqualTo("POOL_ACCESS_REQUIRED"));
      assertThat(store.pendingOwned(prepared.preparationId(), TRADER).signature()).isNull();
      assertThat(workflow.get(prepared.requestId(), kind, TRADER).status())
          .isEqualTo(Status.PREPARED);
      ledger.accessRevoked = false;
      workflow.submit(kind, TRADER, "token", signed(prepared));
      clock.now = terms.settlementDeadline();
      var recovery = workflow.prepareRecovery(prepared.requestId(), kind, TRADER, "token");
      ledger.accessRevoked = true;
      assertThatThrownBy(
              () -> workflow.prepareRecovery(prepared.requestId(), kind, TRADER, "token"))
          .isInstanceOfSatisfying(
              LiquidityFailure.class,
              failure -> assertThat(failure.code()).isEqualTo("POOL_ACCESS_REQUIRED"));
      assertThatThrownBy(
              () -> workflow.recover(prepared.requestId(), kind, TRADER, "token", signed(recovery)))
          .isInstanceOfSatisfying(
              LiquidityFailure.class,
              failure -> assertThat(failure.code()).isEqualTo("POOL_ACCESS_REQUIRED"));
      assertThat(store.pendingOwned(recovery.preparationId(), TRADER).signature()).isNull();
      assertThat(workflow.submit(kind, TRADER, "token", signed(prepared)).status())
          .isEqualTo(Status.READY);
      ledger.accessRevoked = false;
    }
    assertThat(ledger.submissions).isEqualTo(2);
    assertThat(ledger.recoveries).isZero();
  }

  @Test
  void unknownSubmissionRecoversEvidenceAfterRestartWithoutReplay() {
    var prepared = prepare(Kind.DEPOSIT);
    ledger.failure = new IllegalStateException("response lost");
    assertThat(workflow.submit(Kind.DEPOSIT, TRADER, "token", signed(prepared)).status())
        .isEqualTo(Status.UNRESOLVED);
    workflow.submit(Kind.DEPOSIT, TRADER, "token", signed(prepared));
    workflow.reconcile();
    assertThat(store.get(prepared.requestId()).status()).isEqualTo(Status.UNRESOLVED);
    ledger.evidence = Optional.of(ledger.confirmation(Status.READY));
    new LiquidityWorkflow(store, ledger, clock).reconcile();
    assertThat(store.get(prepared.requestId()).status()).isEqualTo(Status.READY);
    assertThat(ledger.submissions).isEqualTo(1);
  }

  @Test
  void expiredRecoveryShowsOnlyRemainingEffectsAndRequiresTerminalEvidence() {
    var prepared = prepare(Kind.WITHDRAW);
    workflow.submit(Kind.WITHDRAW, TRADER, "token", signed(prepared));
    assertThatThrownBy(
            () -> workflow.prepareRecovery(prepared.requestId(), Kind.WITHDRAW, TRADER, "token"))
        .isInstanceOfSatisfying(
            LiquidityFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("DEADLINE_NOT_ELAPSED"));
    clock.now = prepared.terms().settlementDeadline();
    var recover = workflow.prepareRecovery(prepared.requestId(), Kind.WITHDRAW, TRADER, "token");
    assertThat(recover.recoveryEffects())
        .containsExactly(
            new RecoveryEffect("lp", LP, "1", RecoveryKind.RETURN_FUNDS),
            new RecoveryEffect("quote", QUOTE, "0", RecoveryKind.RELEASE_PERMISSION));
    ledger.failure = new IllegalStateException("response lost");
    assertThat(
            workflow
                .recover(prepared.requestId(), Kind.WITHDRAW, TRADER, "token", signed(recover))
                .status())
        .isEqualTo(Status.RECOVERY_UNRESOLVED);
    workflow.recover(prepared.requestId(), Kind.WITHDRAW, TRADER, "token", signed(recover));
    ledger.evidence = Optional.of(ledger.confirmation(Status.RECOVERED));
    new LiquidityWorkflow(store, ledger, clock).reconcile();
    assertThat(store.get(prepared.requestId()).status()).isEqualTo(Status.RECOVERED);
    assertThat(store.get(prepared.requestId()).canRecover()).isFalse();
    assertThat(ledger.recoveries).isEqualTo(1);
  }

  @Test
  void observedSettlementPreservesActualResultsAndWireTermsStayConcrete() {
    var prepared = prepare(Kind.DEPOSIT);
    workflow.submit(Kind.DEPOSIT, TRADER, "token", signed(prepared));
    clock.now = prepared.terms().settlementDeadline();
    workflow.prepareRecovery(prepared.requestId(), Kind.DEPOSIT, TRADER, "token");
    var actual = new DepositResult("10", "20", "0", "5", "10");
    ledger.observation =
        Optional.of(
            new Confirmation(
                Status.SETTLED, List.of("base", "quote", "lp"), actual, "settled", 44, clock.now));
    workflow.reconcile();
    var request = store.get(prepared.requestId());
    assertThat(request.result()).isEqualTo(actual);
    assertThatThrownBy(
            () -> workflow.prepareRecovery(prepared.requestId(), Kind.DEPOSIT, TRADER, "token"))
        .isInstanceOfSatisfying(
            LiquidityFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("RECOVERY_UNAVAILABLE"));
    var tree =
        JsonMapper.builder()
            .build()
            .readTree(JsonMapper.builder().build().writeValueAsString(request));
    assertThat(tree.path("kind").asString()).isEqualTo("DEPOSIT");
    assertThat(tree.path("terms").path("maxBaseAmount").asString()).isEqualTo("10");
    assertThat(tree.path("result").path("actualQuoteRefund").asString()).isEqualTo("5");
    assertThat(tree.path("terms").has("kind")).isFalse();
  }

  private Preparation prepare(Kind kind) {
    if (kind == Kind.DEPOSIT) {
      var q =
          workflow.quoteDeposit(TRADER, "token", new DepositQuoteInput("pool", "10", "25", 100));
      return workflow.prepareDeposit(
          TRADER,
          "token",
          new PrepareDepositInput(
              q.quoteId(), q.minLpOut(), q.minRatio(), q.maxRatio(), q.settlementDeadline()));
    }
    var q = workflow.quoteWithdrawal(TRADER, "token", new WithdrawalQuoteInput("pool", "1", 100));
    return workflow.prepareWithdrawal(
        TRADER,
        "token",
        new PrepareWithdrawalInput(
            q.quoteId(), q.minBaseOut(), q.minQuoteOut(), q.settlementDeadline()));
  }

  private static SubmitInput signed(Preparation prepared) {
    return new SubmitInput(prepared.preparationId(), SIGNATURE);
  }

  private static final class TestClock extends Clock {
    Instant now = NOW;

    public ZoneId getZone() {
      return ZoneOffset.UTC;
    }

    public Clock withZone(ZoneId zone) {
      return Clock.fixed(now, zone);
    }

    public Instant instant() {
      return now;
    }
  }

  private static final class Ledger implements LiquidityLedger {
    final TestClock clock;
    int submissions, preparations, verifications, recoveries;
    boolean badSignature;
    boolean accessRevoked;
    RuntimeException failure;
    Optional<Confirmation> evidence = Optional.empty(), observation = Optional.empty();

    Ledger(TestClock clock) {
      this.clock = clock;
    }

    public void requireAccess(Account caller, String poolId) {
      if (accessRevoked)
        throw new LiquidityFailure("POOL_ACCESS_REQUIRED", "Current pool access is required");
    }

    public long offset() {
      return 42;
    }

    public DepositQuote quoteDeposit(
        UUID id, Account caller, String token, DepositQuoteInput input) {
      return new DepositQuote(
          id,
          "pool",
          "Pool",
          "trader",
          BASE,
          QUOTE,
          LP,
          Mode.PROPORTIONAL,
          input.maxBaseAmount(),
          input.maxQuoteAmount(),
          "10",
          "20",
          "0",
          "5",
          "10",
          "9.9",
          "1.98",
          "2.02",
          null,
          input.slippageBps(),
          "state",
          clock.now.plusSeconds(30),
          clock.now.plusSeconds(600));
    }

    public WithdrawalQuote quoteWithdrawal(
        UUID id, Account caller, String token, WithdrawalQuoteInput input) {
      return new WithdrawalQuote(
          id,
          "pool",
          "Pool",
          "trader",
          BASE,
          QUOTE,
          LP,
          input.lpAmount(),
          "1",
          "2",
          "0.99",
          "1.98",
          input.slippageBps(),
          "state",
          clock.now.plusSeconds(30),
          clock.now.plusSeconds(600));
    }

    public SigningPayload prepare(
        UUID request, UUID command, Account caller, String token, Terms terms) {
      preparations++;
      return signing(List.of());
    }

    public void verify(SigningPayload signing, String signature, Account caller) {
      verifications++;
      if (badSignature)
        throw new IllegalArgumentException("Signature does not match the registered wallet");
    }

    public Confirmation submit(Pending pending, Account caller, String token) {
      submissions++;
      if (failure != null) throw failure;
      return confirmation(Status.READY);
    }

    public Optional<Confirmation> recover(Pending pending) {
      return evidence;
    }

    public Optional<Confirmation> observe(Pending pending) {
      return observation;
    }

    public SigningPayload prepareRecovery(
        UUID command, Request request, Account caller, String token) {
      return signing(
          List.of(
              new RecoveryEffect("lp", LP, "1", RecoveryKind.RETURN_FUNDS),
              new RecoveryEffect("quote", QUOTE, "0", RecoveryKind.RELEASE_PERMISSION)));
    }

    public Confirmation executeRecovery(Pending pending, Account caller, String token) {
      recoveries++;
      if (failure != null) throw failure;
      return confirmation(Status.RECOVERED);
    }

    public Positions positions(Account caller, String token) {
      return new Positions(List.of(), 42);
    }

    private SigningPayload signing(List<RecoveryEffect> effects) {
      return new SigningPayload(
          "opaque-transaction",
          Base64.getEncoder().encodeToString(new byte[32]),
          3,
          "trader",
          "key",
          clock.now.plusSeconds(45),
          effects);
    }

    private Confirmation confirmation(Status status) {
      return new Confirmation(
          status, List.of("base", "quote", "lp"), null, "update", 43, clock.now);
    }
  }

  private static final class Progress extends LiquidityStore {
    final TestClock clock;
    final Map<UUID, Object> quotes = new HashMap<>();
    final Map<UUID, Request> requests = new HashMap<>();
    final Map<UUID, Pending> pending = new LinkedHashMap<>();
    final Set<UUID> confirmed = new HashSet<>();

    Progress(TestClock clock) {
      super(null, null, null, 10);
      this.clock = clock;
    }

    public void saveQuote(DepositQuote quote, Account caller) {
      quotes.put(quote.quoteId(), quote);
    }

    public void saveQuote(WithdrawalQuote quote, Account caller) {
      quotes.put(quote.quoteId(), quote);
    }

    public DepositQuote depositQuote(UUID id, Account caller) {
      return (DepositQuote) quotes.get(id);
    }

    public WithdrawalQuote withdrawalQuote(UUID id, Account caller) {
      return (WithdrawalQuote) quotes.get(id);
    }

    public Optional<Pending> preparedQuote(UUID id, Account caller) {
      return pending.values().stream()
          .filter(p -> p.action() == Action.SUBMIT && p.request().quoteId().equals(id))
          .findFirst()
          .map(p -> pendingOwned(p.preparationId(), caller));
    }

    public Pending savePreparation(
        UUID id,
        UUID prep,
        UUID command,
        UUID quote,
        Account caller,
        Terms terms,
        SigningPayload signing) {
      var request =
          new Request(
              id,
              quote,
              kind(terms),
              terms,
              Status.PREPARED,
              null,
              clock.now,
              null,
              clock.now,
              null,
              null,
              List.of(),
              null,
              null,
              null,
              false);
      requests.put(id, request);
      var value = new Pending(request, caller.id(), prep, command, Action.SUBMIT, signing, null, 0);
      pending.put(prep, value);
      return value;
    }

    public Request owned(UUID id, Account caller) {
      if (pending.values().stream()
          .noneMatch(p -> p.request().requestId().equals(id) && p.accountId().equals(caller.id())))
        throw new NoSuchElementException();
      return get(id);
    }

    public Request get(UUID id) {
      var r = requests.get(id);
      if (r == null) throw new NoSuchElementException();
      return new Request(
          r.requestId(),
          r.quoteId(),
          r.kind(),
          r.terms(),
          r.status(),
          r.arrivalSequence(),
          r.createdAt(),
          r.submittedAt(),
          r.updatedAt(),
          r.settlementId(),
          r.result(),
          r.allocationCids(),
          r.updateId(),
          r.errorCode(),
          r.error(),
          !r.allocationCids().isEmpty()
              && !r.terms().settlementDeadline().isAfter(clock.now)
              && Set.of(Status.READY, Status.BLOCKED, Status.EXPIRED).contains(r.status()));
    }

    public Pending pendingOwned(UUID id, Account caller) {
      var p = pending.get(id);
      if (p == null || !p.accountId().equals(caller.id())) throw new NoSuchElementException();
      return new Pending(
          owned(p.request().requestId(), caller),
          caller.id(),
          id,
          p.commandId(),
          p.action(),
          p.signing(),
          p.signature(),
          p.beginOffset());
    }

    public boolean begin(UUID id, Account caller, String signature, long offset, Instant now) {
      var p = pendingOwned(id, caller);
      if (p.signature() != null) return false;
      pending.put(
          id,
          new Pending(
              p.request(),
              caller.id(),
              id,
              p.commandId(),
              p.action(),
              p.signing(),
              signature,
              offset));
      phase(
          p.request().requestId(),
          p.action() == Action.SUBMIT ? Status.SUBMITTING : Status.RECOVERING,
          null,
          p.request().allocationCids());
      return true;
    }

    public void confirm(UUID id, Confirmation c) {
      confirmed.add(id);
      phase(pending.get(id).request().requestId(), c.status(), c.result(), c.allocationCids());
    }

    public void uncertain(UUID id) {
      var p = pending.get(id);
      phase(
          p.request().requestId(),
          p.action() == Action.SUBMIT ? Status.UNRESOLVED : Status.RECOVERY_UNRESOLVED,
          null,
          get(p.request().requestId()).allocationCids());
    }

    public List<Pending> unresolved() {
      return pending.values().stream()
          .filter(p -> p.signature() != null && !confirmed.contains(p.preparationId()))
          .map(p -> pendingOwned(p.preparationId(), TRADER))
          .toList();
    }

    public List<Pending> tracked() {
      return pending.values().stream()
          .filter(
              p ->
                  p.action() == Action.SUBMIT
                      && confirmed.contains(p.preparationId())
                      && !Set.of(Status.SETTLED, Status.RECOVERED)
                          .contains(get(p.request().requestId()).status()))
          .map(p -> pendingOwned(p.preparationId(), TRADER))
          .toList();
    }

    public Optional<Pending> latestRecovery(UUID id, Account caller) {
      return pending.values().stream()
          .filter(p -> p.request().requestId().equals(id) && p.action() == Action.RECOVER)
          .reduce((a, b) -> b);
    }

    public Pending saveRecovery(
        UUID id, UUID prep, UUID command, Account caller, SigningPayload signing, Instant now) {
      var p =
          new Pending(
              owned(id, caller), caller.id(), prep, command, Action.RECOVER, signing, null, 0);
      pending.put(prep, p);
      return p;
    }

    private void phase(UUID id, Status status, Result result, List<String> allocations) {
      var r = get(id);
      requests.put(
          id,
          new Request(
              id,
              r.quoteId(),
              r.kind(),
              r.terms(),
              status,
              r.arrivalSequence(),
              r.createdAt(),
              r.submittedAt(),
              clock.now,
              r.settlementId(),
              result,
              allocations,
              "update",
              null,
              null,
              false));
    }
  }
}
