package com.openzeppelin.dex.canton;

import static com.openzeppelin.dex.settlements.SettlementModels.*;

import com.daml.ledger.api.v2.CommandsOuterClass.Commands;
import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.daml.ledger.api.v2.EventOuterClass;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.codegen.Update;
import com.openzeppelin.dex.canton.generated.lib.liquidity.DepositBatchRequest;
import com.openzeppelin.dex.canton.generated.lib.liquidity.WithdrawalBatchRequest;
import com.openzeppelin.dex.canton.generated.lib.swap.BatchRequest;
import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolaccess.PoolAccess;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.Allocation;
import com.openzeppelin.dex.canton.generated.venuedelegation.*;
import com.openzeppelin.dex.liquidity.LiquidityFailure;
import com.openzeppelin.dex.liquidity.LiquidityModels;
import com.openzeppelin.dex.pools.PoolModels.Instrument;
import com.openzeppelin.dex.settlements.SettlementLedger;
import com.openzeppelin.dex.swaps.LedgerRejected;
import com.openzeppelin.dex.swaps.SwapFailure;
import com.openzeppelin.dex.swaps.SwapModels.Direction;
import com.openzeppelin.dex.swaps.SwapModels.Swap;
import io.grpc.StatusRuntimeException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Component;

@Component
final class CantonSettlementLedger implements SettlementLedger {
  private final LedgerConnection ledger;
  private final CantonPools pools;
  private final CantonOperatorCommands commands;
  private final CantonTokenRegistry registries;
  private final CantonLiquidityLedger liquidity;

  CantonSettlementLedger(
      LedgerConnection ledger,
      CantonPools pools,
      CantonOperatorCommands commands,
      CantonTokenRegistry registries,
      CantonLiquidityLedger liquidity) {
    this.ledger = ledger;
    this.pools = pools;
    this.commands = commands;
    this.registries = registries;
    this.liquidity = liquidity;
  }

  @Override
  public Snapshot snapshot(String poolId) {
    return snapshot(pools.read(poolId));
  }

  private static Snapshot snapshot(CantonPools.Snapshot pool) {
    return new Snapshot(
        pool.poolId(),
        pool.version(),
        pool.reserves(),
        SwapMath.text(pool.config().feeBps),
        pool.health(),
        pool.reason(),
        pool.observedAt(),
        pool.offset(),
        SwapMath.text(pool.state().lpTokenSupply),
        SwapMath.text(pool.config().initialRatio));
  }

  @Override
  public List<Fill> preflight(Snapshot snapshot, List<QueueRequest> requests) {
    var steps = preview(snapshot, requests);
    for (var step : steps) {
      if (step.status() == PreviewStatus.BLOCKED)
        throw new Blocked(step.request(), step.errorCode(), step.error());
    }
    return steps.stream().map(PreviewStep::fill).toList();
  }

  @Override
  public List<PreviewStep> preview(Snapshot snapshot, List<QueueRequest> requests) {
    var trace = new ArrayList<PreviewStep>();
    try {
      evaluate(snapshot, requests, trace);
    } catch (Blocked blocked) {
      stopPreview(snapshot, requests, trace, blocked);
    }
    return List.copyOf(trace);
  }

  static void stopPreview(
      Snapshot snapshot, List<QueueRequest> requests, List<PreviewStep> trace, Blocked blocked) {
    var state = trace.isEmpty() ? projected(snapshot) : trace.getLast().after();
    if (trace.size() >= requests.size()
        || !requests.get(trace.size()).reference().equals(blocked.request()))
      throw new IllegalStateException("Preflight blocked an unexpected request", blocked);
    trace.add(
        new PreviewStep(
            blocked.request(),
            PreviewStatus.BLOCKED,
            null,
            state,
            null,
            List.of(),
            blocked.code(),
            blocked.getMessage()));
    for (var request : requests.subList(trace.size(), requests.size()))
      trace.add(
          new PreviewStep(
              request.reference(),
              PreviewStatus.NOT_EVALUATED,
              null,
              state,
              null,
              List.of(),
              null,
              null));
  }

  private void evaluate(Snapshot snapshot, List<QueueRequest> requests, List<PreviewStep> trace) {
    var pool = pools.read(snapshot.poolId());
    pool.requireLiquidityReady();
    if (!pool.version().equals(snapshot.version()))
      throw SwapFailure.conflict(POOL_CHANGED, "Pool changed during preflight");
    var allocations =
        ledger.activeInterfaceContracts(
            pool.pool().venueOperator, Allocation.INTERFACE_ID, pool.offset());
    if (requests.isEmpty()) throw new IllegalArgumentException("Settlement has no requests");
    if (requests.stream().anyMatch(request -> !request.type().equals(requests.getFirst().type())))
      throw new IllegalArgumentException("Settlement spans multiple request families");
    if (requests.getFirst() instanceof LiquidityRequest) {
      preflightLiquidity(
          pool,
          requests.stream().map(request -> (LiquidityRequest) request).toList(),
          allocations,
          trace);
      return;
    }
    pool.requireReady();
    var swaps = requests.stream().map(request -> ((SwapRequest) request).request()).toList();
    BigDecimal base = pool.state().baseReserve, quote = pool.state().quoteReserve;
    for (Swap swap : swaps) {
      if (!swap.poolId().equals(pool.poolId()))
        throw new IllegalArgumentException("Batch spans multiple pools");
      if (!Instant.now().isBefore(swap.settlementDeadline()))
        throw new Blocked(
            new RequestRef("swap", swap.swapId()), "EXPIRED", "Settlement deadline has elapsed");
      try {
        pools.access(swap.trader(), pool);
        var request = CantonSwapLedger.request(swap);
        for (boolean input : List.of(true, false)) {
          var id = input ? request.inputAllocation.contractId : request.outputAllocation.contractId;
          var allocation =
              allocations.stream()
                  .filter(event -> event.getContractId().equals(id))
                  .findFirst()
                  .orElseThrow(
                      () ->
                          new Blocked(
                              new RequestRef("swap", swap.swapId()),
                              "ALLOCATION_UNAVAILABLE",
                              "A swap allocation is no longer active"));
          CantonSwapLedger.validateAllocation(allocation, request, pool.route(), input);
        }
      } catch (SwapFailure failure) {
        throw new Blocked(
            new RequestRef("swap", swap.swapId()), failure.code(), failure.getMessage());
      } catch (IllegalStateException failure) {
        throw new Blocked(
            new RequestRef("swap", swap.swapId()), "ALLOCATION_MISMATCH", failure.getMessage());
      }
      boolean baseIn = swap.direction() == Direction.BaseToQuote;
      var outputToken = baseIn ? pool.pool().quoteToken : pool.pool().baseToken;
      var inputToken = baseIn ? pool.pool().baseToken : pool.pool().quoteToken;
      var outputInstrument =
          new Instrument(outputToken.instrument.admin, outputToken.instrument.id);
      if (!outputInstrument.equals(swap.outputInstrument()))
        throw new Blocked(
            new RequestRef("swap", swap.swapId()),
            "REQUEST_MISMATCH",
            "Output instrument differs from the queued swap");
      BigDecimal amount, output;
      try {
        amount = SwapMath.amount(swap.amountIn(), Math.toIntExact(inputToken.decimals), false);
        output =
            SwapMath.output(
                baseIn ? base : quote,
                baseIn ? quote : base,
                amount,
                pool.config().feeBps,
                Math.toIntExact(outputToken.decimals));
      } catch (IllegalArgumentException failure) {
        throw new Blocked(
            new RequestRef("swap", swap.swapId()), "INVALID_AMOUNT", failure.getMessage());
      }
      if (output.signum() <= 0 || output.compareTo(new BigDecimal(swap.minOut())) < 0)
        throw new Blocked(
            new RequestRef("swap", swap.swapId()),
            "MIN_OUT",
            "Current reserves cannot satisfy the signed minimum output");
      var fill = new SwapFill(swap.swapId(), SwapMath.text(output), outputInstrument);
      if (baseIn) {
        base = base.add(amount);
        quote = quote.subtract(output);
      } else {
        quote = quote.add(amount);
        base = base.subtract(output);
      }
      trace.add(
          validStep(
              new SwapRequest(swap),
              fill,
              trace,
              projected(snapshot),
              projected(base, quote, pool.state().lpTokenSupply)));
    }
  }

  private void preflightLiquidity(
      CantonPools.Snapshot pool,
      List<LiquidityRequest> requests,
      List<EventOuterClass.CreatedEvent> allocations,
      List<PreviewStep> trace) {
    if (requests.size() > 1
        && requests.stream()
            .anyMatch(
                queued ->
                    queued.request().terms() instanceof LiquidityModels.DepositTerms deposit
                        && deposit.mode() == LiquidityModels.Mode.INITIAL))
      throw new IllegalArgumentException("Initialization settles individually");
    BigDecimal base = pool.state().baseReserve,
        quote = pool.state().quoteReserve,
        supply = pool.state().lpTokenSupply;
    for (var queued : requests) {
      var request = queued.request();
      if (!request.terms().poolId().equals(pool.poolId()))
        throw new IllegalArgumentException("Request belongs to another pool");
      if (!Instant.now().isBefore(queued.settlementDeadline()))
        throw new Blocked(queued.reference(), "EXPIRED", "Settlement deadline has elapsed");
      try {
        for (int index = 0; index < 3; index++) {
          String cid = request.allocationCids().get(index);
          var event =
              allocations.stream()
                  .filter(e -> e.getContractId().equals(cid))
                  .findFirst()
                  .orElseThrow(
                      () ->
                          new LiquidityFailure(
                              "ALLOCATION_UNAVAILABLE",
                              "A liquidity allocation is no longer active"));
          CantonLiquidityLedger.validateAllocation(event, request, pool.pool(), index);
        }
        pools.access(request.terms().trader(), pool);
        if (request.terms() instanceof LiquidityModels.DepositTerms terms) {
          var result = CantonLiquidityLedger.validateDeposit(pool, terms, base, quote, supply);
          var fill =
              new DepositFill(
                  request.requestId(),
                  SwapMath.text(result.base()),
                  SwapMath.text(result.quote()),
                  SwapMath.text(result.baseRefund()),
                  SwapMath.text(result.quoteRefund()),
                  SwapMath.text(result.lp()));
          base = base.add(result.base());
          quote = quote.add(result.quote());
          supply =
              supply
                  .add(result.lp())
                  .add(
                      terms.mode() == LiquidityModels.Mode.INITIAL
                          ? LiquidityMath.MINIMUM
                          : BigDecimal.ZERO);
          trace.add(
              validStep(
                  queued, fill, trace, projected(snapshot(pool)), projected(base, quote, supply)));
          continue;
        }
        var result =
            CantonLiquidityLedger.validateWithdrawal(
                pool, (LiquidityModels.WithdrawalTerms) request.terms(), base, quote, supply);
        var fill =
            new WithdrawalFill(
                request.requestId(),
                SwapMath.text(result.lp()),
                SwapMath.text(result.base()),
                SwapMath.text(result.quote()));
        base = base.subtract(result.base());
        quote = quote.subtract(result.quote());
        supply = supply.subtract(result.lp());
        trace.add(
            validStep(
                queued, fill, trace, projected(snapshot(pool)), projected(base, quote, supply)));
      } catch (LiquidityFailure failure) {
        throw new Blocked(queued.reference(), failure.code(), failure.getMessage());
      } catch (SwapFailure failure) {
        throw new Blocked(queued.reference(), failure.code(), failure.getMessage());
      } catch (IllegalStateException | IllegalArgumentException failure) {
        throw new Blocked(queued.reference(), "REQUEST_MISMATCH", failure.getMessage());
      }
    }
  }

  static ProjectedPoolState projected(Snapshot snapshot) {
    var reserves = snapshot.reserves();
    return new ProjectedPoolState(
        reserves.baseReserve(),
        reserves.quoteReserve(),
        snapshot.lpTokenSupply(),
        reserves.spotPrice(),
        reserves.invariant());
  }

  private static ProjectedPoolState projected(
      BigDecimal base, BigDecimal quote, BigDecimal supply) {
    return new ProjectedPoolState(
        SwapMath.text(base),
        SwapMath.text(quote),
        SwapMath.text(supply),
        base.signum() == 0 ? null : SwapMath.text(quote.divide(base, 10, RoundingMode.HALF_UP)),
        SwapMath.text(base.multiply(quote)));
  }

  static PreviewStep validStep(
      QueueRequest request,
      Fill fill,
      List<PreviewStep> trace,
      ProjectedPoolState initial,
      ProjectedPoolState after) {
    List<OutputCheck> outputs =
        switch (fill) {
          case SwapFill swap ->
              List.of(
                  outputCheck(
                      swap.outputInstrument(),
                      swap.amountOut(),
                      ((SwapRequest) request).request().minOut()));
          case DepositFill deposit -> {
            var terms =
                (LiquidityModels.DepositTerms) ((LiquidityRequest) request).request().terms();
            yield List.of(
                outputCheck(terms.lpInstrument(), deposit.actualLpOut(), terms.minLpOut()));
          }
          case WithdrawalFill withdrawal -> {
            var terms =
                (LiquidityModels.WithdrawalTerms) ((LiquidityRequest) request).request().terms();
            yield List.of(
                outputCheck(terms.baseInstrument(), withdrawal.actualBaseOut(), terms.minBaseOut()),
                outputCheck(
                    terms.quoteInstrument(), withdrawal.actualQuoteOut(), terms.minQuoteOut()));
          }
        };
    return new PreviewStep(
        request.reference(),
        PreviewStatus.VALID,
        fill,
        trace.isEmpty() ? initial : trace.getLast().after(),
        after,
        outputs,
        null,
        null);
  }

  private static OutputCheck outputCheck(Instrument instrument, String amount, String minimum) {
    var output = new BigDecimal(amount);
    String headroom =
        output.signum() == 0
            ? null
            : SwapMath.text(
                output
                    .subtract(new BigDecimal(minimum))
                    .multiply(BigDecimal.valueOf(10000))
                    .divide(output, 4, RoundingMode.DOWN));
    return new OutputCheck(instrument, amount, minimum, headroom);
  }

  @Override
  public Confirmation submit(Pending pending) {
    Transaction transaction;
    try {
      transaction = commands.submit(pending.commandId(), "batch", () -> buildCommands(pending));
    } catch (CantonOperatorCommands.PreparationFailed failure) {
      throw new Excluded("COMMAND_NOT_PREPARED", failure.getMessage());
    } catch (StatusRuntimeException failure) {
      if (CantonPoolLedger.definitivelyRejected(failure))
        throw new LedgerRejected(
            "LEDGER_REJECTED", "Canton rejected the batch; its token transfers were rolled back");
      throw failure;
    }
    return confirm(transaction, pending);
  }

  private Commands buildCommands(Pending pending) {
    var pool = pools.read(pending.settlement().poolId());
    if (!pool.version().equals(pending.stateVersion())
        || !(pool.health().equals("READY") || pool.health().equals("EMPTY")))
      throw new LedgerRejected(POOL_CHANGED, "Pool changed before batch submission");
    if (pending.requests().getFirst() instanceof LiquidityRequest queued) {
      var request = queued.request();
      var operations = liquidity.operations(pool);
      var delegation = new VenueDelegation.ContractId(pool.delegationEvent().getContractId());
      var config = new PoolConfig.ContractId(pool.configEvent().getContractId());
      var state = new PoolState.ContractId(pool.stateEvent().getContractId());
      Update<?> command =
          request.kind() == LiquidityModels.Kind.DEPOSIT
              ? delegation.exerciseVenueDelegation_AddLiquidity(
                  config,
                  state,
                  pending.requests().stream()
                      .map(
                          item -> {
                            var deposit = ((LiquidityRequest) item).request();
                            return new DepositSettlementRequest(
                                new PoolAccess.ContractId(
                                    pools.access(deposit.terms().trader(), pool).getContractId()),
                                new DepositBatchRequest<>(
                                    CantonLiquidityLedger.depositRequest(deposit),
                                    operations.args()));
                          })
                      .toList())
              : delegation.exerciseVenueDelegation_WithdrawLiquidity(
                  config,
                  state,
                  pending.requests().stream()
                      .map(
                          item -> {
                            var withdrawal = ((LiquidityRequest) item).request();
                            return new WithdrawalSettlementRequest(
                                new PoolAccess.ContractId(
                                    pools
                                        .access(withdrawal.terms().trader(), pool)
                                        .getContractId()),
                                new WithdrawalBatchRequest<>(
                                    CantonLiquidityLedger.withdrawalRequest(withdrawal),
                                    operations.args()));
                          })
                      .toList());
      return ledger.storedCommands(
          pending.commandId().toString(),
          pool.pool().venueOperator,
          List.of(pool.pool().dvo),
          command,
          pending.beginOffset(),
          pools.settlementDisclosures(pool, operations.disclosures()));
    }
    var base = pool.pool().baseToken;
    var quote = pool.pool().quoteToken;
    var baseAllocation =
        CantonPools.requireFactory(
            base.allocationFactory.contractId, registries.inlineAllocation(base.instrument.admin));
    var quoteAllocation =
        CantonPools.requireFactory(
            quote.allocationFactory.contractId,
            registries.inlineAllocation(quote.instrument.admin));
    var baseSettlement =
        CantonPools.requireFactory(
            base.settlementFactory.contractId, registries.inlineSettlement(base.instrument.admin));
    var quoteSettlement =
        CantonPools.requireFactory(
            quote.settlementFactory.contractId,
            registries.inlineSettlement(quote.instrument.admin));
    var requests =
        pending.requests().stream()
            .map(request -> ((SwapRequest) request).request())
            .map(
                swap -> {
                  boolean baseIn = swap.direction() == Direction.BaseToQuote;
                  return new SettlementRequest(
                      new PoolAccess.ContractId(pools.access(swap.trader(), pool).getContractId()),
                      new BatchRequest<>(
                          CantonSwapLedger.request(swap),
                          (baseIn ? baseAllocation : quoteAllocation).extraArgs(),
                          (baseIn ? quoteAllocation : baseAllocation).extraArgs(),
                          (baseIn ? baseSettlement : quoteSettlement).extraArgs(),
                          (baseIn ? quoteSettlement : baseSettlement).extraArgs()));
                })
            .toList();
    var disclosures = new ArrayList<DisclosedContract>();
    for (var operation : List.of(baseAllocation, quoteAllocation, baseSettlement, quoteSettlement))
      disclosures.addAll(operation.disclosures());
    return ledger.storedCommands(
        pending.commandId().toString(),
        pool.pool().venueOperator,
        List.of(pool.pool().dvo),
        new VenueDelegation.ContractId(pool.delegationEvent().getContractId())
            .exerciseVenueDelegation_SettleBatch(
                new PoolConfig.ContractId(pool.configEvent().getContractId()),
                new PoolState.ContractId(pool.stateEvent().getContractId()),
                requests,
                pending.settlement().settlementId().toString()),
        pending.beginOffset(),
        pools.settlementDisclosures(pool, disclosures));
  }

  @Override
  public Optional<Confirmation> recover(Pending pending) {
    var history = ledger.transactions(pending.beginOffset(), ledger.primaryParty());
    var committed =
        history.stream()
            .filter(t -> t.getCommandId().equals(pending.commandId().toString()))
            .map(t -> confirm(t, pending))
            .findFirst();
    if (committed.isPresent()) return committed;
    if (inputsConsumed(history, pending))
      throw new Excluded(
          "BATCH_INPUT_CONSUMED",
          "A required pool state or allocation was consumed by another transaction");
    // The immutable envelope retains the original offset and change identity.
    // A replay error cannot establish the outcome of an earlier attempt.
    try {
      return Optional.of(submit(pending));
    } catch (StatusRuntimeException | LedgerRejected uncertain) {
      return Optional.empty();
    }
  }

  static boolean inputsConsumed(List<Transaction> history, Pending pending) {
    for (var transaction : history) {
      for (var event : transaction.getEventsList()) {
        if (!event.hasExercised()) continue;
        var exercise = event.getExercised();
        var template = exercise.getTemplateId();
        if (exercise.getConsuming()
            && exercise.getContractId().equals(pending.settlement().before().stateId())
            && template.getModuleName().equals("Pool")
            && template.getEntityName().equals("PoolState")
            && Pool.PACKAGE_ID.equals(template.getPackageId())) return true;
        if (pending.requests().stream()
            .anyMatch(
                request ->
                    switch (request) {
                      case SwapRequest swap ->
                          CantonSwapLedger.isWithdrawal(exercise, swap.request());
                      case LiquidityRequest lp ->
                          CantonLiquidityLedger.isRecovery(exercise, lp.request());
                    })) return true;
      }
    }
    return false;
  }

  static Confirmation confirm(Transaction transaction, Pending pending) {
    var created =
        transaction.getEventsList().stream()
            .filter(EventOuterClass.Event::hasCreated)
            .map(EventOuterClass.Event::getCreated)
            .toList();
    var receipts =
        created.stream()
            .filter(e -> CantonPools.isAppTemplate(e, SwapReceipt.TEMPLATE_ID))
            .map(
                e ->
                    SwapReceipt.valueDecoder().decode(DamlRecord.fromProto(e.getCreateArguments())))
            .filter(r -> r.batchId.equals(pending.settlement().settlementId().toString()))
            .toList();
    if (pending.requests().getFirst() instanceof SwapRequest
        && receipts.size() != pending.requests().size())
      throw new IllegalStateException("Batch receipt count differs");
    var fills = new ArrayList<Fill>();
    for (var queued : pending.requests()) {
      if (queued instanceof LiquidityRequest lp) {
        var result =
            CantonLiquidityLedger.settlementResult(transaction, lp.request())
                .orElseThrow(
                    () -> new IllegalStateException("Liquidity settlement receipt is missing"));
        fills.add(
            switch (result) {
              case LiquidityModels.DepositResult deposited ->
                  new DepositFill(
                      lp.request().requestId(),
                      deposited.actualBaseIn(),
                      deposited.actualQuoteIn(),
                      deposited.actualBaseRefund(),
                      deposited.actualQuoteRefund(),
                      deposited.actualLpOut());
              case LiquidityModels.WithdrawalResult withdrawn ->
                  new WithdrawalFill(
                      lp.request().requestId(),
                      withdrawn.actualLpBurned(),
                      withdrawn.actualBaseOut(),
                      withdrawn.actualQuoteOut());
            });
        continue;
      }
      var swap = ((SwapRequest) queued).request();
      var matching =
          receipts.stream()
              .filter(
                  r ->
                      r.inputAllocation.contractId.equals(swap.allocationCids().get(0))
                          && r.outputAllocation.contractId.equals(swap.allocationCids().get(1))
                          && r.terms.requestId.equals(swap.swapId().toString())
                          && r.trader.equals(swap.trader())
                          && r.poolCid.contractId.equals(swap.poolId()))
              .toList();
      if (matching.size() != 1)
        throw new IllegalStateException("Batch receipt does not match request");
      var receipt = matching.getFirst();
      if (!receipt.terms.direction.getConstructor().equals(swap.direction().name()))
        throw new IllegalStateException("Confirmed receipt direction differs from the request");
      if (receipt.amountOut.compareTo(new BigDecimal(swap.minOut())) < 0)
        throw new IllegalStateException("Confirmed receipt violates minimum output");
      fills.add(
          new SwapFill(
              swap.swapId(),
              SwapMath.text(receipt.amountOut),
              Objects.requireNonNull(
                  swap.outputInstrument(), "Confirmed request lacks an output instrument")));
    }
    var stateEvents =
        created.stream()
            .filter(e -> CantonPools.isAppTemplate(e, PoolState.TEMPLATE_ID))
            .filter(
                e ->
                    PoolState.valueDecoder()
                        .decode(DamlRecord.fromProto(e.getCreateArguments()))
                        .poolCid
                        .contractId
                        .equals(pending.settlement().poolId()))
            .toList();
    if (stateEvents.size() != 1)
      throw new IllegalStateException("Batch must replace pool state once");
    var event = stateEvents.getFirst();
    var state = PoolState.valueDecoder().decode(DamlRecord.fromProto(event.getCreateArguments()));
    var after =
        new Reserves(
            event.getContractId(),
            SwapMath.text(state.baseReserve),
            SwapMath.text(state.quoteReserve),
            SwapMath.text(state.quoteReserve.divide(state.baseReserve, 10, RoundingMode.HALF_UP)),
            SwapMath.text(state.baseReserve.multiply(state.quoteReserve)));
    var before = pending.settlement().before();
    if (before == null
        || (pending.requests().getFirst() instanceof SwapRequest
            && new BigDecimal(after.invariant()).compareTo(new BigDecimal(before.invariant())) < 0))
      throw new IllegalStateException("Confirmed batch invariant decreased");
    return new Confirmation(
        List.copyOf(fills),
        before,
        after,
        transaction.getUpdateId(),
        transaction.getOffset(),
        Instant.ofEpochSecond(
            transaction.getEffectiveAt().getSeconds(), transaction.getEffectiveAt().getNanos()));
  }
}
