package com.openzeppelin.dex.liquidity;

import static com.openzeppelin.dex.liquidity.LiquidityModels.*;

import com.openzeppelin.dex.iam.Account;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public final class LiquidityWorkflow {
  private static final Logger LOG = LoggerFactory.getLogger(LiquidityWorkflow.class);
  private final LiquidityStore store;
  private final LiquidityLedger ledger;
  private final Clock clock;

  @Autowired
  public LiquidityWorkflow(LiquidityStore store, LiquidityLedger ledger) {
    this(store, ledger, Clock.systemUTC());
  }

  LiquidityWorkflow(LiquidityStore store, LiquidityLedger ledger, Clock clock) {
    this.store = store;
    this.ledger = ledger;
    this.clock = clock;
  }

  public DepositQuote quoteDeposit(Account caller, String token, DepositQuoteInput input) {
    caller.requireRole(Account.Role.TRADER);
    decimal(input.maxBaseAmount(), false);
    decimal(input.maxQuoteAmount(), false);
    slippage(input.slippageBps());
    UUID id = UUID.randomUUID();
    var quote = ledger.quoteDeposit(id, caller, token, input);
    if (!id.equals(quote.quoteId())
        || !input.poolId().equals(quote.poolId())
        || !equalAmount(input.maxBaseAmount(), quote.maxBaseAmount())
        || !equalAmount(input.maxQuoteAmount(), quote.maxQuoteAmount()))
      throw new IllegalStateException("Deposit quote differs from requested terms");
    store.saveQuote(quote, caller);
    return quote;
  }

  public WithdrawalQuote quoteWithdrawal(Account caller, String token, WithdrawalQuoteInput input) {
    caller.requireRole(Account.Role.TRADER);
    decimal(input.lpAmount(), false);
    slippage(input.slippageBps());
    UUID id = UUID.randomUUID();
    var quote = ledger.quoteWithdrawal(id, caller, token, input);
    if (!id.equals(quote.quoteId())
        || !input.poolId().equals(quote.poolId())
        || !equalAmount(input.lpAmount(), quote.lpAmount()))
      throw new IllegalStateException("Withdrawal quote differs from requested terms");
    store.saveQuote(quote, caller);
    return quote;
  }

  public Preparation prepareDeposit(Account caller, String token, PrepareDepositInput input) {
    caller.requireRole(Account.Role.TRADER);
    var quote = store.depositQuote(input.quoteId(), caller);
    minimum(input.minLpOut(), quote.expectedLpOut());
    var minRatio = decimal(input.minRatio(), false);
    var maxRatio = decimal(input.maxRatio(), false);
    if (minRatio.compareTo(maxRatio) > 0)
      throw new IllegalArgumentException("Minimum ratio exceeds maximum ratio");
    deadline(input.settlementDeadline(), quote.settlementDeadline());
    var terms =
        new DepositTerms(
            quote.poolId(),
            quote.poolName(),
            quote.trader(),
            quote.baseInstrument(),
            quote.quoteInstrument(),
            quote.lpInstrument(),
            quote.mode(),
            quote.maxBaseAmount(),
            quote.maxQuoteAmount(),
            quote.expectedBaseAmount(),
            quote.expectedQuoteAmount(),
            quote.expectedBaseRefund(),
            quote.expectedQuoteRefund(),
            quote.expectedLpOut(),
            canonical(input.minLpOut()),
            canonical(input.minRatio()),
            canonical(input.maxRatio()),
            quote.initialMinimumLp(),
            input.settlementDeadline());
    return prepare(caller, token, input.quoteId(), quote.quoteExpiresAt(), terms);
  }

  public Preparation prepareWithdrawal(Account caller, String token, PrepareWithdrawalInput input) {
    caller.requireRole(Account.Role.TRADER);
    var quote = store.withdrawalQuote(input.quoteId(), caller);
    minimum(input.minBaseOut(), quote.expectedBaseOut());
    minimum(input.minQuoteOut(), quote.expectedQuoteOut());
    deadline(input.settlementDeadline(), quote.settlementDeadline());
    var terms =
        new WithdrawalTerms(
            quote.poolId(),
            quote.poolName(),
            quote.trader(),
            quote.baseInstrument(),
            quote.quoteInstrument(),
            quote.lpInstrument(),
            quote.lpAmount(),
            quote.expectedBaseOut(),
            quote.expectedQuoteOut(),
            canonical(input.minBaseOut()),
            canonical(input.minQuoteOut()),
            input.settlementDeadline());
    return prepare(caller, token, input.quoteId(), quote.quoteExpiresAt(), terms);
  }

  private Preparation prepare(
      Account caller, String token, UUID quoteId, Instant quoteExpiry, Terms terms) {
    var previous = store.preparedQuote(quoteId, caller);
    if (previous.isPresent()) {
      sameTerms(previous.get().request().terms(), terms);
      if (!previous.get().signing().expiresAt().isAfter(clock.instant()))
        throw new LiquidityFailure(
            "PREPARATION_EXPIRED", "Check this request before requesting a new quote");
      ledger.requireAccess(caller, terms.poolId());
      return preparation(previous.get());
    }
    Instant now = clock.instant();
    if (!quoteExpiry.isAfter(now))
      throw new LiquidityFailure("QUOTE_EXPIRED", "Request a new quote");
    if (!terms.settlementDeadline().isAfter(now))
      throw new LiquidityFailure("DEADLINE_ELAPSED", "The settlement deadline has elapsed");
    UUID requestId = UUID.randomUUID(), preparationId = UUID.randomUUID();
    var signing = ledger.prepare(requestId, requestId, caller, token, terms);
    validateSigning(signing, terms.trader());
    if (!signing.recoveryEffects().isEmpty())
      throw new IllegalStateException("Request preparation contains recovery effects");
    var stored =
        store.savePreparation(requestId, preparationId, requestId, quoteId, caller, terms, signing);
    sameTerms(stored.request().terms(), terms);
    return preparation(stored);
  }

  public Request submit(Kind kind, Account caller, String token, SubmitInput input) {
    caller.requireRole(Account.Role.TRADER);
    var pending = store.pendingOwned(input.preparationId(), caller);
    requireKind(pending.request(), kind);
    if (pending.action() != Action.SUBMIT)
      throw new LiquidityFailure(
          "PREPARATION_MISMATCH", "This preparation recovers an expired request");
    return execute(caller, token, input, pending);
  }

  public Request get(UUID id, Kind kind, Account caller) {
    caller.requireRole(Account.Role.TRADER);
    return requireKind(store.owned(id, caller), kind);
  }

  public Activity activity(Account caller, Kind kind, int limit, String cursor, String status) {
    caller.requireRole(Account.Role.TRADER);
    return store.activity(caller, kind, limit, cursor, status);
  }

  public Positions positions(Account caller, String token) {
    caller.requireRole(Account.Role.TRADER);
    return ledger.positions(caller, token);
  }

  public Preparation prepareRecovery(UUID id, Kind kind, Account caller, String token) {
    var request = get(id, kind, caller);
    if (request.status() == Status.SETTLED)
      throw new LiquidityFailure("RECOVERY_UNAVAILABLE", "The request has already settled");
    var previous = store.latestRecovery(id, caller);
    if (previous.isPresent()
        && (previous.get().signature() != null
            || previous.get().signing().expiresAt().isAfter(clock.instant()))) {
      ledger.requireAccess(caller, request.terms().poolId());
      return preparation(previous.get());
    }
    if (request.terms().settlementDeadline().isAfter(clock.instant()))
      throw new LiquidityFailure(
          "DEADLINE_NOT_ELAPSED", "Recovery is available after the settlement deadline");
    if (!request.canRecover())
      throw new LiquidityFailure(
          "RECOVERY_UNAVAILABLE", "No confirmed unsettled allocations can be recovered");
    UUID command = UUID.randomUUID(), preparationId = UUID.randomUUID();
    var signing = ledger.prepareRecovery(command, request, caller, token);
    validateSigning(signing, request.terms().trader());
    if (signing.recoveryEffects().isEmpty())
      throw new LiquidityFailure(
          "RECOVERY_UNAVAILABLE", "No active allocations remain; refresh the request");
    return preparation(
        store.saveRecovery(id, preparationId, command, caller, signing, clock.instant()));
  }

  public Request recover(UUID id, Kind kind, Account caller, String token, SubmitInput input) {
    caller.requireRole(Account.Role.TRADER);
    var pending = store.pendingOwned(input.preparationId(), caller);
    requireKind(pending.request(), kind);
    if (pending.action() != Action.RECOVER || !pending.request().requestId().equals(id))
      throw new LiquidityFailure(
          "PREPARATION_MISMATCH", "This preparation does not recover the selected request");
    return execute(caller, token, input, pending);
  }

  private Request execute(Account caller, String token, SubmitInput input, Pending pending) {
    byte[] signature;
    try {
      signature = Base64.getDecoder().decode(input.signature());
    } catch (IllegalArgumentException e) {
      throw new IllegalArgumentException("Invalid signature encoding");
    }
    if (signature.length < 32 || signature.length > 144)
      throw new IllegalArgumentException("Invalid signature length");
    if (pending.signature() != null) {
      if (!pending.signature().equals(input.signature()))
        throw new LiquidityFailure(
            "IDEMPOTENCY_CONFLICT", "This preparation already has a different signature");
      return store.owned(pending.request().requestId(), caller);
    }
    ledger.verify(pending.signing(), input.signature(), caller);
    ledger.requireAccess(caller, pending.request().terms().poolId());
    // Persist the dispatch decision first; uncertain outcomes are reconciled, never blindly resent.
    if (store.begin(
        input.preparationId(), caller, input.signature(), ledger.offset(), clock.instant())) {
      pending = store.pendingOwned(input.preparationId(), caller);
      try {
        var confirmation =
            pending.action() == Action.SUBMIT
                ? ledger.submit(pending, caller, token)
                : ledger.executeRecovery(pending, caller, token);
        store.confirm(input.preparationId(), confirmation);
      } catch (LiquidityLedger.Rejected failure) {
        store.rejected(input.preparationId(), failure);
      } catch (RuntimeException failure) {
        store.uncertain(input.preparationId());
        LOG.warn(
            "Liquidity request {} command {} awaits confirmation: {}",
            pending.request().requestId(),
            pending.commandId(),
            failure.toString());
      }
    }
    return store.owned(pending.request().requestId(), caller);
  }

  @Scheduled(fixedDelay = 3000)
  public void reconcile() {
    for (var pending : store.unresolved()) {
      try {
        ledger.recover(pending).ifPresent(c -> store.confirm(pending.preparationId(), c));
      } catch (LiquidityLedger.Rejected failure) {
        store.rejected(pending.preparationId(), failure);
      } catch (RuntimeException failure) {
        LOG.warn(
            "Liquidity request {} reconciliation failed: {}",
            pending.request().requestId(),
            failure.toString());
      }
    }
    for (var pending : store.tracked()) {
      try {
        ledger
            .observe(pending)
            .ifPresent(
                c -> {
                  if (c.status() != Status.SETTLED && c.status() != Status.RECOVERED)
                    throw new IllegalStateException("Non-terminal liquidity completion evidence");
                  store.confirm(pending.preparationId(), c);
                });
      } catch (RuntimeException failure) {
        LOG.warn(
            "Liquidity request {} observation failed: {}",
            pending.request().requestId(),
            failure.toString());
      }
    }
  }

  static BigDecimal decimal(String value, boolean allowZero) {
    if (value == null || !value.matches("(?:0|[1-9][0-9]{0,27})(?:\\.[0-9]{1,10})?"))
      throw new IllegalArgumentException("Invalid amount");
    var amount = new BigDecimal(value);
    if (amount.signum() < (allowZero ? 0 : 1))
      throw new IllegalArgumentException("Amount must be positive");
    return amount;
  }

  private static void minimum(String value, String expected) {
    if (decimal(value, true).compareTo(decimal(expected, false)) > 0)
      throw new IllegalArgumentException("Minimum output exceeds quoted output");
  }

  private static String canonical(String value) {
    return new BigDecimal(value).stripTrailingZeros().toPlainString();
  }

  private static boolean equalAmount(String left, String right) {
    return decimal(left, false).compareTo(decimal(right, false)) == 0;
  }

  private static void slippage(int bps) {
    if (bps < 0 || bps > 5000) throw new IllegalArgumentException("Invalid slippage");
  }

  private static void deadline(Instant approved, Instant quoted) {
    if (approved.getNano() % 1000 != 0)
      throw new IllegalArgumentException("Deadline must use microsecond precision");
    if (approved.isAfter(quoted))
      throw new IllegalArgumentException("Deadline exceeds quote's supported window");
  }

  private static void sameTerms(Terms stored, Terms requested) {
    if (!stored.equals(requested))
      throw new LiquidityFailure(
          "IDEMPOTENCY_CONFLICT", "This quote was already prepared with different terms");
  }

  private static Request requireKind(Request request, Kind kind) {
    if (request.kind() != kind) throw new NoSuchElementException();
    return request;
  }

  private void validateSigning(SigningPayload signing, String party) {
    if (!party.equals(signing.partyId())
        || signing.preparedTransaction() == null
        || signing.preparedTransaction().isBlank()
        || signing.publicKeyFingerprint() == null
        || signing.publicKeyFingerprint().isBlank()
        || Base64.getDecoder().decode(signing.preparedTransactionHash()).length != 32
        || !signing.expiresAt().isAfter(clock.instant()))
      throw new IllegalStateException("Invalid prepared transaction");
  }

  static Preparation preparation(Pending pending) {
    var signing = pending.signing();
    return new Preparation(
        pending.preparationId(),
        pending.request().requestId(),
        pending.action(),
        pending.request().terms(),
        signing.preparedTransactionHash(),
        "base64",
        signing.hashingSchemeVersion(),
        signing.partyId(),
        signing.publicKeyFingerprint(),
        signing.expiresAt(),
        signing.recoveryEffects());
  }
}
