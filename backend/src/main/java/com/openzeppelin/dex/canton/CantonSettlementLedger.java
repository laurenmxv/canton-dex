package com.openzeppelin.dex.canton;

import static com.openzeppelin.dex.settlements.SettlementModels.*;

import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.daml.ledger.api.v2.EventOuterClass;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.openzeppelin.dex.canton.generated.lib.swap.*;
import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolaccess.PoolAccess;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.Allocation;
import com.openzeppelin.dex.canton.generated.venuedelegation.*;
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
  private final CantonSwapPools pools;
  private final CantonOperatorCommands commands;
  private final CantonTokenRegistry registries;

  CantonSettlementLedger(
      LedgerConnection ledger,
      CantonSwapPools pools,
      CantonOperatorCommands commands,
      CantonTokenRegistry registries) {
    this.ledger = ledger;
    this.pools = pools;
    this.commands = commands;
    this.registries = registries;
  }

  @Override
  public Snapshot snapshot(String poolId) {
    return snapshot(pools.read(poolId));
  }

  private static Snapshot snapshot(CantonSwapPools.Snapshot pool) {
    return new Snapshot(
        pool.poolId(),
        pool.version(),
        pool.reserves(),
        SwapMath.text(pool.config().feeBps),
        pool.health(),
        pool.reason(),
        pool.observedAt(),
        pool.offset());
  }

  @Override
  public List<Fill> preflight(Snapshot snapshot, List<Swap> swaps) {
    var pool = pools.read(snapshot.poolId());
    pool.requireReady();
    if (!pool.version().equals(snapshot.version()))
      throw SwapFailure.conflict("POOL_CHANGED", "Pool changed during preflight");
    var allocations =
        ledger.activeInterfaceContracts(
            pool.pool().venueOperator, Allocation.INTERFACE_ID, pool.offset());
    BigDecimal base = pool.state().baseReserve, quote = pool.state().quoteReserve;
    var fills = new ArrayList<Fill>();
    for (Swap swap : swaps) {
      if (!swap.poolId().equals(pool.poolId()))
        throw new IllegalArgumentException("Batch spans multiple pools");
      if (!Instant.now().isBefore(swap.settlementDeadline()))
        throw new Blocked(swap.swapId(), "EXPIRED", "Settlement deadline has elapsed");
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
                              swap.swapId(),
                              "ALLOCATION_UNAVAILABLE",
                              "A swap allocation is no longer active"));
          CantonSwapLedger.validateAllocation(allocation, request, pool.route(), input);
        }
      } catch (SwapFailure failure) {
        throw new Blocked(swap.swapId(), failure.code(), failure.getMessage());
      } catch (IllegalStateException failure) {
        throw new Blocked(swap.swapId(), "ALLOCATION_MISMATCH", failure.getMessage());
      }
      boolean baseIn = swap.direction() == Direction.BaseToQuote;
      var outputToken = baseIn ? pool.funding().quoteToken : pool.funding().baseToken;
      var inputToken = baseIn ? pool.funding().baseToken : pool.funding().quoteToken;
      var outputInstrument =
          new Instrument(outputToken.instrument.admin, outputToken.instrument.id);
      if (!outputInstrument.equals(swap.outputInstrument()))
        throw new Blocked(
            swap.swapId(), "REQUEST_MISMATCH", "Output instrument differs from the queued swap");
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
        throw new Blocked(swap.swapId(), "INVALID_AMOUNT", failure.getMessage());
      }
      if (output.signum() <= 0 || output.compareTo(new BigDecimal(swap.minOut())) < 0)
        throw new Blocked(
            swap.swapId(), "MIN_OUT", "Current reserves cannot satisfy the signed minimum output");
      fills.add(new Fill(swap.swapId(), SwapMath.text(output), outputInstrument));
      if (baseIn) {
        base = base.add(amount);
        quote = quote.subtract(output);
      } else {
        quote = quote.add(amount);
        base = base.subtract(output);
      }
    }
    return List.copyOf(fills);
  }

  @Override
  public Confirmation submit(Pending pending) {
    Transaction transaction;
    try {
      transaction =
          commands.submit(
              pending.commandId(),
              "batch",
              () -> {
                var pool = pools.read(pending.settlement().poolId());
                if (!pool.version().equals(pending.stateVersion())
                    || !pool.health().equals("READY"))
                  throw new LedgerRejected("POOL_CHANGED", "Pool changed before batch submission");
                var base = pool.funding().baseToken;
                var quote = pool.funding().quoteToken;
                var baseAllocation =
                    CantonSwapPools.requireFactory(
                        base.allocationFactory.contractId,
                        registries.inlineAllocation(base.instrument.admin));
                var quoteAllocation =
                    CantonSwapPools.requireFactory(
                        quote.allocationFactory.contractId,
                        registries.inlineAllocation(quote.instrument.admin));
                var baseSettlement =
                    CantonSwapPools.requireFactory(
                        base.settlementFactory.contractId,
                        registries.inlineSettlement(base.instrument.admin));
                var quoteSettlement =
                    CantonSwapPools.requireFactory(
                        quote.settlementFactory.contractId,
                        registries.inlineSettlement(quote.instrument.admin));
                var requests =
                    pending.swaps().stream()
                        .map(
                            swap -> {
                              boolean baseIn = swap.direction() == Direction.BaseToQuote;
                              return new SettlementRequest(
                                  new PoolAccess.ContractId(
                                      pools.access(swap.trader(), pool).getContractId()),
                                  new BatchRequest<>(
                                      CantonSwapLedger.request(swap),
                                      (baseIn ? baseAllocation : quoteAllocation).extraArgs(),
                                      (baseIn ? quoteAllocation : baseAllocation).extraArgs(),
                                      (baseIn ? baseSettlement : quoteSettlement).extraArgs(),
                                      (baseIn ? quoteSettlement : baseSettlement).extraArgs()));
                            })
                        .toList();
                var disclosures = new ArrayList<DisclosedContract>();
                for (var operation :
                    List.of(baseAllocation, quoteAllocation, baseSettlement, quoteSettlement))
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
              });
    } catch (StatusRuntimeException failure) {
      if (CantonPoolLedger.definitivelyRejected(failure))
        throw new LedgerRejected(
            "LEDGER_REJECTED", "Canton rejected the batch; its token transfers were rolled back");
      throw failure;
    }
    return confirm(transaction, pending);
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
        if (pending.swaps().stream().anyMatch(s -> CantonSwapLedger.isWithdrawal(exercise, s)))
          return true;
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
            .filter(e -> CantonSwapPools.isAppTemplate(e, SwapReceipt.TEMPLATE_ID))
            .map(
                e ->
                    SwapReceipt.valueDecoder().decode(DamlRecord.fromProto(e.getCreateArguments())))
            .filter(r -> r.batchId.equals(pending.settlement().settlementId().toString()))
            .toList();
    if (receipts.size() != pending.swaps().size())
      throw new IllegalStateException("Batch receipt count differs");
    var fills = new ArrayList<Fill>();
    for (var swap : pending.swaps()) {
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
          new Fill(
              swap.swapId(),
              SwapMath.text(receipt.amountOut),
              Objects.requireNonNull(
                  swap.outputInstrument(), "Confirmed request lacks an output instrument")));
    }
    var stateEvents =
        created.stream()
            .filter(e -> CantonSwapPools.isAppTemplate(e, PoolState.TEMPLATE_ID))
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
        || new BigDecimal(after.invariant()).compareTo(new BigDecimal(before.invariant())) < 0)
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
