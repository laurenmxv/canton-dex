package com.openzeppelin.dex.swaps;

import static com.openzeppelin.dex.swaps.SwapModels.*;
import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.pools.PoolModels.Instrument;
import java.math.BigDecimal;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.AccessDeniedException;

class SwapWorkflowTest {
  private static final Instant NOW = Instant.parse("2026-09-19T12:00:00Z");
  private static final String PARTY = "alice::namespace";
  private static final String TOKEN = "alice-access-token";
  private static final String SIGNATURE = Base64.getEncoder().encodeToString(new byte[64]);
  private final Account trader =
      new Account(UUID.randomUUID(), "issuer", "alice", "Alice", Account.Role.TRADER);
  private final Account otherTrader =
      new Account(UUID.randomUUID(), "issuer", "bob", "Bob", Account.Role.TRADER);
  private final MutableClock clock = new MutableClock();
  private final Progress store = new Progress(clock);
  private final Ledger ledger = new Ledger(clock);
  private final SwapWorkflow workflow = new SwapWorkflow(store, ledger, clock);

  @Test
  void signedSubmissionUsesStoredIdentityTermsAndCommand() {
    var quote = quote("10");
    var preparation = prepare(quote);
    var result = workflow.submit(trader, TOKEN, signed(preparation));

    assertThat(result.status()).isEqualTo(Status.READY);
    assertThat(result.allocationCids()).containsExactly("input-allocation", "output-allocation");
    assertThat(ledger.submitted.swap().swapId()).isEqualTo(preparation.swapId());
    assertThat(ledger.submitted.commandId()).isEqualTo(preparation.swapId());
    assertThat(ledger.submitted.preparationId()).isEqualTo(preparation.preparationId());
    assertThat(ledger.submitted.accountId()).isEqualTo(trader.id());
    assertThat(ledger.submitted.signature()).isEqualTo(SIGNATURE);
    assertThat(ledger.submitted.beginOffset()).isEqualTo(42);
    assertThat(ledger.submitted.swap().minOut()).isEqualTo(quote.minOut());
    assertThat(ledger.submitted.swap().settlementDeadline()).isEqualTo(quote.settlementDeadline());
    assertThat(ledger.submitted.signing().partyId()).isEqualTo(PARTY);
    assertThat(ledger.caller).isEqualTo(trader);
    assertThat(ledger.token).isEqualTo(TOKEN);
  }

  @Test
  void anotherAccountCannotPrepareSubmitOrReadTheSwap() {
    var quote = quote("10");
    assertThatThrownBy(() -> workflow.prepare(otherTrader, "other-token", approved(quote)))
        .isInstanceOf(NoSuchElementException.class);
    var preparation = prepare(quote);
    assertThatThrownBy(() -> workflow.submit(otherTrader, "other-token", signed(preparation)))
        .isInstanceOf(NoSuchElementException.class);
    assertThatThrownBy(() -> workflow.get(preparation.swapId(), otherTrader))
        .isInstanceOf(NoSuchElementException.class);
    assertThat(ledger.submissions).isZero();
  }

  @Test
  void operatorRoleCannotUseTraderOperations() {
    var operator =
        new Account(UUID.randomUUID(), "issuer", "operator", "Operator", Account.Role.OPERATOR);
    assertThatThrownBy(() -> workflow.quote(operator, "operator-token", input("10")))
        .isInstanceOf(AccessDeniedException.class);
    assertThat(ledger.quotes).isZero();
  }

  @Test
  void actionAndSwapIdentityCannotBeChangedAtSubmission() {
    var preparation = prepare(quote("10"));
    assertThatThrownBy(
            () -> workflow.withdraw(preparation.swapId(), trader, TOKEN, signed(preparation)))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("PREPARATION_MISMATCH"));
    workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = preparation.terms().settlementDeadline();
    var withdrawal = workflow.prepareWithdrawal(preparation.swapId(), trader, TOKEN);

    assertThatThrownBy(() -> workflow.submit(trader, TOKEN, signed(withdrawal)))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("PREPARATION_MISMATCH"));
    assertThatThrownBy(
            () -> workflow.withdraw(UUID.randomUUID(), trader, TOKEN, signed(withdrawal)))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("PREPARATION_MISMATCH"));
    assertThat(ledger.withdrawals).isZero();
  }

  @Test
  void lostResponseRemainsUnknownUntilEvidenceAndIsNeverReplayed() {
    var preparation = prepare(quote("10"));
    ledger.failure = new IllegalStateException("response lost");
    assertThat(workflow.submit(trader, TOKEN, signed(preparation)).status())
        .isEqualTo(Status.UNRESOLVED);
    ledger.offline = true;
    assertThat(workflow.submit(trader, TOKEN, signed(preparation)).status())
        .isEqualTo(Status.UNRESOLVED);
    assertThat(ledger.offsetReads).isEqualTo(1);

    var restarted = new SwapWorkflow(store, ledger, clock);
    restarted.reconcile();
    assertThat(restarted.get(preparation.swapId(), trader).status()).isEqualTo(Status.UNRESOLVED);
    assertThat(ledger.submissions).isEqualTo(1);

    ledger.evidence = Optional.of(ledger.confirmation(Status.READY));
    restarted.reconcile();
    assertThat(restarted.get(preparation.swapId(), trader).status()).isEqualTo(Status.READY);
    assertThat(restarted.submit(trader, TOKEN, signed(preparation)).status())
        .isEqualTo(Status.READY);
    assertThat(ledger.submissions).isEqualTo(1);
    assertThat(ledger.recovered.commandId()).isEqualTo(preparation.swapId());
    assertThat(ledger.recovered.beginOffset()).isEqualTo(42);
  }

  @Test
  void signatureCannotBeReplacedAfterAnUnknownSubmission() {
    var preparation = prepare(quote("10"));
    ledger.failure = new IllegalStateException("response lost");
    workflow.submit(trader, TOKEN, signed(preparation));
    var replacement = new byte[64];
    Arrays.fill(replacement, (byte) 1);
    assertThatThrownBy(
            () ->
                workflow.submit(
                    trader,
                    TOKEN,
                    new SubmitInput(
                        preparation.preparationId(),
                        Base64.getEncoder().encodeToString(replacement))))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("IDEMPOTENCY_CONFLICT"));
    assertThat(ledger.submissions).isEqualTo(1);
    assertThat(ledger.offsetReads).isEqualTo(1);
  }

  @Test
  void definitiveRejectionRecoveredAfterLostResponseEndsTheUnknownState() {
    var preparation = prepare(quote("10"));
    ledger.failure = new IllegalStateException("response lost");
    workflow.submit(trader, TOKEN, signed(preparation));
    ledger.recoveryFailure = new LedgerRejected("CONTRACT_NOT_ACTIVE", "Allocation input consumed");
    new SwapWorkflow(store, ledger, clock).reconcile();
    assertThat(workflow.get(preparation.swapId(), trader).status()).isEqualTo(Status.FAILED);
    assertThat(workflow.get(preparation.swapId(), trader).errorCode())
        .isEqualTo("CONTRACT_NOT_ACTIVE");
    assertThat(ledger.submissions).isEqualTo(1);
    assertThat(store.unresolved()).isEmpty();
  }

  @Test
  void malformedSignatureDoesNotClaimOrSendThePreparation() {
    var preparation = prepare(quote("10"));
    for (var signature :
        List.of("not base64!", "", Base64.getEncoder().encodeToString(new byte[145]))) {
      assertThatThrownBy(
              () ->
                  workflow.submit(
                      trader, TOKEN, new SubmitInput(preparation.preparationId(), signature)))
          .isInstanceOf(IllegalArgumentException.class);
    }
    assertThat(store.attempted).isEmpty();
    assertThat(ledger.submissions).isZero();
    assertThat(workflow.submit(trader, TOKEN, signed(preparation)).status())
        .isEqualTo(Status.READY);
  }

  @Test
  void locallyInvalidWalletSignatureNeverClaimsThePreparationOrEntersTheQueue() {
    var preparation = prepare(quote("10"));
    ledger.verificationFailure =
        new IllegalArgumentException("Signature does not match the registered wallet");
    assertThatThrownBy(() -> workflow.submit(trader, TOKEN, signed(preparation)))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(store.attempted).isEmpty();
    assertThat(ledger.submissions).isZero();
    assertThat(ledger.offsetReads).isZero();
    assertThat(workflow.get(preparation.swapId(), trader).status()).isEqualTo(Status.PREPARED);
    ledger.verificationFailure = null;
    assertThat(workflow.submit(trader, TOKEN, signed(preparation)).status())
        .isEqualTo(Status.READY);
  }

  @Test
  void definitiveSubmissionRejectionIsFailedAndNotReplayed() {
    var preparation = prepare(quote("10"));
    ledger.failure = new LedgerRejected("INVALID_SIGNATURE", "Signature was rejected");
    var result = workflow.submit(trader, TOKEN, signed(preparation));
    assertThat(result.status()).isEqualTo(Status.FAILED);
    assertThat(result.errorCode()).isEqualTo("INVALID_SIGNATURE");
    workflow.submit(trader, TOKEN, signed(preparation));
    workflow.reconcile();
    assertThat(ledger.submissions).isEqualTo(1);
    assertThat(store.unresolved()).isEmpty();
  }

  @Test
  void sameQuoteCannotBePreparedWithDifferentMinimumOrDeadline() {
    var quote = quote("10");
    var first =
        workflow.prepare(
            trader, TOKEN, new PrepareInput(quote.quoteId(), "90", quote.settlementDeadline()));
    var same =
        workflow.prepare(
            trader, TOKEN, new PrepareInput(quote.quoteId(), "90.0", quote.settlementDeadline()));
    assertThat(same).isEqualTo(first);

    for (var changed :
        List.of(
            new PrepareInput(quote.quoteId(), "89", quote.settlementDeadline()),
            new PrepareInput(quote.quoteId(), "90", quote.settlementDeadline().minusSeconds(1)))) {
      assertThatThrownBy(() -> workflow.prepare(trader, TOKEN, changed))
          .isInstanceOfSatisfying(
              SwapFailure.class,
              failure -> assertThat(failure.code()).isEqualTo("IDEMPOTENCY_CONFLICT"));
    }
    assertThat(ledger.preparations).isEqualTo(1);
  }

  @Test
  void revocationBlocksCachedPreparationsAndDispatchWithoutHidingProgress() {
    var quote = quote("10");
    var preparation = prepare(quote);
    ledger.accessRevoked = true;
    assertThatThrownBy(() -> prepare(quote))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("POOL_ACCESS_REQUIRED"));
    assertThatThrownBy(() -> workflow.submit(trader, TOKEN, signed(preparation)))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("POOL_ACCESS_REQUIRED"));
    assertThat(store.attempted).isEmpty();
    assertThat(ledger.submissions).isZero();
    assertThat(workflow.get(preparation.swapId(), trader).status()).isEqualTo(Status.PREPARED);
    ledger.accessRevoked = false;
    workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = preparation.terms().settlementDeadline();
    var withdrawal = workflow.prepareWithdrawal(preparation.swapId(), trader, TOKEN);
    ledger.accessRevoked = true;
    assertThatThrownBy(() -> workflow.prepareWithdrawal(preparation.swapId(), trader, TOKEN))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("POOL_ACCESS_REQUIRED"));
    assertThatThrownBy(
            () -> workflow.withdraw(preparation.swapId(), trader, TOKEN, signed(withdrawal)))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("POOL_ACCESS_REQUIRED"));
    assertThat(store.attempted).containsExactly(preparation.preparationId());
    assertThat(ledger.withdrawals).isZero();
    assertThat(workflow.submit(trader, TOKEN, signed(preparation)).status())
        .isEqualTo(Status.READY);
  }

  @Test
  void quoteAcceptsNativeDecimalAmountsAboveOneMillion() {
    for (var valid :
        List.of("1000000.0000000001", "9999999999999999999999999999.9999999999", "0.0000000001"))
      assertThat(quote(valid).amountIn()).isEqualTo(valid);
    for (var invalid :
        List.of("0", "-1", "10000000000000000000000000000", "0.00000000001", "1e3", "01", "1 ")) {
      assertThatThrownBy(() -> quote(invalid))
          .as(invalid)
          .isInstanceOf(IllegalArgumentException.class);
    }
    assertThat(ledger.quotes).isEqualTo(3);
  }

  @Test
  void preparesQuotedInputOutputMinimumAndFeeAboveOneMillion() {
    ledger.expectedOut = "24000000000";
    ledger.minOut = "23000000000";
    var quote = quote("30000000000");
    var preparation = prepare(quote);
    assertThat(preparation.terms().amountIn()).isEqualTo("30000000000");
    assertThat(preparation.terms().expectedOut()).isEqualTo("24000000000");
    assertThat(preparation.terms().minOut()).isEqualTo("23000000000");
    assertThat(preparation.terms().feeAmount()).isEqualTo("90000000");
  }

  @Test
  void prepareRejectsUnsupportedMinimumAndDeadline() {
    var quote = quote("10");
    for (var invalid :
        List.of("10000000000000000000000000000", "0.00000000001", "100.0000000001", "-1")) {
      assertThatThrownBy(
              () ->
                  workflow.prepare(
                      trader,
                      TOKEN,
                      new PrepareInput(quote.quoteId(), invalid, quote.settlementDeadline())))
          .as(invalid)
          .isInstanceOf(IllegalArgumentException.class);
    }
    assertThatThrownBy(
            () ->
                workflow.prepare(
                    trader,
                    TOKEN,
                    new PrepareInput(
                        quote.quoteId(), "90", quote.settlementDeadline().plusSeconds(1))))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(ledger.preparations).isZero();
  }

  @Test
  void submicrosecondDeadlineIsRejectedBeforePreparingOrSaving() {
    var quote = quote("10");
    for (var nanos : List.of(1, 999, 1001)) {
      var deadline = quote.settlementDeadline().minusSeconds(1).plusNanos(nanos);
      assertThatThrownBy(
              () ->
                  workflow.prepare(
                      trader, TOKEN, new PrepareInput(quote.quoteId(), quote.minOut(), deadline)))
          .as("deadline %s", deadline)
          .isInstanceOf(IllegalArgumentException.class);
    }
    assertThat(ledger.preparations).isZero();
    assertThat(store.preparations).isEmpty();
    assertThat(store.swaps).isEmpty();
  }

  @Test
  void microsecondDeadlineIsPreservedInPreparedTermsAndStoredSwap() {
    for (var nanos : List.of(1000, 123456000)) {
      var quote = quote("10");
      var deadline = quote.settlementDeadline().minusSeconds(1).plusNanos(nanos);
      var preparation =
          workflow.prepare(
              trader, TOKEN, new PrepareInput(quote.quoteId(), quote.minOut(), deadline));
      assertThat(preparation.terms().settlementDeadline()).isEqualTo(deadline);
      assertThat(workflow.get(preparation.swapId(), trader).settlementDeadline())
          .isEqualTo(deadline);
    }
    assertThat(ledger.preparations).isEqualTo(2);
    assertThat(store.preparations).hasSize(2);
  }

  @Test
  void informationalFeeRetainsExactBpsPrecisionForOneSatoshi() {
    assertThat(quote("0.00000001").feeAmount()).isEqualTo("0.00000000003");
    for (var invalid : List.of("0.000000000000003", "0.00000001001")) {
      ledger.feeOverride = invalid;
      assertThatThrownBy(() -> quote("0.00000001"))
          .as(invalid)
          .isInstanceOf(IllegalArgumentException.class);
    }
  }

  @Test
  void expiredQuoteAndElapsedSettlementDeadlineCannotBePrepared() {
    var quote = quote("10");
    assertThatThrownBy(
            () -> workflow.prepare(trader, TOKEN, new PrepareInput(quote.quoteId(), "90", NOW)))
        .isInstanceOfSatisfying(
            SwapFailure.class, failure -> assertThat(failure.code()).isEqualTo("DEADLINE_ELAPSED"));
    clock.now = quote.quoteExpiresAt();
    assertThatThrownBy(() -> prepare(quote))
        .isInstanceOfSatisfying(
            SwapFailure.class, failure -> assertThat(failure.code()).isEqualTo("QUOTE_EXPIRED"));
    assertThat(ledger.preparations).isZero();
  }

  @Test
  void signingPayloadForAnotherPartyCannotBePersisted() {
    ledger.signingParty = "bob::namespace";
    assertThatThrownBy(() -> prepare(quote("10"))).isInstanceOf(IllegalStateException.class);
    assertThat(store.preparations).isEmpty();
  }

  @Test
  void expiredPreparationCannotBeOfferedForSigningAgain() {
    var quote = quote("10");
    var preparation = prepare(quote);
    clock.now = preparation.expiresAt();

    assertThatThrownBy(() -> prepare(quote))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("PREPARATION_EXPIRED"));
    assertThat(ledger.preparations).isEqualTo(1);
    assertThat(ledger.submissions).isZero();
    assertThat(store.preparations).hasSize(1);
  }

  @Test
  void expiredPreparationDoesNotReplaceOrCloseAnUnknownSubmission() {
    var quote = quote("10");
    var preparation = prepare(quote);
    ledger.failure = new IllegalStateException("response lost");
    workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = preparation.expiresAt();

    assertThatThrownBy(() -> prepare(quote))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("PREPARATION_EXPIRED"));
    assertThat(workflow.get(preparation.swapId(), trader).status()).isEqualTo(Status.UNRESOLVED);
    ledger.evidence = Optional.of(ledger.confirmation(Status.READY));
    workflow.reconcile();
    assertThat(workflow.get(preparation.swapId(), trader).status()).isEqualTo(Status.READY);
    assertThat(ledger.preparations).isEqualTo(1);
    assertThat(ledger.submissions).isEqualTo(1);
    assertThat(store.preparations).hasSize(1);
  }

  @Test
  void withdrawalRequiresDeadlineAndConfirmedAllocations() {
    var preparation = prepare(quote("10"));
    workflow.submit(trader, TOKEN, signed(preparation));
    assertThatThrownBy(() -> workflow.prepareWithdrawal(preparation.swapId(), trader, TOKEN))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("DEADLINE_NOT_ELAPSED"));
    clock.now = preparation.terms().settlementDeadline();
    var withdrawal = workflow.prepareWithdrawal(preparation.swapId(), trader, TOKEN);
    assertThat(withdrawal.action()).isEqualTo(Action.WITHDRAW);
    assertThat(workflow.get(preparation.swapId(), trader).status()).isEqualTo(Status.READY);
    assertThat(workflow.withdraw(preparation.swapId(), trader, TOKEN, signed(withdrawal)).status())
        .isEqualTo(Status.WITHDRAWN);
    assertThat(workflow.get(preparation.swapId(), trader).canWithdraw()).isFalse();
  }

  @Test
  void lateSettlementInvalidatesAnUnsignedWithdrawalPreparation() {
    var preparation = prepare(quote("10"));
    workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = preparation.terms().settlementDeadline();
    workflow.prepareWithdrawal(preparation.swapId(), trader, TOKEN);
    ledger.observation = Optional.of(ledger.confirmation(Status.SETTLED));
    workflow.reconcile();
    assertThatThrownBy(() -> workflow.prepareWithdrawal(preparation.swapId(), trader, TOKEN))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("WITHDRAWAL_UNAVAILABLE"));
    assertThat(ledger.withdrawals).isZero();
  }

  @Test
  void elapsedDeadlineWithoutConfirmedAllocationsCannotReleaseFunds() {
    var preparation = prepare(quote("10"));
    ledger.failure = new IllegalStateException("response lost");
    workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = preparation.terms().settlementDeadline();
    assertThatThrownBy(() -> workflow.prepareWithdrawal(preparation.swapId(), trader, TOKEN))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("WITHDRAWAL_UNAVAILABLE"));
    assertThat(workflow.get(preparation.swapId(), trader).status()).isEqualTo(Status.UNRESOLVED);
    assertThat(ledger.withdrawalPreparations).isZero();
  }

  @Test
  void rejectedWithdrawalKeepsConfirmedAllocationsAndExpiredState() {
    var preparation = prepare(quote("10"));
    workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = preparation.terms().settlementDeadline();
    var withdrawal = workflow.prepareWithdrawal(preparation.swapId(), trader, TOKEN);
    ledger.failure = new LedgerRejected("WITHDRAW_REJECTED", "Withdrawal rejected");
    var result = workflow.withdraw(preparation.swapId(), trader, TOKEN, signed(withdrawal));
    assertThat(result.status()).isEqualTo(Status.EXPIRED);
    assertThat(result.allocationCids()).containsExactly("input-allocation", "output-allocation");
    assertThat(result.canWithdraw()).isTrue();
    assertThat(result.errorCode()).isEqualTo("WITHDRAW_REJECTED");
    workflow.withdraw(preparation.swapId(), trader, TOKEN, signed(withdrawal));
    assertThat(ledger.withdrawals).isEqualTo(1);
    var retry = workflow.prepareWithdrawal(preparation.swapId(), trader, TOKEN);
    assertThat(retry.preparationId()).isNotEqualTo(withdrawal.preparationId());
    ledger.failure = null;
    assertThat(workflow.withdraw(preparation.swapId(), trader, TOKEN, signed(retry)).status())
        .isEqualTo(Status.WITHDRAWN);
    assertThat(ledger.withdrawals).isEqualTo(2);
  }

  @Test
  void lostWithdrawalResponseIsNotReportedAsReleasedOrReplayed() {
    var preparation = prepare(quote("10"));
    workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = preparation.terms().settlementDeadline();
    var withdrawal = workflow.prepareWithdrawal(preparation.swapId(), trader, TOKEN);
    ledger.failure = new IllegalStateException("response lost");
    assertThat(workflow.withdraw(preparation.swapId(), trader, TOKEN, signed(withdrawal)).status())
        .isEqualTo(Status.WITHDRAWAL_UNRESOLVED);
    workflow.withdraw(preparation.swapId(), trader, TOKEN, signed(withdrawal));
    workflow.reconcile();
    assertThat(workflow.get(preparation.swapId(), trader).status())
        .isEqualTo(Status.WITHDRAWAL_UNRESOLVED);
    assertThat(ledger.withdrawals).isEqualTo(1);

    ledger.evidence = Optional.of(ledger.confirmation(Status.WITHDRAWN));
    new SwapWorkflow(store, ledger, clock).reconcile();
    assertThat(workflow.get(preparation.swapId(), trader).status()).isEqualTo(Status.WITHDRAWN);
    assertThat(ledger.withdrawals).isEqualTo(1);
  }

  @Test
  void walletWithdrawalWhileBackendWasOfflineRequiresPositiveTerminalEvidence() {
    var preparation = prepare(quote("10"));
    workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = preparation.terms().settlementDeadline();
    var restarted = new SwapWorkflow(store, ledger, clock);
    restarted.reconcile();
    assertThat(restarted.get(preparation.swapId(), trader).status()).isEqualTo(Status.READY);

    ledger.observation = Optional.of(ledger.confirmation(Status.WITHDRAWN));
    restarted.reconcile();
    assertThat(restarted.get(preparation.swapId(), trader).status()).isEqualTo(Status.WITHDRAWN);
    assertThat(restarted.get(preparation.swapId(), trader).canWithdraw()).isFalse();
    assertThat(ledger.submissions).isEqualTo(1);
    assertThat(ledger.withdrawals).isZero();
  }

  private Quote quote(String amount) {
    return workflow.quote(trader, TOKEN, input(amount));
  }

  private QuoteInput input(String amount) {
    return new QuoteInput("pool", Direction.BaseToQuote, amount, 100);
  }

  private PrepareInput approved(Quote quote) {
    return new PrepareInput(quote.quoteId(), quote.minOut(), quote.settlementDeadline());
  }

  private Preparation prepare(Quote quote) {
    return workflow.prepare(trader, TOKEN, approved(quote));
  }

  private SubmitInput signed(Preparation preparation) {
    return new SubmitInput(preparation.preparationId(), SIGNATURE);
  }

  private static final class MutableClock extends Clock {
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

  private static final class Ledger implements SwapLedger {
    final Clock clock;
    String signingParty = PARTY;
    String feeOverride;
    String expectedOut = "100";
    String minOut = "99";
    boolean accessRevoked;
    RuntimeException failure;
    RuntimeException verificationFailure;
    RuntimeException recoveryFailure;
    Optional<Confirmation> evidence = Optional.empty();
    Optional<Confirmation> observation = Optional.empty();
    boolean offline;
    int offsetReads;
    int quotes;
    int preparations;
    int submissions;
    int withdrawalPreparations;
    int withdrawals;
    Pending submitted;
    Pending recovered;
    Account caller;
    String token;

    Ledger(Clock clock) {
      this.clock = clock;
    }

    public void requireAccess(Account caller, String poolId) {
      if (accessRevoked)
        throw SwapFailure.conflict("POOL_ACCESS_REQUIRED", "Current pool access is required");
    }

    public long offset() {
      offsetReads++;
      if (offline) throw new IllegalStateException("participant offline");
      return 42;
    }

    public Quote quote(UUID id, Account caller, String token, QuoteInput input) {
      quotes++;
      return new Quote(
          id,
          input.poolId(),
          "BTC/USDC",
          PARTY,
          input.direction(),
          new Instrument("issuer", "BTC"),
          new Instrument("issuer", "USDC"),
          input.amountIn(),
          expectedOut,
          feeOverride == null
              ? new BigDecimal(input.amountIn())
                  .multiply(new BigDecimal("0.003"))
                  .stripTrailingZeros()
                  .toPlainString()
              : feeOverride,
          minOut,
          input.slippageBps(),
          "pool-state",
          clock.instant().plusSeconds(30),
          clock.instant().plusSeconds(120));
    }

    public SigningPayload prepare(
        UUID swapId, UUID command, Account caller, String token, Terms terms) {
      preparations++;
      return signing();
    }

    public Confirmation submit(Pending pending, Account caller, String token) {
      submissions++;
      submitted = pending;
      this.caller = caller;
      this.token = token;
      if (failure != null) throw failure;
      return confirmation(Status.READY);
    }

    public void verify(SigningPayload signing, String signature, Account caller) {
      if (verificationFailure != null) throw verificationFailure;
    }

    public Optional<Confirmation> recover(Pending pending) {
      recovered = pending;
      if (recoveryFailure != null) throw recoveryFailure;
      return evidence;
    }

    public Optional<Confirmation> observe(Pending pending) {
      return observation;
    }

    public SigningPayload prepareWithdrawal(UUID command, Swap swap, Account caller, String token) {
      withdrawalPreparations++;
      return signing();
    }

    public Confirmation withdraw(Pending pending, Account caller, String token) {
      withdrawals++;
      if (failure != null) throw failure;
      return confirmation(Status.WITHDRAWN);
    }

    SigningPayload signing() {
      return new SigningPayload(
          "opaque-prepared-transaction",
          Base64.getEncoder().encodeToString(new byte[32]),
          2,
          signingParty,
          "alice-key",
          clock.instant().plusSeconds(20));
    }

    Confirmation confirmation(Status status) {
      return new Confirmation(
          status,
          List.of("input-allocation", "output-allocation"),
          null,
          "update-" + status,
          43,
          clock.instant());
    }
  }

  private static final class Progress extends SwapStore {
    final Clock clock;
    final Map<UUID, Quote> quotes = new HashMap<>();
    final Map<UUID, UUID> quoteOwners = new HashMap<>();
    final Map<UUID, Pending> preparations = new LinkedHashMap<>();
    final Map<UUID, Swap> swaps = new HashMap<>();
    final Map<UUID, UUID> owners = new HashMap<>();
    final Set<UUID> attempted = new HashSet<>();
    final Set<UUID> awaitingEvidence = new HashSet<>();
    final Set<UUID> confirmed = new HashSet<>();
    final Set<UUID> failed = new HashSet<>();

    Progress(Clock clock) {
      super(null, null, null, 10);
      this.clock = clock;
    }

    public void saveQuote(Quote quote, Account caller) {
      quotes.put(quote.quoteId(), quote);
      quoteOwners.put(quote.quoteId(), caller.id());
    }

    public Quote quote(UUID id, Account caller) {
      if (!caller.id().equals(quoteOwners.get(id))) throw new NoSuchElementException();
      return quotes.get(id);
    }

    public Optional<Pending> preparedQuote(UUID quoteId, Account caller) {
      return preparations.values().stream()
          .filter(
              p ->
                  p.action() == Action.SUBMIT
                      && p.accountId().equals(caller.id())
                      && p.swap().quoteId().equals(quoteId))
          .findFirst()
          .map(p -> pendingOwned(p.preparationId(), caller));
    }

    public Pending savePreparation(
        UUID id,
        UUID preparation,
        UUID command,
        UUID quoteId,
        Account caller,
        Terms terms,
        SigningPayload signing) {
      var swap =
          new Swap(
              id,
              quoteId,
              terms.poolId(),
              terms.poolName(),
              terms.trader(),
              terms.direction(),
              terms.inputInstrument(),
              terms.outputInstrument(),
              terms.amountIn(),
              terms.expectedOut(),
              terms.feeAmount(),
              terms.minOut(),
              terms.settlementDeadline(),
              Status.PREPARED,
              null,
              clock.instant(),
              null,
              clock.instant(),
              null,
              null,
              List.of(),
              null,
              null,
              null,
              false);
      swaps.put(id, swap);
      owners.put(id, caller.id());
      var pending =
          new Pending(swap, caller.id(), preparation, command, Action.SUBMIT, signing, null, 0);
      preparations.put(preparation, pending);
      return pending;
    }

    public Swap owned(UUID id, Account caller) {
      if (!caller.id().equals(owners.get(id))) throw new NoSuchElementException();
      return get(id);
    }

    public Swap get(UUID id) {
      var swap = swaps.get(id);
      if (swap == null) throw new NoSuchElementException();
      boolean canWithdraw =
          !swap.allocationCids().isEmpty()
              && !swap.settlementDeadline().isAfter(clock.instant())
              && !Set.of(
                      Status.SETTLED,
                      Status.WITHDRAWN,
                      Status.WITHDRAWING,
                      Status.WITHDRAWAL_UNRESOLVED)
                  .contains(swap.status());
      return copy(swap, swap.status(), swap.errorCode(), swap.error(), canWithdraw);
    }

    public Pending pendingOwned(UUID id, Account caller) {
      var pending = preparations.get(id);
      if (pending == null || !pending.accountId().equals(caller.id()))
        throw new NoSuchElementException();
      return new Pending(
          owned(pending.swap().swapId(), caller),
          pending.accountId(),
          id,
          pending.commandId(),
          pending.action(),
          pending.signing(),
          pending.signature(),
          pending.beginOffset());
    }

    public boolean begin(UUID id, Account caller, String signature, long offset, Instant now) {
      var pending = pendingOwned(id, caller);
      if (pending.signature() != null && !pending.signature().equals(signature))
        throw SwapFailure.conflict("IDEMPOTENCY_CONFLICT", "Different signature");
      if (!attempted.add(id)) return false;
      preparations.put(
          id,
          new Pending(
              pending.swap(),
              caller.id(),
              id,
              pending.commandId(),
              pending.action(),
              pending.signing(),
              signature,
              offset));
      awaitingEvidence.add(id);
      phase(
          id,
          pending.action() == Action.SUBMIT ? Status.SUBMITTING : Status.WITHDRAWING,
          null,
          null);
      return true;
    }

    public void confirm(UUID id, Confirmation confirmation) {
      var pending = preparations.get(id);
      var swap = get(pending.swap().swapId());
      swaps.put(
          swap.swapId(),
          new Swap(
              swap.swapId(),
              swap.quoteId(),
              swap.poolId(),
              swap.poolName(),
              swap.trader(),
              swap.direction(),
              swap.inputInstrument(),
              swap.outputInstrument(),
              swap.amountIn(),
              swap.expectedOut(),
              swap.feeAmount(),
              swap.minOut(),
              swap.settlementDeadline(),
              confirmation.status(),
              swap.arrivalSequence(),
              swap.createdAt(),
              swap.submittedAt(),
              confirmation.confirmedAt(),
              swap.settlementId(),
              confirmation.amountOut(),
              confirmation.allocationCids(),
              confirmation.updateId(),
              null,
              null,
              false));
      awaitingEvidence.remove(id);
      confirmed.add(id);
    }

    public void uncertain(UUID id) {
      phase(
          id,
          preparations.get(id).action() == Action.SUBMIT
              ? Status.UNRESOLVED
              : Status.WITHDRAWAL_UNRESOLVED,
          "CONFIRMATION_PENDING",
          "Waiting for ledger confirmation");
    }

    public void rejected(UUID id, LedgerRejected failure) {
      phase(
          id,
          preparations.get(id).action() == Action.SUBMIT ? Status.FAILED : Status.EXPIRED,
          failure.code(),
          failure.getMessage());
      awaitingEvidence.remove(id);
      failed.add(id);
    }

    public List<Pending> unresolved() {
      return awaitingEvidence.stream().map(preparations::get).toList();
    }

    public List<Pending> tracked() {
      return confirmed.stream()
          .map(preparations::get)
          .filter(
              p ->
                  p.action() == Action.SUBMIT
                      && !Set.of(Status.SETTLED, Status.WITHDRAWN)
                          .contains(get(p.swap().swapId()).status()))
          .map(
              p ->
                  new Pending(
                      get(p.swap().swapId()),
                      p.accountId(),
                      p.preparationId(),
                      p.commandId(),
                      p.action(),
                      p.signing(),
                      p.signature(),
                      p.beginOffset()))
          .toList();
    }

    public Optional<Pending> latestWithdrawal(UUID id, Account caller) {
      owned(id, caller);
      return preparations.values().stream()
          .filter(
              p ->
                  p.swap().swapId().equals(id)
                      && p.action() == Action.WITHDRAW
                      && !failed.contains(p.preparationId()))
          .reduce((first, last) -> last)
          .map(p -> pendingOwned(p.preparationId(), caller));
    }

    public Pending saveWithdrawal(
        UUID id,
        UUID preparation,
        UUID command,
        Account caller,
        SigningPayload signing,
        Instant now) {
      var pending =
          new Pending(
              owned(id, caller),
              caller.id(),
              preparation,
              command,
              Action.WITHDRAW,
              signing,
              null,
              0);
      preparations.put(preparation, pending);
      return pending;
    }

    private void phase(UUID id, Status status, String code, String error) {
      var swap = get(preparations.get(id).swap().swapId());
      swaps.put(swap.swapId(), copy(swap, status, code, error, false));
    }

    private Swap copy(Swap swap, Status status, String code, String error, boolean canWithdraw) {
      return new Swap(
          swap.swapId(),
          swap.quoteId(),
          swap.poolId(),
          swap.poolName(),
          swap.trader(),
          swap.direction(),
          swap.inputInstrument(),
          swap.outputInstrument(),
          swap.amountIn(),
          swap.expectedOut(),
          swap.feeAmount(),
          swap.minOut(),
          swap.settlementDeadline(),
          status,
          swap.arrivalSequence(),
          swap.createdAt(),
          swap.submittedAt(),
          clock.instant(),
          swap.settlementId(),
          swap.amountOut(),
          swap.allocationCids(),
          swap.updateId(),
          code,
          error,
          canWithdraw);
    }
  }
}
