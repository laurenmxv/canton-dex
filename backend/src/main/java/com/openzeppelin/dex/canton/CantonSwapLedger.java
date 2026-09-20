package com.openzeppelin.dex.canton;

import static com.openzeppelin.dex.swaps.SwapModels.*;

import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.daml.ledger.api.v2.EventOuterClass;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.Value;
import com.openzeppelin.dex.canton.generated.lib.swap.*;
import com.openzeppelin.dex.canton.generated.pool.Pool;
import com.openzeppelin.dex.canton.generated.pool.SwapReceipt;
import com.openzeppelin.dex.canton.generated.poolaccess.PoolAccess;
import com.openzeppelin.dex.canton.generated.poolaccess.PoolAccess_RequestSwap;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.Allocation;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.AllocationView;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.TransferSide;
import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.onboarding.Onboarding;
import com.openzeppelin.dex.pools.PoolModels.Instrument;
import com.openzeppelin.dex.swaps.*;
import com.openzeppelin.dex.tokens.TokenStore;
import io.grpc.StatusRuntimeException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import org.springframework.stereotype.Component;

@Component
final class CantonSwapLedger implements SwapLedger {
  private final LedgerConnection ledger;
  private final CantonSwapPools pools;
  private final TokenStore tokens;
  private final InteractiveTransactions interactive;
  private final CantonTokenRegistry registries;

  CantonSwapLedger(
      LedgerConnection ledger,
      CantonSwapPools pools,
      TokenStore tokens,
      InteractiveTransactions interactive,
      CantonTokenRegistry registries) {
    this.ledger = ledger;
    this.pools = pools;
    this.tokens = tokens;
    this.interactive = interactive;
    this.registries = registries;
  }

  @Override
  public long offset() {
    return ledger.ledgerEnd();
  }

  @Override
  public void verify(SigningPayload signing, String signature, Account caller) {
    interactive.verify(prepared(signing), signature, signer(caller));
  }

  @Override
  public Quote quote(UUID quoteId, Account caller, String accessToken, QuoteInput input) {
    var signer = signer(caller);
    var pool = pools.read(input.poolId());
    pool.requireReady();
    pools.access(signer.partyId(), pool);
    boolean baseIn = input.direction() == Direction.BaseToQuote;
    var in = baseIn ? pool.funding().baseToken : pool.funding().quoteToken;
    var out = baseIn ? pool.funding().quoteToken : pool.funding().baseToken;
    var amount = SwapMath.amount(input.amountIn(), Math.toIntExact(in.decimals), false);
    pools.inputs(signer.partyId(), in.instrument, amount, pool.offset(), accessToken);
    var expected =
        SwapMath.output(
            baseIn ? pool.state().baseReserve : pool.state().quoteReserve,
            baseIn ? pool.state().quoteReserve : pool.state().baseReserve,
            amount,
            pool.config().feeBps,
            Math.toIntExact(out.decimals));
    if (expected.signum() <= 0)
      throw SwapFailure.conflict(
          "AMOUNT_TOO_SMALL", "Input produces no output at this token precision");
    var min =
        expected
            .multiply(BigDecimal.valueOf(10000L - input.slippageBps()))
            .divide(new BigDecimal("10000"), Math.toIntExact(out.decimals), RoundingMode.FLOOR);
    Instant now = Instant.now();
    return new Quote(
        quoteId,
        input.poolId(),
        pool.name(),
        signer.partyId(),
        input.direction(),
        new Instrument(in.instrument.admin, in.instrument.id),
        new Instrument(out.instrument.admin, out.instrument.id),
        SwapMath.text(amount),
        SwapMath.text(expected),
        SwapMath.text(amount.multiply(pool.config().feeBps).movePointLeft(4)),
        SwapMath.text(min),
        input.slippageBps(),
        pool.stateEvent().getContractId(),
        now.plusSeconds(30),
        now.plusSeconds(600).truncatedTo(ChronoUnit.SECONDS));
  }

  @Override
  public SigningPayload prepare(
      UUID swapId, UUID commandId, Account caller, String accessToken, Terms terms) {
    var signer = signer(caller);
    if (!signer.partyId().equals(terms.trader()))
      throw new IllegalArgumentException("Trader differs from the registered wallet");
    var pool = pools.read(terms.poolId());
    pool.requireReady();
    var access = pools.access(signer.partyId(), pool);
    Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
    if (terms.settlementDeadline().isBefore(now.plusSeconds(30))
        || terms.settlementDeadline().isAfter(now.plusSeconds(1800)))
      throw new IllegalArgumentException(
          "Settlement deadline must be between thirty seconds and thirty minutes away");
    boolean baseIn = terms.direction() == Direction.BaseToQuote;
    var in = baseIn ? pool.funding().baseToken : pool.funding().quoteToken;
    var out = baseIn ? pool.funding().quoteToken : pool.funding().baseToken;
    var amount = SwapMath.amount(terms.amountIn(), Math.toIntExact(in.decimals), false);
    var minimum = SwapMath.amount(terms.minOut(), Math.toIntExact(out.decimals), true);
    var inputs = pools.inputs(signer.partyId(), in.instrument, amount, pool.offset(), accessToken);
    var requested =
        new SwapTerms(
            swapId.toString(),
            baseIn ? SwapDirection.BASETOQUOTE : SwapDirection.QUOTETOBASE,
            amount,
            minimum,
            terms.settlementDeadline());
    var input =
        CantonSwapPools.requireFactory(
            in.allocationFactory.contractId, registries.inlineAllocation(in.instrument.admin));
    var output =
        CantonSwapPools.requireFactory(
            out.allocationFactory.contractId, registries.inlineAllocation(out.instrument.admin));
    var disclosures = new ArrayList<DisclosedContract>();
    disclosures.addAll(input.disclosures());
    disclosures.addAll(output.disclosures());
    disclosures.addAll(
        CantonSwapPools.requireFactory(
                in.settlementFactory.contractId, registries.inlineSettlement(in.instrument.admin))
            .disclosures());
    disclosures.addAll(
        CantonSwapPools.requireFactory(
                out.settlementFactory.contractId, registries.inlineSettlement(out.instrument.admin))
            .disclosures());
    try {
      return signing(
          interactive.prepare(
              commandId.toString(),
              caller.subject(),
              accessToken,
              signer,
              new PoolAccess.ContractId(access.getContractId())
                  .exercisePoolAccess_RequestSwap(
                      pool.route(), requested, now, inputs, input.extraArgs(), output.extraArgs()),
              CantonSwapPools.mergeDisclosures(disclosures),
              now.plusSeconds(45)));
    } catch (StatusRuntimeException failure) {
      throw prepareFailure(failure);
    }
  }

  @Override
  public Confirmation submit(Pending pending, Account caller, String accessToken) {
    return execute(pending, caller, accessToken);
  }

  @Override
  public SigningPayload prepareWithdrawal(
      UUID commandId, Swap swap, Account caller, String accessToken) {
    var signer = signer(caller);
    if (!signer.partyId().equals(swap.trader()))
      throw new IllegalArgumentException("Trader differs from the registered wallet");
    if (swap.allocationCids().isEmpty() || !Instant.now().isAfter(swap.settlementDeadline()))
      throw SwapFailure.conflict(
          "WITHDRAWAL_NOT_AVAILABLE", "Withdrawals are available after the settlement deadline");
    long offset = ledger.ledgerEnd();
    var pool = pools.pool(swap.poolId(), offset);
    var remaining =
        ledger
            .activeInterfaceContracts(ledger.primaryParty(), Allocation.INTERFACE_ID, offset)
            .stream()
            .filter(e -> swap.allocationCids().contains(e.getContractId()))
            .toList();
    if (remaining.isEmpty())
      throw SwapFailure.conflict(
          "WITHDRAWAL_NOT_AVAILABLE", "No active allocations remain; refresh the swap status");
    var withdrawals = new ArrayList<AllocationWithdrawal>();
    var disclosures = new ArrayList<DisclosedContract>();
    for (var event : remaining) {
      var allocation =
          AllocationView.valueDecoder()
              .decode(InterfaceViews.view(event, Allocation.INTERFACE_ID_WITH_PACKAGE_ID));
      var context = registries.withdraw(allocation.allocation.admin, event.getContractId());
      withdrawals.add(
          new AllocationWithdrawal(
              new Allocation.ContractId(event.getContractId()), context.extraArgs()));
      disclosures.addAll(context.disclosures());
    }
    try {
      return signing(
          interactive.prepare(
              commandId.toString(),
              caller.subject(),
              accessToken,
              signer,
              new Pool.ContractId(pool.getContractId())
                  .exercisePool_WithdrawSwap(signer.partyId(), withdrawals),
              pools.poolDisclosure(pool, disclosures),
              Instant.now().plusSeconds(45)));
    } catch (StatusRuntimeException failure) {
      throw prepareFailure(failure);
    }
  }

  @Override
  public Confirmation withdraw(Pending pending, Account caller, String accessToken) {
    return execute(pending, caller, accessToken);
  }

  private Confirmation execute(Pending pending, Account caller, String accessToken) {
    Transaction tx;
    try {
      tx =
          interactive.execute(
              pending.commandId().toString(),
              prepared(pending.signing()),
              pending.signature(),
              signer(caller),
              accessToken,
              caller.subject());
    } catch (StatusRuntimeException e) {
      if (CantonPoolLedger.definitivelyRejected(e))
        throw new LedgerRejected("LEDGER_REJECTED", "Canton rejected the signed transaction");
      throw e;
    }
    var confirmed =
        pending.action() == Action.WITHDRAW
            ? withdrawalConfirmation(
                ledger.transactions(pending.beginOffset(), ledger.primaryParty()),
                pending.swap(),
                tx.getOffset())
            : confirmation(tx, pending);
    return confirmed.orElseThrow(
        () -> new IllegalStateException("Submitted transaction lacks expected swap evidence"));
  }

  @Override
  public Optional<Confirmation> recover(Pending pending) {
    var history = ledger.history(pending.beginOffset(), ledger.primaryParty());
    var confirmation =
        pending.action() == Action.WITHDRAW
            ? withdrawalConfirmation(history.transactions(), pending.swap(), history.endOffset())
            : history.transactions().stream()
                .map(tx -> confirmation(tx, pending))
                .flatMap(Optional::stream)
                .findFirst();
    if (confirmation.isPresent()) return confirmation;
    // Record times on the single configured synchronizer are ordered. Once the
    // complete visible history passes the signed maximum record time, this
    // prepared transaction can no longer commit later.
    if (history
        .recordTime()
        .filter(time -> time.isAfter(pending.signing().expiresAt()))
        .isPresent())
      throw new LedgerRejected(
          "PREPARATION_EXPIRED", "The signed transaction expired without committing");
    return Optional.empty();
  }

  @Override
  public Optional<Confirmation> observe(Pending pending) {
    var swap = pending.swap();
    var withdrawn = new HashSet<String>();
    Transaction lastWithdrawal = null;
    for (var tx : ledger.transactions(pending.beginOffset(), ledger.primaryParty())) {
      for (var event : tx.getEventsList()) {
        if (event.hasCreated()
            && CantonSwapPools.isAppTemplate(event.getCreated(), SwapReceipt.TEMPLATE_ID)) {
          var receipt =
              SwapReceipt.valueDecoder()
                  .decode(DamlRecord.fromProto(event.getCreated().getCreateArguments()));
          if (receipt.inputAllocation.contractId.equals(swap.allocationCids().get(0))
              && receipt.outputAllocation.contractId.equals(swap.allocationCids().get(1))
              && receipt.terms.requestId.equals(swap.swapId().toString())
              && receipt.trader.equals(swap.trader())
              && receipt.poolCid.contractId.equals(swap.poolId()))
            return Optional.of(
                result(
                    tx, Status.SETTLED, swap.allocationCids(), SwapMath.text(receipt.amountOut)));
        }
        if (event.hasExercised()) {
          var exercise = event.getExercised();
          if (isWithdrawal(exercise, swap)) {
            withdrawn.add(exercise.getContractId());
            lastWithdrawal = tx;
          }
        }
      }
    }
    if (lastWithdrawal != null
        && swap.allocationCids().size() == 2
        && withdrawn.containsAll(swap.allocationCids()))
      return Optional.of(result(lastWithdrawal, Status.WITHDRAWN, swap.allocationCids(), null));
    return Optional.empty();
  }

  static Optional<Confirmation> withdrawalConfirmation(
      List<Transaction> history, Swap swap, long throughOffset) {
    if (swap.allocationCids().size() != 2 || new HashSet<>(swap.allocationCids()).size() != 2)
      return Optional.empty();
    var withdrawn = new HashSet<String>();
    for (var transaction : history) {
      if (transaction.getOffset() > throughOffset) continue;
      for (var event : transaction.getEventsList()) {
        if (event.hasExercised() && isWithdrawal(event.getExercised(), swap))
          withdrawn.add(event.getExercised().getContractId());
      }
      if (withdrawn.containsAll(swap.allocationCids()))
        return Optional.of(result(transaction, Status.WITHDRAWN, swap.allocationCids(), null));
    }
    return Optional.empty();
  }

  static boolean isWithdrawal(EventOuterClass.ExercisedEvent exercise, Swap swap) {
    return swap.allocationCids().contains(exercise.getContractId())
        && exercise.getActingPartiesList().contains(swap.trader())
        && AllocationEvents.withdrawn(exercise);
  }

  private Optional<Confirmation> confirmation(Transaction tx, Pending pending) {
    var swap = pending.swap();
    for (var event : tx.getEventsList()) {
      if (!event.hasExercised()) continue;
      var exercise = event.getExercised();
      if (!exercise.getTemplateId().equals(PoolAccess.TEMPLATE_ID_WITH_PACKAGE_ID.toProto())
          || !exercise.getChoice().equals("PoolAccess_RequestSwap")
          || !exercise.getActingPartiesList().equals(List.of(swap.trader()))) continue;
      var arguments =
          PoolAccess_RequestSwap.valueDecoder()
              .decode(Value.fromProto(exercise.getChoiceArgument()));
      var request =
          SwapRequest.valueDecoder(Pool.valueDecoder())
              .decode(Value.fromProto(exercise.getExerciseResult()));
      if (!request.terms.requestId.equals(swap.swapId().toString())) continue;
      if (!request.trader.equals(swap.trader())
          || !request.poolCid.contractId.equals(swap.poolId())
          || !request.terms.equals(arguments.terms)
          || !arguments.route.poolCid.contractId.equals(swap.poolId())
          || !request.terms.direction.getConstructor().equals(swap.direction().name())
          || request.terms.amountIn.compareTo(new BigDecimal(swap.amountIn())) != 0
          || request.terms.minOut.compareTo(new BigDecimal(swap.minOut())) != 0
          || !request.terms.settlementDeadline.equals(swap.settlementDeadline())
          || request.inputAllocation.equals(request.outputAllocation))
        throw new IllegalStateException("Confirmed swap differs from the signed request");
      validateAllocation(tx, request, arguments.route, true);
      validateAllocation(tx, request, arguments.route, false);
      return Optional.of(
          result(
              tx,
              Status.READY,
              List.of(request.inputAllocation.contractId, request.outputAllocation.contractId),
              null));
    }
    return Optional.empty();
  }

  // Match Lib.Swap.settlementId: integer token units and epoch microseconds avoid decimal
  // formatting.
  static String settlementId(SwapTerms terms) {
    long deadlineMicros =
        Math.addExact(
            Math.multiplyExact(terms.settlementDeadline.getEpochSecond(), 1_000_000L),
            terms.settlementDeadline.getNano() / 1_000);
    return "swap:"
        + terms.requestId
        + ":"
        + terms.direction.getConstructor()
        + ":"
        + terms.amountIn.movePointRight(10).toBigIntegerExact()
        + ":"
        + terms.minOut.movePointRight(10).toBigIntegerExact()
        + ":"
        + deadlineMicros;
  }

  static SwapRequest<Pool> request(Swap swap) {
    if (swap.allocationCids().size() != 2)
      throw new IllegalStateException("A swap requires two confirmed allocations");
    return new SwapRequest<>(
        new Pool.ContractId(swap.poolId()),
        swap.trader(),
        new SwapTerms(
            swap.swapId().toString(),
            swap.direction() == Direction.BaseToQuote
                ? SwapDirection.BASETOQUOTE
                : SwapDirection.QUOTETOBASE,
            new BigDecimal(swap.amountIn()),
            new BigDecimal(swap.minOut()),
            swap.settlementDeadline()),
        new Allocation.ContractId(swap.allocationCids().get(0)),
        new Allocation.ContractId(swap.allocationCids().get(1)));
  }

  private static void validateAllocation(
      Transaction tx, SwapRequest<Pool> request, SwapRoute<Pool> route, boolean input) {
    String id = input ? request.inputAllocation.contractId : request.outputAllocation.contractId;
    var events =
        tx.getEventsList().stream()
            .filter(EventOuterClass.Event::hasCreated)
            .map(EventOuterClass.Event::getCreated)
            .filter(e -> e.getContractId().equals(id))
            .toList();
    if (events.size() != 1)
      throw new IllegalStateException("Transaction did not create both requested allocations");
    validateAllocation(events.getFirst(), request, route, input);
  }

  static void validateAllocation(
      EventOuterClass.CreatedEvent event,
      SwapRequest<Pool> request,
      SwapRoute<Pool> route,
      boolean input) {
    var allocation =
        AllocationView.valueDecoder()
            .decode(InterfaceViews.view(event, Allocation.INTERFACE_ID_WITH_PACKAGE_ID));
    boolean baseIn = request.terms.direction == SwapDirection.BASETOQUOTE;
    var token = input == baseIn ? route.baseToken : route.quoteToken;
    var poolAccount = input == baseIn ? route.baseAccount : route.quoteAccount;
    var spec = allocation.allocation;
    if (!allocation.settlement.executors.equals(List.of(route.dvo, route.venueOperator))
        || !allocation.settlement.id.equals(settlementId(request.terms))
        || !allocation
            .settlement
            .cid
            .map(cid -> cid.contractId)
            .equals(Optional.of(request.poolCid.contractId))
        || allocation.numIterations != 0
        || !spec.admin.equals(token.instrument.admin)
        || !spec.authorizer.owner.equals(Optional.of(request.trader))
        || spec.authorizer.provider.isPresent()
        || !spec.authorizer.id.isEmpty()
        || !spec.committed
        || !(input
            ? spec.nextIterationFunding.isEmpty()
            : spec.nextIterationFunding.map(Map::isEmpty).orElse(false))
        || spec.transferLegSides.size() != (input || request.terms.minOut.signum() > 0 ? 1 : 0)
        || !spec.settlementDeadline.equals(Optional.of(request.terms.settlementDeadline)))
      throw new IllegalStateException("Confirmed allocations differ from the signed request");
    if (spec.transferLegSides.isEmpty()) return;
    var leg = spec.transferLegSides.getFirst();
    if (!leg.transferLegId.equals(input ? "input" : "minimum-output")
        || leg.side != (input ? TransferSide.SENDERSIDE : TransferSide.RECEIVERSIDE)
        || !leg.otherside.equals(poolAccount)
        || !leg.instrumentId.equals(token.instrument.id)
        || leg.amount.compareTo(input ? request.terms.amountIn : request.terms.minOut) != 0)
      throw new IllegalStateException("Confirmed allocation legs differ from the signed request");
  }

  private Onboarding.PartyPreparation signer(Account caller) {
    return tokens.signer(caller).party();
  }

  private static SwapFailure prepareFailure(StatusRuntimeException failure) {
    return switch (failure.getStatus().getCode()) {
      case UNAVAILABLE, DEADLINE_EXCEEDED, CANCELLED, RESOURCE_EXHAUSTED ->
          SwapFailure.unavailable("The participant could not prepare this transaction; try again");
      case UNAUTHENTICATED ->
          new SwapFailure("SESSION_EXPIRED", "Sign in again before preparing the transaction", 401);
      case PERMISSION_DENIED ->
          new SwapFailure(
              "LEDGER_ACCESS_DENIED", "The current session cannot prepare this transaction", 403);
      default ->
          SwapFailure.conflict(
              "PREPARATION_REJECTED",
              "The ledger state changed or rejected these terms; refresh and prepare again");
    };
  }

  private static Confirmation result(
      Transaction tx, Status status, List<String> allocations, String amountOut) {
    return new Confirmation(
        status,
        allocations,
        amountOut,
        tx.getUpdateId(),
        tx.getOffset(),
        Instant.ofEpochSecond(tx.getEffectiveAt().getSeconds(), tx.getEffectiveAt().getNanos()));
  }

  private static SigningPayload signing(InteractiveTransactions.Prepared p) {
    return new SigningPayload(
        p.preparedTransaction(),
        p.preparedTransactionHash(),
        p.hashingSchemeVersion(),
        p.partyId(),
        p.publicKeyFingerprint(),
        p.expiresAt());
  }

  private static InteractiveTransactions.Prepared prepared(SigningPayload p) {
    return new InteractiveTransactions.Prepared(
        p.preparedTransaction(),
        p.preparedTransactionHash(),
        p.hashingSchemeVersion(),
        p.partyId(),
        p.publicKeyFingerprint(),
        p.expiresAt());
  }
}
