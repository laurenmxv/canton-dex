package com.openzeppelin.dex.swaps;

import static com.openzeppelin.dex.swaps.SwapModels.*;

import com.openzeppelin.dex.iam.Account;
import java.math.BigDecimal;
import java.time.*;
import java.util.*;
import org.slf4j.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public final class SwapWorkflow {
  private static final Logger LOG = LoggerFactory.getLogger(SwapWorkflow.class);
  private final SwapStore store;
  private final SwapLedger ledger;
  private final Clock clock;

  @Autowired
  public SwapWorkflow(SwapStore store, SwapLedger ledger) {
    this(store, ledger, Clock.systemUTC());
  }

  SwapWorkflow(SwapStore store, SwapLedger ledger, Clock clock) {
    this.store = store;
    this.ledger = ledger;
    this.clock = clock;
  }

  public Quote quote(Account caller, String accessToken, QuoteInput input) {
    caller.requireRole(Account.Role.TRADER);
    decimal(input.amountIn(), false);
    if (input.slippageBps() < 0 || input.slippageBps() > 5000)
      throw new IllegalArgumentException("Invalid slippage");
    UUID id = UUID.randomUUID();
    var quote = ledger.quote(id, caller, accessToken, input);
    if (!id.equals(quote.quoteId())
        || !input.poolId().equals(quote.poolId())
        || input.direction() != quote.direction()
        || decimal(input.amountIn(), false).compareTo(decimal(quote.amountIn(), false)) != 0)
      throw new IllegalStateException("Quote differs from requested terms");
    decimal(quote.expectedOut(), false);
    decimal(quote.minOut(), true);
    informationalFee(quote.feeAmount(), quote.amountIn());
    store.saveQuote(quote, caller);
    return quote;
  }

  public Preparation prepare(Account caller, String accessToken, PrepareInput input) {
    caller.requireRole(Account.Role.TRADER);
    var quote = store.quote(input.quoteId(), caller);
    var terms = terms(quote, input);
    var existing = store.preparedQuote(input.quoteId(), caller);
    if (existing.isPresent()) {
      sameTerms(existing.get().swap(), terms);
      if (!existing.get().signing().expiresAt().isAfter(clock.instant()))
        throw SwapFailure.conflict(
            "PREPARATION_EXPIRED",
            "The signing window has elapsed. Check the existing request before requesting a new quote");
      return preparation(existing.get());
    }
    Instant now = clock.instant();
    if (!quote.quoteExpiresAt().isAfter(now))
      throw SwapFailure.conflict("QUOTE_EXPIRED", "Request a new quote");
    if (!terms.settlementDeadline().isAfter(now))
      throw SwapFailure.conflict("DEADLINE_ELAPSED", "The settlement deadline has elapsed");
    UUID swapId = UUID.randomUUID(), preparationId = UUID.randomUUID();
    var signing = ledger.prepare(swapId, swapId, caller, accessToken, terms);
    validateSigning(signing, terms.trader(), now);
    var stored =
        store.savePreparation(
            swapId, preparationId, swapId, input.quoteId(), caller, terms, signing);
    sameTerms(stored.swap(), terms);
    return preparation(stored);
  }

  public Swap submit(Account caller, String accessToken, SubmitInput input) {
    caller.requireRole(Account.Role.TRADER);
    var pending = store.pendingOwned(input.preparationId(), caller);
    if (pending.action() != Action.SUBMIT)
      throw SwapFailure.conflict("PREPARATION_MISMATCH", "This preparation is for a withdrawal");
    return execute(caller, accessToken, input, pending);
  }

  public Swap get(UUID id, Account caller) {
    caller.requireRole(Account.Role.TRADER);
    return store.owned(id, caller);
  }

  public Activity activity(Account caller, int limit, String cursor, String status) {
    caller.requireRole(Account.Role.TRADER);
    return store.activity(caller, limit, cursor, status);
  }

  public Preparation prepareWithdrawal(UUID swapId, Account caller, String accessToken) {
    caller.requireRole(Account.Role.TRADER);
    var swap = store.owned(swapId, caller);
    var old = store.latestWithdrawal(swapId, caller);
    if (old.isPresent()
        && (old.get().signature() != null
            || old.get().signing().expiresAt().isAfter(clock.instant())))
      return preparation(old.get());
    if (swap.settlementDeadline().isAfter(clock.instant()))
      throw SwapFailure.conflict(
          "DEADLINE_NOT_ELAPSED", "Withdrawal is available after the settlement deadline");
    if (!swap.canWithdraw())
      throw SwapFailure.conflict(
          "WITHDRAWAL_UNAVAILABLE", "No confirmed unsettled allocations are available to withdraw");
    UUID command = UUID.randomUUID(), preparationId = UUID.randomUUID();
    var signing = ledger.prepareWithdrawal(command, swap, caller, accessToken);
    validateSigning(signing, swap.trader(), clock.instant());
    return preparation(
        store.saveWithdrawal(swapId, preparationId, command, caller, signing, clock.instant()));
  }

  public Swap withdraw(UUID swapId, Account caller, String accessToken, SubmitInput input) {
    caller.requireRole(Account.Role.TRADER);
    var pending = store.pendingOwned(input.preparationId(), caller);
    if (pending.action() != Action.WITHDRAW || !pending.swap().swapId().equals(swapId))
      throw SwapFailure.conflict(
          "PREPARATION_MISMATCH", "This preparation does not withdraw the selected swap");
    return execute(caller, accessToken, input, pending);
  }

  private Swap execute(Account caller, String token, SubmitInput input, Pending pending) {
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
        throw SwapFailure.conflict(
            "IDEMPOTENCY_CONFLICT", "This preparation already has a different signature");
      return store.owned(pending.swap().swapId(), caller);
    }
    ledger.verify(pending.signing(), input.signature(), caller);
    // Persist one dispatch decision before calling Canton. Unknown outcomes are read/reconciled
    // only.
    if (store.begin(
        input.preparationId(), caller, input.signature(), ledger.offset(), clock.instant())) {
      pending = store.pendingOwned(input.preparationId(), caller);
      try {
        var result =
            pending.action() == Action.SUBMIT
                ? ledger.submit(pending, caller, token)
                : ledger.withdraw(pending, caller, token);
        store.confirm(input.preparationId(), result);
      } catch (LedgerRejected e) {
        store.rejected(input.preparationId(), e);
      } catch (RuntimeException e) {
        store.uncertain(input.preparationId());
        LOG.warn(
            "Swap {} command {} awaits ledger confirmation: {}",
            pending.swap().swapId(),
            pending.commandId(),
            e.toString());
      }
    }
    return store.owned(pending.swap().swapId(), caller);
  }

  @Scheduled(fixedDelay = 3000)
  public void reconcile() {
    for (var pending : store.unresolved()) {
      try {
        ledger.recover(pending).ifPresent(c -> store.confirm(pending.preparationId(), c));
      } catch (LedgerRejected e) {
        store.rejected(pending.preparationId(), e);
      } catch (RuntimeException e) {
        LOG.warn("Swap {} reconciliation failed: {}", pending.swap().swapId(), e.toString());
      }
    }
    for (var pending : store.tracked()) {
      try {
        ledger
            .observe(pending)
            .ifPresent(
                c -> {
                  if (c.status() != Status.SETTLED && c.status() != Status.WITHDRAWN)
                    throw new IllegalStateException("Non-terminal completion observation");
                  store.confirm(pending.preparationId(), c);
                });
      } catch (RuntimeException e) {
        LOG.warn(
            "Swap {} completion observation failed: {}", pending.swap().swapId(), e.toString());
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

  static Terms terms(Quote quote, PrepareInput input) {
    if (input.settlementDeadline().getNano() % 1_000 != 0)
      throw new IllegalArgumentException("Settlement deadline must use microsecond precision");
    var min = decimal(input.minOut(), true);
    if (min.compareTo(decimal(quote.expectedOut(), false)) > 0)
      throw new IllegalArgumentException("Minimum output exceeds quoted output");
    if (input.settlementDeadline().isAfter(quote.settlementDeadline()))
      throw new IllegalArgumentException("Deadline exceeds quote's supported window");
    return new Terms(
        quote.poolId(),
        quote.poolName(),
        quote.trader(),
        quote.direction(),
        quote.inputInstrument(),
        quote.outputInstrument(),
        quote.amountIn(),
        quote.expectedOut(),
        quote.feeAmount(),
        min.stripTrailingZeros().toPlainString(),
        input.settlementDeadline());
  }

  // The informational fee can be smaller than a token quantum; it is not a separate transfer.
  static void informationalFee(String value, String amountIn) {
    if (value == null || !value.matches("(?:0|[1-9][0-9]{0,27})(?:\\.[0-9]{1,14})?"))
      throw new IllegalArgumentException("Invalid informational fee");
    if (new BigDecimal(value).compareTo(decimal(amountIn, false)) > 0)
      throw new IllegalArgumentException("Fee exceeds input");
  }

  static void sameTerms(Swap swap, Terms terms) {
    if (decimal(swap.minOut(), true).compareTo(decimal(terms.minOut(), true)) != 0
        || !swap.settlementDeadline().equals(terms.settlementDeadline()))
      throw SwapFailure.conflict(
          "IDEMPOTENCY_CONFLICT", "This quote was already prepared with different approved terms");
  }

  private static void validateSigning(SigningPayload signing, String party, Instant now) {
    if (!party.equals(signing.partyId())
        || signing.preparedTransaction() == null
        || signing.preparedTransaction().isBlank()
        || signing.publicKeyFingerprint() == null
        || signing.publicKeyFingerprint().isBlank()
        || Base64.getDecoder().decode(signing.preparedTransactionHash()).length != 32
        || !signing.expiresAt().isAfter(now))
      throw new IllegalStateException("Invalid prepared transaction");
  }

  static Preparation preparation(Pending pending) {
    var s = pending.swap();
    var signing = pending.signing();
    var terms =
        new Terms(
            s.poolId(),
            s.poolName(),
            s.trader(),
            s.direction(),
            s.inputInstrument(),
            s.outputInstrument(),
            s.amountIn(),
            s.expectedOut(),
            s.feeAmount(),
            s.minOut(),
            s.settlementDeadline());
    return new Preparation(
        pending.preparationId(),
        s.swapId(),
        pending.action(),
        terms,
        signing.preparedTransactionHash(),
        "base64",
        signing.hashingSchemeVersion(),
        signing.partyId(),
        signing.publicKeyFingerprint(),
        signing.expiresAt());
  }
}
