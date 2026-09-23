package com.openzeppelin.dex.canton;

import static com.openzeppelin.dex.canton.SwapMath.text;
import static com.openzeppelin.dex.liquidity.LiquidityModels.*;

import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.daml.ledger.api.v2.EventOuterClass;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.Value;
import com.daml.ledger.javaapi.data.codegen.Update;
import com.openzeppelin.dex.canton.generated.lib.liquidity.DepositMode;
import com.openzeppelin.dex.canton.generated.lib.liquidity.DepositRequest;
import com.openzeppelin.dex.canton.generated.lib.liquidity.LiquidityTokenArgs;
import com.openzeppelin.dex.canton.generated.lib.liquidity.WithdrawalRequest;
import com.openzeppelin.dex.canton.generated.lib.liquidity.liquidityoutcome.*;
import com.openzeppelin.dex.canton.generated.lib.swap.AllocationWithdrawal;
import com.openzeppelin.dex.canton.generated.lib.tokens.Token;
import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolaccess.*;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.*;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Holding;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.HoldingView;
import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.liquidity.LiquidityFailure;
import com.openzeppelin.dex.liquidity.LiquidityLedger;
import com.openzeppelin.dex.onboarding.Onboarding;
import com.openzeppelin.dex.pools.PoolStore;
import com.openzeppelin.dex.tokens.TokenStore;
import io.grpc.StatusRuntimeException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import org.springframework.stereotype.Component;

@Component
final class CantonLiquidityLedger implements LiquidityLedger {
  private final LedgerConnection ledger;
  private final CantonPools pools;
  private final PoolStore catalog;
  private final TokenStore tokens;
  private final InteractiveTransactions interactive;
  private final CantonTokenRegistry registries;

  CantonLiquidityLedger(
      LedgerConnection ledger,
      CantonPools pools,
      PoolStore catalog,
      TokenStore tokens,
      InteractiveTransactions interactive,
      CantonTokenRegistry registries) {
    this.ledger = ledger;
    this.pools = pools;
    this.catalog = catalog;
    this.tokens = tokens;
    this.interactive = interactive;
    this.registries = registries;
  }

  @Override
  public long offset() {
    return ledger.ledgerEnd();
  }

  @Override
  public void requireAccess(Account caller, String poolId) {
    var signer = signer(caller);
    long offset = ledger.ledgerEnd();
    pools.access(signer.partyId(), pools.pool(poolId, offset), offset);
  }

  @Override
  public void verify(SigningPayload signing, String signature, Account caller) {
    interactive.verify(prepared(signing), signature, signer(caller));
  }

  @Override
  public DepositQuote quoteDeposit(UUID id, Account caller, String token, DepositQuoteInput input) {
    var signer = signer(caller);
    var pool = pools.read(input.poolId());
    pool.requireLiquidityReady();
    pools.access(signer.partyId(), pool);
    var base = pool.pool().baseToken;
    var quote = pool.pool().quoteToken;
    var maxBase = SwapMath.amount(input.maxBaseAmount(), Math.toIntExact(base.decimals), false);
    var maxQuote = SwapMath.amount(input.maxQuoteAmount(), Math.toIntExact(quote.decimals), false);
    pools.inputs(signer.partyId(), base.instrument, maxBase, pool.offset(), token);
    pools.inputs(signer.partyId(), quote.instrument, maxQuote, pool.offset(), token);
    var amounts = depositAmounts(pool, maxBase, maxQuote);
    boolean initial = pool.state().lpTokenSupply.signum() == 0;
    var numerator = initial ? pool.config().initialRatio : pool.state().quoteReserve;
    var denominator =
        (initial ? BigDecimal.ONE : pool.state().baseReserve).multiply(new BigDecimal("10000"));
    var lower =
        numerator
            .multiply(BigDecimal.valueOf(10000L - input.slippageBps()))
            .divide(denominator, 10, RoundingMode.FLOOR);
    var upper =
        numerator
            .multiply(BigDecimal.valueOf(10000L + input.slippageBps()))
            .divide(denominator, 10, RoundingMode.CEILING);
    if (lower.signum() == 0) lower = new BigDecimal("0.0000000001");
    Instant now = Instant.now();
    return new DepositQuote(
        id,
        input.poolId(),
        pool.name(),
        signer.partyId(),
        PoolEncoding.instrument(base.instrument),
        PoolEncoding.instrument(quote.instrument),
        PoolEncoding.instrument(pool.pool().lpToken.instrument),
        initial ? Mode.INITIAL : Mode.PROPORTIONAL,
        text(maxBase),
        text(maxQuote),
        text(amounts.base()),
        text(amounts.quote()),
        text(amounts.baseRefund()),
        text(amounts.quoteRefund()),
        text(amounts.lp()),
        text(LiquidityMath.minimum(amounts.lp(), input.slippageBps(), 10)),
        text(lower),
        text(upper),
        initial ? text(LiquidityMath.MINIMUM) : null,
        input.slippageBps(),
        pool.stateEvent().getContractId(),
        now.plusSeconds(30),
        now.plusSeconds(600).truncatedTo(ChronoUnit.SECONDS));
  }

  @Override
  public WithdrawalQuote quoteWithdrawal(
      UUID id, Account caller, String token, WithdrawalQuoteInput input) {
    var signer = signer(caller);
    var pool = pools.read(input.poolId());
    pool.requireReady();
    pools.access(signer.partyId(), pool);
    var lp = SwapMath.amount(input.lpAmount(), 10, false);
    pools.inputs(signer.partyId(), pool.pool().lpToken.instrument, lp, pool.offset(), token);
    var amounts = withdrawalAmounts(pool, lp);
    Instant now = Instant.now();
    return new WithdrawalQuote(
        id,
        input.poolId(),
        pool.name(),
        signer.partyId(),
        PoolEncoding.instrument(pool.pool().baseToken.instrument),
        PoolEncoding.instrument(pool.pool().quoteToken.instrument),
        PoolEncoding.instrument(pool.pool().lpToken.instrument),
        text(lp),
        text(amounts.base()),
        text(amounts.quote()),
        text(
            LiquidityMath.minimum(
                amounts.base(),
                input.slippageBps(),
                Math.toIntExact(pool.pool().baseToken.decimals))),
        text(
            LiquidityMath.minimum(
                amounts.quote(),
                input.slippageBps(),
                Math.toIntExact(pool.pool().quoteToken.decimals))),
        input.slippageBps(),
        pool.stateEvent().getContractId(),
        now.plusSeconds(30),
        now.plusSeconds(600).truncatedTo(ChronoUnit.SECONDS));
  }

  @Override
  public SigningPayload prepare(
      UUID requestId, UUID commandId, Account caller, String token, Terms terms) {
    var signer = signer(caller);
    requireTrader(signer, terms);
    var pool = pools.read(terms.poolId());
    pool.requireLiquidityReady();
    requireInstruments(terms, pool.pool());
    var access = pools.access(signer.partyId(), pool);
    Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
    if (terms.settlementDeadline().isBefore(now.plusSeconds(30))
        || terms.settlementDeadline().isAfter(now.plusSeconds(1800)))
      throw new IllegalArgumentException(
          "Settlement deadline must be thirty seconds to thirty minutes away");
    var operations = operations(pool);
    var args = operations.args();
    Update<?> command;
    if (terms instanceof DepositTerms deposit) {
      validateDeposit(pool, deposit);
      var baseInputs =
          pools.inputs(
              signer.partyId(),
              pool.pool().baseToken.instrument,
              new BigDecimal(deposit.maxBaseAmount()),
              pool.offset(),
              token);
      var quoteInputs =
          pools.inputs(
              signer.partyId(),
              pool.pool().quoteToken.instrument,
              new BigDecimal(deposit.maxQuoteAmount()),
              pool.offset(),
              token);
      command =
          new PoolAccess.ContractId(access.getContractId())
              .exercisePoolAccess_RequestLiquidityDeposit(
                  depositTerms(requestId, deposit),
                  now,
                  baseInputs,
                  quoteInputs,
                  args.baseAllocationArgs,
                  args.quoteAllocationArgs,
                  args.lpAllocationArgs);
    } else {
      var withdrawal = (WithdrawalTerms) terms;
      validateWithdrawal(pool, withdrawal);
      var inputs =
          pools.inputs(
              signer.partyId(),
              pool.pool().lpToken.instrument,
              new BigDecimal(withdrawal.lpAmount()),
              pool.offset(),
              token);
      command =
          new PoolAccess.ContractId(access.getContractId())
              .exercisePoolAccess_RequestLiquidityWithdrawal(
                  withdrawalTerms(requestId, withdrawal),
                  now,
                  inputs,
                  args.baseAllocationArgs,
                  args.quoteAllocationArgs,
                  args.lpAllocationArgs);
    }
    try {
      return signing(
          interactive.prepare(
              commandId.toString(),
              caller.subject(),
              token,
              signer,
              command,
              pools.poolDisclosure(pool.poolEvent(), operations.disclosures()),
              now.plusSeconds(45)),
          List.of());
    } catch (StatusRuntimeException failure) {
      throw CantonSwapLedger.prepareFailure(failure);
    }
  }

  @Override
  public Confirmation submit(Pending pending, Account caller, String token) {
    return execute(pending, caller, token);
  }

  @Override
  public Confirmation executeRecovery(Pending pending, Account caller, String token) {
    return execute(pending, caller, token);
  }

  private Confirmation execute(Pending pending, Account caller, String token) {
    Transaction tx;
    try {
      tx =
          interactive.execute(
              pending.commandId().toString(),
              prepared(pending.signing()),
              pending.signature(),
              signer(caller),
              token,
              caller.subject());
    } catch (StatusRuntimeException failure) {
      if (CantonPoolLedger.definitivelyRejected(failure))
        throw new Rejected("LEDGER_REJECTED", "Canton rejected the signed liquidity transaction");
      throw failure;
    }
    return (pending.action() == Action.SUBMIT
            ? confirmation(tx, pending.request())
            : recoveryConfirmation(
                ledger.transactions(pending.beginOffset(), ledger.primaryParty()),
                pending.request()))
        .orElseThrow(
            () ->
                new IllegalStateException(
                    "Submitted transaction lacks expected liquidity evidence"));
  }

  @Override
  public Optional<Confirmation> recover(Pending pending) {
    var history = ledger.history(pending.beginOffset(), ledger.primaryParty());
    var found =
        pending.action() == Action.RECOVER
            ? recoveryConfirmation(history.transactions(), pending.request())
            : history.transactions().stream()
                .map(tx -> confirmation(tx, pending.request()))
                .flatMap(Optional::stream)
                .findFirst();
    if (found.isPresent()) return found;
    if (history
        .recordTime()
        .filter(time -> time.isAfter(pending.signing().expiresAt()))
        .isPresent())
      throw new Rejected(
          "PREPARATION_EXPIRED", "The signed transaction expired without committing");
    return Optional.empty();
  }

  @Override
  public Optional<Confirmation> observe(Pending pending) {
    var history = ledger.transactions(pending.beginOffset(), ledger.primaryParty());
    for (var tx : history) {
      var result = settlementResult(tx, pending.request());
      if (result.isPresent())
        return Optional.of(
            confirmed(tx, Status.SETTLED, pending.request().allocationCids(), result.get()));
    }
    return recoveryConfirmation(history, pending.request());
  }

  @Override
  public SigningPayload prepareRecovery(
      UUID commandId, Request request, Account caller, String token) {
    var signer = signer(caller);
    requireTrader(signer, request.terms());
    if (request.allocationCids().size() != 3
        || !Instant.now().isAfter(request.terms().settlementDeadline()))
      throw new LiquidityFailure(
          "RECOVERY_NOT_AVAILABLE", "Recovery is available after the settlement deadline");
    long offset = ledger.ledgerEnd();
    var pool = pools.pool(request.terms().poolId(), offset);
    var access = pools.access(signer.partyId(), pool, offset);
    var remaining =
        ledger
            .activeInterfaceContracts(ledger.primaryParty(), Allocation.INTERFACE_ID, offset)
            .stream()
            .filter(event -> request.allocationCids().contains(event.getContractId()))
            .toList();
    if (remaining.isEmpty())
      throw new LiquidityFailure(
          "RECOVERY_NOT_AVAILABLE", "No active allocations remain; refresh the request");
    var withdrawals = new ArrayList<AllocationWithdrawal>();
    var disclosures = new ArrayList<DisclosedContract>();
    var effects = new ArrayList<RecoveryEffect>();
    var poolValue = Pool.valueDecoder().decode(DamlRecord.fromProto(pool.getCreateArguments()));
    for (var event : remaining) {
      int index = request.allocationCids().indexOf(event.getContractId());
      validateAllocation(event, request, poolValue, index);
      var allocation =
          AllocationView.valueDecoder()
              .decode(InterfaceViews.view(event, Allocation.INTERFACE_ID_WITH_PACKAGE_ID));
      var context = registries.withdraw(allocation.allocation.admin, event.getContractId());
      withdrawals.add(
          new AllocationWithdrawal(
              new Allocation.ContractId(event.getContractId()), context.extraArgs()));
      disclosures.addAll(context.disclosures());
      boolean funds = request.kind() == Kind.DEPOSIT ? index < 2 : index == 2;
      String amount = "0";
      if (funds)
        amount =
            request.terms() instanceof DepositTerms deposit
                ? index == 0 ? deposit.maxBaseAmount() : deposit.maxQuoteAmount()
                : ((WithdrawalTerms) request.terms()).lpAmount();
      effects.add(
          new RecoveryEffect(
              event.getContractId(),
              PoolEncoding.instrument(token(poolValue, index).instrument),
              amount,
              funds ? RecoveryKind.RETURN_FUNDS : RecoveryKind.RELEASE_PERMISSION));
    }
    try {
      return signing(
          interactive.prepare(
              commandId.toString(),
              caller.subject(),
              token,
              signer,
              new PoolAccess.ContractId(access.getContractId())
                  .exercisePoolAccess_RecoverAllocations(withdrawals),
              pools.poolDisclosure(pool, disclosures),
              Instant.now().plusSeconds(45)),
          effects);
    } catch (StatusRuntimeException failure) {
      throw CantonSwapLedger.prepareFailure(failure);
    }
  }

  @Override
  public Positions positions(Account caller, String token) {
    var trader = signer(caller).partyId();
    long offset = ledger.ledgerEnd();
    var holdings =
        ledger.activeInterfaceContracts(trader, Holding.INTERFACE_ID, offset, token).stream()
            .map(
                event ->
                    HoldingView.valueDecoder()
                        .decode(InterfaceViews.view(event, Holding.INTERFACE_ID_WITH_PACKAGE_ID)))
            .filter(holding -> holding.account.equals(basicAccount(trader)))
            .toList();
    var positions = new ArrayList<Position>();
    for (var detail : catalog.pools(Pool.PACKAGE_ID)) {
      var pool = pools.read(detail.poolId(), offset);
      BigDecimal available = BigDecimal.ZERO, allocated = BigDecimal.ZERO;
      for (var holding : holdings) {
        if (!holding.instrumentId.equals(pool.pool().lpToken.instrument)) continue;
        if (holding.lock.isPresent()) allocated = allocated.add(holding.amount);
        else available = available.add(holding.amount);
      }
      var total = available.add(allocated);
      if (total.signum() == 0) continue;
      var supply = pool.state().lpTokenSupply;
      if (supply.signum() <= 0) throw new IllegalStateException("LP holdings exist without supply");
      positions.add(
          new Position(
              detail.poolId(),
              detail.name(),
              PoolEncoding.instrument(pool.pool().baseToken.instrument),
              PoolEncoding.instrument(pool.pool().quoteToken.instrument),
              PoolEncoding.instrument(pool.pool().lpToken.instrument),
              text(available),
              text(allocated),
              text(total),
              text(supply),
              text(total.divide(supply, 10, RoundingMode.FLOOR)),
              text(
                  total
                      .multiply(pool.state().baseReserve)
                      .divide(
                          supply,
                          Math.toIntExact(pool.pool().baseToken.decimals),
                          RoundingMode.FLOOR)),
              text(
                  total
                      .multiply(pool.state().quoteReserve)
                      .divide(
                          supply,
                          Math.toIntExact(pool.pool().quoteToken.decimals),
                          RoundingMode.FLOOR))));
    }
    return new Positions(positions, offset);
  }

  private Optional<Confirmation> confirmation(Transaction tx, Request expected) {
    for (var event : tx.getEventsList()) {
      if (!event.hasExercised()) continue;
      var exercise = event.getExercised();
      if (!exercise.getActingPartiesList().equals(List.of(expected.terms().trader()))) continue;
      List<String> cids;
      if (expected.terms() instanceof DepositTerms
          && exercise.getTemplateId().equals(PoolAccess.TEMPLATE_ID_WITH_PACKAGE_ID.toProto())
          && exercise.getChoice().equals("PoolAccess_RequestLiquidityDeposit")) {
        var request =
            DepositRequest.valueDecoder(Pool.valueDecoder())
                .decode(Value.fromProto(exercise.getExerciseResult()));
        if (!request.terms.requestId.equals(expected.requestId().toString())) continue;
        var args =
            PoolAccess_RequestLiquidityDeposit.valueDecoder()
                .decode(Value.fromProto(exercise.getChoiceArgument()));
        if (!matchesDeposit(request, expected) || !request.terms.equals(args.terms))
          throw new IllegalStateException("Confirmed deposit differs from the signed request");
        cids =
            List.of(
                request.baseAllocation.contractId,
                request.quoteAllocation.contractId,
                request.lpAllocation.contractId);
      } else if (expected.terms() instanceof WithdrawalTerms
          && exercise.getTemplateId().equals(PoolAccess.TEMPLATE_ID_WITH_PACKAGE_ID.toProto())
          && exercise.getChoice().equals("PoolAccess_RequestLiquidityWithdrawal")) {
        var request =
            WithdrawalRequest.valueDecoder(Pool.valueDecoder())
                .decode(Value.fromProto(exercise.getExerciseResult()));
        if (!request.terms.requestId.equals(expected.requestId().toString())) continue;
        var args =
            PoolAccess_RequestLiquidityWithdrawal.valueDecoder()
                .decode(Value.fromProto(exercise.getChoiceArgument()));
        if (!matchesWithdrawal(request, expected) || !request.terms.equals(args.terms))
          throw new IllegalStateException("Confirmed withdrawal differs from the signed request");
        cids =
            List.of(
                request.baseAllocation.contractId,
                request.quoteAllocation.contractId,
                request.lpAllocation.contractId);
      } else continue;
      if (new HashSet<>(cids).size() != 3)
        throw new IllegalStateException("Liquidity requires three distinct allocations");
      var poolEvent = pools.pool(expected.terms().poolId(), tx.getOffset());
      var pool = Pool.valueDecoder().decode(DamlRecord.fromProto(poolEvent.getCreateArguments()));
      for (int index = 0; index < 3; index++) {
        String cid = cids.get(index);
        var allocation =
            tx.getEventsList().stream()
                .filter(EventOuterClass.Event::hasCreated)
                .map(EventOuterClass.Event::getCreated)
                .filter(created -> created.getContractId().equals(cid))
                .findFirst()
                .orElseThrow(
                    () -> new IllegalStateException("Transaction lacks a requested allocation"));
        validateAllocation(allocation, expected, pool, index);
      }
      return Optional.of(confirmed(tx, Status.READY, cids, null));
    }
    return Optional.empty();
  }

  static Optional<Confirmation> recoveryConfirmation(List<Transaction> history, Request request) {
    if (request.allocationCids().size() != 3 || new HashSet<>(request.allocationCids()).size() != 3)
      return Optional.empty();
    var withdrawn = new HashSet<String>();
    for (var tx : history) {
      for (var event : tx.getEventsList())
        if (event.hasExercised() && isRecovery(event.getExercised(), request))
          withdrawn.add(event.getExercised().getContractId());
      if (withdrawn.containsAll(request.allocationCids()))
        return Optional.of(confirmed(tx, Status.RECOVERED, request.allocationCids(), null));
    }
    return Optional.empty();
  }

  static boolean isRecovery(EventOuterClass.ExercisedEvent exercise, Request request) {
    return request.allocationCids().contains(exercise.getContractId())
        && exercise.getActingPartiesList().contains(request.terms().trader())
        && AllocationEvents.withdrawn(exercise);
  }

  static Optional<Result> settlementResult(Transaction tx, Request request) {
    requireAllocations(request);
    for (var event : tx.getEventsList()) {
      if (!event.hasExercised()) continue;
      var exercise = event.getExercised();
      if (!exercise.getTemplateId().equals(Pool.TEMPLATE_ID_WITH_PACKAGE_ID.toProto())
          || !exercise.getContractId().equals(request.terms().poolId())) continue;
      var receiptId = settlementReceipt(exercise, request);
      if (receiptId.isEmpty()) continue;
      var receiptEvent =
          tx.getEventsList().stream()
              .filter(EventOuterClass.Event::hasCreated)
              .map(EventOuterClass.Event::getCreated)
              .filter(
                  created ->
                      created.getContractId().equals(receiptId.get())
                          && CantonPools.isAppTemplate(created, LiquidityReceipt.TEMPLATE_ID))
              .findFirst()
              .orElseThrow(
                  () -> new IllegalStateException("Liquidity settlement receipt is missing"));
      var receipt =
          LiquidityReceipt.valueDecoder()
              .decode(DamlRecord.fromProto(receiptEvent.getCreateArguments()));
      return Optional.of(receiptResult(receipt, request));
    }
    return Optional.empty();
  }

  private static Optional<String> settlementReceipt(
      EventOuterClass.ExercisedEvent exercise, Request request) {
    if (request.terms() instanceof DepositTerms
        && exercise.getChoice().equals("Pool_AddLiquidity")) {
      var requests =
          Pool_AddLiquidity.valueDecoder()
              .decode(Value.fromProto(exercise.getChoiceArgument()))
              .requests;
      var result =
          AddLiquidityBatchResult.valueDecoder()
              .decode(Value.fromProto(exercise.getExerciseResult()));
      if (result.receiptCids.size() != requests.size())
        throw new IllegalStateException("Deposit batch receipt count differs");
      for (int index = 0; index < requests.size(); index++) {
        var settled = requests.get(index).request;
        if (matchesDeposit(settled, request)
            && request
                .allocationCids()
                .equals(
                    List.of(
                        settled.baseAllocation.contractId,
                        settled.quoteAllocation.contractId,
                        settled.lpAllocation.contractId)))
          return Optional.of(result.receiptCids.get(index).contractId);
      }
    } else if (request.terms() instanceof WithdrawalTerms
        && exercise.getChoice().equals("Pool_WithdrawLiquidity")) {
      var requests =
          Pool_WithdrawLiquidity.valueDecoder()
              .decode(Value.fromProto(exercise.getChoiceArgument()))
              .requests;
      var result =
          WithdrawLiquidityBatchResult.valueDecoder()
              .decode(Value.fromProto(exercise.getExerciseResult()));
      if (result.receiptCids.size() != requests.size())
        throw new IllegalStateException("Withdrawal batch receipt count differs");
      for (int index = 0; index < requests.size(); index++) {
        var settled = requests.get(index).request;
        if (matchesWithdrawal(settled, request)
            && request
                .allocationCids()
                .equals(
                    List.of(
                        settled.baseAllocation.contractId,
                        settled.quoteAllocation.contractId,
                        settled.lpAllocation.contractId)))
          return Optional.of(result.receiptCids.get(index).contractId);
      }
    }
    return Optional.empty();
  }

  private static Result receiptResult(LiquidityReceipt receipt, Request request) {
    if (!receipt.requestId.equals(request.requestId().toString())
        || !receipt.trader.equals(request.terms().trader())
        || !receipt.poolCid.contractId.equals(request.terms().poolId()))
      throw new IllegalStateException("Liquidity receipt differs from the settled request");
    if (request.terms() instanceof DepositTerms terms
        && receipt.outcome instanceof LiquidityDeposited deposited) {
      var outcome = deposited.depositOutcomeValue;
      if (outcome.lpAmount.compareTo(new BigDecimal(terms.minLpOut())) < 0
          || !sameAmount(outcome.baseAmount.add(outcome.baseRefund), terms.maxBaseAmount())
          || !sameAmount(outcome.quoteAmount.add(outcome.quoteRefund), terms.maxQuoteAmount()))
        throw new IllegalStateException("Deposit receipt violates signed terms");
      return new DepositResult(
          text(outcome.baseAmount),
          text(outcome.quoteAmount),
          text(outcome.baseRefund),
          text(outcome.quoteRefund),
          text(outcome.lpAmount));
    }
    if (request.terms() instanceof WithdrawalTerms terms
        && receipt.outcome instanceof LiquidityWithdrawn withdrawn) {
      var outcome = withdrawn.withdrawalOutcomeValue;
      if (!sameAmount(outcome.lpAmount, terms.lpAmount())
          || outcome.baseAmount.compareTo(new BigDecimal(terms.minBaseOut())) < 0
          || outcome.quoteAmount.compareTo(new BigDecimal(terms.minQuoteOut())) < 0)
        throw new IllegalStateException("Withdrawal receipt violates signed terms");
      return new WithdrawalResult(
          text(outcome.lpAmount), text(outcome.baseAmount), text(outcome.quoteAmount));
    }
    throw new IllegalStateException("Liquidity receipt kind differs from request");
  }

  private static boolean matchesDeposit(DepositRequest<Pool> actual, Request expected) {
    if (!(expected.terms() instanceof DepositTerms terms)) return false;
    var signed = actual.terms;
    return actual.poolCid.contractId.equals(terms.poolId())
        && actual.trader.equals(terms.trader())
        && signed.requestId.equals(expected.requestId().toString())
        && signed.mode
            == (terms.mode() == Mode.INITIAL
                ? DepositMode.INITIALIZEONLY
                : DepositMode.PROPORTIONAL)
        && sameAmount(signed.maxBaseAmount, terms.maxBaseAmount())
        && sameAmount(signed.maxQuoteAmount, terms.maxQuoteAmount())
        && sameAmount(signed.minLpOut, terms.minLpOut())
        && sameAmount(signed.minRatio, terms.minRatio())
        && sameAmount(signed.maxRatio, terms.maxRatio())
        && signed.settlementDeadline.equals(terms.settlementDeadline());
  }

  private static boolean matchesWithdrawal(WithdrawalRequest<Pool> actual, Request expected) {
    if (!(expected.terms() instanceof WithdrawalTerms terms)) return false;
    var signed = actual.terms;
    return actual.poolCid.contractId.equals(terms.poolId())
        && actual.trader.equals(terms.trader())
        && signed.requestId.equals(expected.requestId().toString())
        && sameAmount(signed.lpAmount, terms.lpAmount())
        && sameAmount(signed.minBaseOut, terms.minBaseOut())
        && sameAmount(signed.minQuoteOut, terms.minQuoteOut())
        && signed.settlementDeadline.equals(terms.settlementDeadline());
  }

  private static boolean sameAmount(BigDecimal actual, String expected) {
    return actual.compareTo(new BigDecimal(expected)) == 0;
  }

  static void validateAllocation(
      EventOuterClass.CreatedEvent event, Request request, Pool pool, int index) {
    var view =
        AllocationView.valueDecoder()
            .decode(InterfaceViews.view(event, Allocation.INTERFACE_ID_WITH_PACKAGE_ID));
    var spec = view.allocation;
    var token = token(pool, index);
    boolean deposit = request.terms() instanceof DepositTerms;
    boolean burn = !deposit && index == 2;
    BigDecimal amount;
    String minimumKey;
    if (request.terms() instanceof DepositTerms terms) {
      amount =
          new BigDecimal(
              index == 0
                  ? terms.maxBaseAmount()
                  : index == 1 ? terms.maxQuoteAmount() : terms.minLpOut());
      minimumKey = index == 2 ? AllocationMetadata.MIN_LP_OUT : null;
    } else {
      var terms = (WithdrawalTerms) request.terms();
      amount =
          new BigDecimal(
              index == 0
                  ? terms.minBaseOut()
                  : index == 1 ? terms.minQuoteOut() : terms.lpAmount());
      minimumKey =
          index == 0
              ? AllocationMetadata.MIN_BASE_OUT
              : index == 1 ? AllocationMetadata.MIN_QUOTE_OUT : null;
    }
    var metadata = minimumKey == null ? Map.<String, String>of() : Map.of(minimumKey, text(amount));
    var funding = spec.nextIterationFunding.orElse(null);
    boolean fundingMatches =
        burn
            ? funding == null
            : funding != null
                && (deposit && index < 2
                    ? funding.size() == 1
                        && funding.containsKey(token.instrument.id)
                        && funding.get(token.instrument.id).compareTo(amount) == 0
                    : funding.isEmpty());
    if (!view.settlement.executors.equals(List.of(pool.dvo, pool.venueOperator))
        || !view.settlement.id.equals(settlementId(request))
        || !view.settlement
            .cid
            .map(cid -> cid.contractId)
            .equals(Optional.of(request.terms().poolId()))
        || view.numIterations != 0
        || !spec.admin.equals(token.instrument.admin)
        || !spec.authorizer.equals(basicAccount(request.terms().trader()))
        || !spec.committed
        || !spec.settlementDeadline.equals(Optional.of(request.terms().settlementDeadline()))
        || !fundingMatches
        || !spec.meta.values.equals(metadata)
        || spec.transferLegSides.size() != (burn ? 1 : 0))
      throw new IllegalStateException("Liquidity allocation differs from the signed request");
    if (!burn) return;
    var side = spec.transferLegSides.getFirst();
    if (!side.transferLegId.equals("lp-burn")
        || side.side != TransferSide.SENDERSIDE
        || !side.otherside.equals(specialAccount("burn"))
        || !side.instrumentId.equals(token.instrument.id)
        || side.amount.compareTo(amount) != 0)
      throw new IllegalStateException("Liquidity allocation leg differs from the signed request");
  }

  static String settlementId(Request request) {
    var t = request.terms();
    long micros =
        Math.addExact(
            Math.multiplyExact(t.settlementDeadline().getEpochSecond(), 1_000_000L),
            t.settlementDeadline().getNano() / 1000);
    if (t instanceof DepositTerms d)
      return "deposit:"
          + request.requestId()
          + ":"
          + (d.mode() == Mode.INITIAL ? "InitializeOnly" : "Proportional")
          + ":"
          + atoms(d.maxBaseAmount())
          + ":"
          + atoms(d.maxQuoteAmount())
          + ":"
          + atoms(d.minLpOut())
          + ":"
          + atoms(d.minRatio())
          + ":"
          + atoms(d.maxRatio())
          + ":"
          + micros;
    var w = (WithdrawalTerms) t;
    return "withdrawal:"
        + request.requestId()
        + ":"
        + atoms(w.lpAmount())
        + ":"
        + atoms(w.minBaseOut())
        + ":"
        + atoms(w.minQuoteOut())
        + ":"
        + micros;
  }

  static DepositRequest<Pool> depositRequest(Request request) {
    requireAllocations(request);
    return new DepositRequest<>(
        new Pool.ContractId(request.terms().poolId()),
        request.terms().trader(),
        depositTerms(request.requestId(), (DepositTerms) request.terms()),
        allocation(request, 0),
        allocation(request, 1),
        allocation(request, 2));
  }

  static WithdrawalRequest<Pool> withdrawalRequest(Request request) {
    requireAllocations(request);
    return new WithdrawalRequest<>(
        new Pool.ContractId(request.terms().poolId()),
        request.terms().trader(),
        withdrawalTerms(request.requestId(), (WithdrawalTerms) request.terms()),
        allocation(request, 0),
        allocation(request, 1),
        allocation(request, 2));
  }

  private static void requireAllocations(Request request) {
    if (request.allocationCids().size() != 3 || new HashSet<>(request.allocationCids()).size() != 3)
      throw new IllegalStateException("Liquidity requires three confirmed allocations");
  }

  private static Allocation.ContractId allocation(Request r, int index) {
    return new Allocation.ContractId(r.allocationCids().get(index));
  }

  private static String atoms(String value) {
    return new BigDecimal(value).movePointRight(10).toBigIntegerExact().toString();
  }

  private static Token token(Pool pool, int index) {
    return index == 0 ? pool.baseToken : index == 1 ? pool.quoteToken : pool.lpToken;
  }

  private static com.openzeppelin.dex.canton.generated.lib.liquidity.DepositTerms depositTerms(
      UUID id, DepositTerms t) {
    return new com.openzeppelin.dex.canton.generated.lib.liquidity.DepositTerms(
        id.toString(),
        t.mode() == Mode.INITIAL ? DepositMode.INITIALIZEONLY : DepositMode.PROPORTIONAL,
        new BigDecimal(t.maxBaseAmount()),
        new BigDecimal(t.maxQuoteAmount()),
        new BigDecimal(t.minLpOut()),
        new BigDecimal(t.minRatio()),
        new BigDecimal(t.maxRatio()),
        t.settlementDeadline());
  }

  private static com.openzeppelin.dex.canton.generated.lib.liquidity.WithdrawalTerms
      withdrawalTerms(UUID id, WithdrawalTerms t) {
    return new com.openzeppelin.dex.canton.generated.lib.liquidity.WithdrawalTerms(
        id.toString(),
        new BigDecimal(t.lpAmount()),
        new BigDecimal(t.minBaseOut()),
        new BigDecimal(t.minQuoteOut()),
        t.settlementDeadline());
  }

  static LiquidityMath.Deposit validateDeposit(CantonPools.Snapshot pool, DepositTerms terms) {
    return validateDeposit(
        pool,
        terms,
        pool.state().baseReserve,
        pool.state().quoteReserve,
        pool.state().lpTokenSupply);
  }

  static LiquidityMath.Deposit validateDeposit(
      CantonPools.Snapshot pool,
      DepositTerms terms,
      BigDecimal baseReserve,
      BigDecimal quoteReserve,
      BigDecimal supply) {
    if ((supply.signum() == 0) != (terms.mode() == Mode.INITIAL))
      throw new LiquidityFailure(
          "DEPOSIT_MODE_CHANGED", "Pool initialization changed; request a new quote");
    requireInstruments(terms, pool.pool());
    var base =
        SwapMath.amount(
            terms.maxBaseAmount(), Math.toIntExact(pool.pool().baseToken.decimals), false);
    var quote =
        SwapMath.amount(
            terms.maxQuoteAmount(), Math.toIntExact(pool.pool().quoteToken.decimals), false);
    var minimum = SwapMath.amount(terms.minLpOut(), 10, true);
    var minRatio = SwapMath.amount(terms.minRatio(), 10, false);
    var maxRatio = SwapMath.amount(terms.maxRatio(), 10, false);
    if (minRatio.compareTo(maxRatio) > 0)
      throw new IllegalArgumentException("Ratio bounds are reversed");
    LiquidityMath.requireRatio(
        supply.signum() == 0 ? BigDecimal.ONE : baseReserve,
        supply.signum() == 0 ? pool.config().initialRatio : quoteReserve,
        minRatio,
        maxRatio);
    var result =
        LiquidityMath.deposit(
            base,
            quote,
            pool.config().initialRatio,
            baseReserve,
            quoteReserve,
            supply,
            Math.toIntExact(pool.pool().baseToken.decimals),
            Math.toIntExact(pool.pool().quoteToken.decimals));
    if (result.lp().compareTo(minimum) < 0)
      throw new LiquidityFailure(
          "MIN_LP_OUT", "Current reserves cannot satisfy the minimum LP output");
    return result;
  }

  static LiquidityMath.Withdrawal validateWithdrawal(
      CantonPools.Snapshot pool, WithdrawalTerms terms) {
    return validateWithdrawal(
        pool,
        terms,
        pool.state().baseReserve,
        pool.state().quoteReserve,
        pool.state().lpTokenSupply);
  }

  static LiquidityMath.Withdrawal validateWithdrawal(
      CantonPools.Snapshot pool,
      WithdrawalTerms terms,
      BigDecimal base,
      BigDecimal quote,
      BigDecimal supply) {
    requireInstruments(terms, pool.pool());
    var lp = SwapMath.amount(terms.lpAmount(), 10, false);
    var minBase =
        SwapMath.amount(terms.minBaseOut(), Math.toIntExact(pool.pool().baseToken.decimals), true);
    var minQuote =
        SwapMath.amount(
            terms.minQuoteOut(), Math.toIntExact(pool.pool().quoteToken.decimals), true);
    var result =
        LiquidityMath.withdraw(
            lp,
            base,
            quote,
            supply,
            Math.toIntExact(pool.pool().baseToken.decimals),
            Math.toIntExact(pool.pool().quoteToken.decimals));
    if (result.base().compareTo(minBase) < 0 || result.quote().compareTo(minQuote) < 0)
      throw new LiquidityFailure(
          "MIN_OUT", "Current reserves cannot satisfy the signed withdrawal outputs");
    return result;
  }

  private static LiquidityMath.Deposit depositAmounts(
      CantonPools.Snapshot pool, BigDecimal base, BigDecimal quote) {
    return LiquidityMath.deposit(
        base,
        quote,
        pool.config().initialRatio,
        pool.state().baseReserve,
        pool.state().quoteReserve,
        pool.state().lpTokenSupply,
        Math.toIntExact(pool.pool().baseToken.decimals),
        Math.toIntExact(pool.pool().quoteToken.decimals));
  }

  private static LiquidityMath.Withdrawal withdrawalAmounts(
      CantonPools.Snapshot pool, BigDecimal lp) {
    return LiquidityMath.withdraw(
        lp,
        pool.state().baseReserve,
        pool.state().quoteReserve,
        pool.state().lpTokenSupply,
        Math.toIntExact(pool.pool().baseToken.decimals),
        Math.toIntExact(pool.pool().quoteToken.decimals));
  }

  private static void requireInstruments(Terms terms, Pool pool) {
    if (!terms.baseInstrument().equals(PoolEncoding.instrument(pool.baseToken.instrument))
        || !terms.quoteInstrument().equals(PoolEncoding.instrument(pool.quoteToken.instrument))
        || !terms.lpInstrument().equals(PoolEncoding.instrument(pool.lpToken.instrument)))
      throw new IllegalArgumentException("Liquidity instruments differ from the pool");
  }

  record Operations(LiquidityTokenArgs args, List<DisclosedContract> disclosures) {}

  Operations operations(CantonPools.Snapshot pool) {
    var allocations = new ArrayList<CantonTokenRegistry.Operation>();
    var settlements = new ArrayList<CantonTokenRegistry.Operation>();
    var disclosures = new ArrayList<DisclosedContract>();
    for (var token : List.of(pool.pool().baseToken, pool.pool().quoteToken, pool.pool().lpToken)) {
      var allocation =
          CantonPools.requireFactory(
              token.allocationFactory.contractId,
              registries.inlineAllocation(token.instrument.admin));
      var settlement =
          CantonPools.requireFactory(
              token.settlementFactory.contractId,
              registries.inlineSettlement(token.instrument.admin));
      allocations.add(allocation);
      settlements.add(settlement);
      disclosures.addAll(allocation.disclosures());
      disclosures.addAll(settlement.disclosures());
    }
    return new Operations(
        new LiquidityTokenArgs(
            allocations.get(0).extraArgs(),
            allocations.get(1).extraArgs(),
            allocations.get(2).extraArgs(),
            settlements.get(0).extraArgs(),
            settlements.get(1).extraArgs(),
            settlements.get(2).extraArgs()),
        CantonPools.mergeDisclosures(disclosures));
  }

  private Onboarding.PartyPreparation signer(Account caller) {
    return tokens.signer(caller).party();
  }

  private static void requireTrader(Onboarding.PartyPreparation signer, Terms terms) {
    if (!signer.partyId().equals(terms.trader()))
      throw new IllegalArgumentException("Trader differs from the registered wallet");
  }

  private static com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account
      basicAccount(String party) {
    return new com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account(
        Optional.of(party), Optional.empty(), "");
  }

  private static com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account
      specialAccount(String name) {
    return new com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account(
        Optional.empty(), Optional.empty(), "cip-112/" + name);
  }

  private static Confirmation confirmed(
      Transaction tx, Status status, List<String> cids, Result result) {
    return new Confirmation(
        status,
        cids,
        result,
        tx.getUpdateId(),
        tx.getOffset(),
        Instant.ofEpochSecond(tx.getEffectiveAt().getSeconds(), tx.getEffectiveAt().getNanos()));
  }

  private static SigningPayload signing(
      InteractiveTransactions.Prepared p, List<RecoveryEffect> effects) {
    return new SigningPayload(
        p.preparedTransaction(),
        p.preparedTransactionHash(),
        p.hashingSchemeVersion(),
        p.partyId(),
        p.publicKeyFingerprint(),
        p.expiresAt(),
        effects);
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
