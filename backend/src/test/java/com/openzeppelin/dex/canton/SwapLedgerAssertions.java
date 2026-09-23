package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.assertThat;

import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.openzeppelin.dex.canton.generated.openzeppelin.tokencip112v1.allocation.TokenAllocation;
import com.openzeppelin.dex.canton.generated.openzeppelin.tokencip112v1.holding.TokenHolding;
import com.openzeppelin.dex.canton.generated.pool.Pool;
import com.openzeppelin.dex.canton.generated.pool.PoolState;
import com.openzeppelin.dex.canton.generated.pool.SwapReceipt;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Holding;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.InstrumentId;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;
import tools.jackson.databind.JsonNode;

/** Reads actual holdings and transaction events, independently of the backend's projections. */
public final class SwapLedgerAssertions {
  private SwapLedgerAssertions() {}

  public static void privateSwapContracts(
      LedgerConnection ledger,
      String callerToken,
      String party,
      JsonNode own,
      JsonNode foreign,
      boolean settled) {
    long offset = ledger.ledgerEnd(callerToken);
    var ownAllocations = new HashSet<String>();
    var foreignAllocations = new HashSet<String>();
    own.path("allocationCids").forEach(id -> ownAllocations.add(id.asString()));
    foreign.path("allocationCids").forEach(id -> foreignAllocations.add(id.asString()));
    assertThat(ownAllocations).hasSize(2);
    assertThat(foreignAllocations).hasSize(2);
    assertThat(ledger.activeContracts(party, TokenAllocation.TEMPLATE_ID, offset, callerToken))
        .extracting(CreatedEvent::getContractId)
        .containsExactlyInAnyOrderElementsOf(settled ? Set.of() : ownAllocations)
        .doesNotContainAnyElementsOf(foreignAllocations);

    var receipts =
        ledger.activeContracts(party, SwapReceipt.TEMPLATE_ID, offset, callerToken).stream()
            .map(
                e ->
                    SwapReceipt.valueDecoder().decode(DamlRecord.fromProto(e.getCreateArguments())))
            .toList();
    assertThat(receipts).allSatisfy(receipt -> assertThat(receipt.trader).isEqualTo(party));
    assertThat(receipts)
        .extracting(receipt -> receipt.terms.requestId)
        .doesNotContain(foreign.path("swapId").asString());
    assertThat(receipts)
        .allSatisfy(
            receipt ->
                assertThat(
                        List.of(
                            receipt.inputAllocation.contractId,
                            receipt.outputAllocation.contractId))
                    .doesNotContainAnyElementsOf(foreignAllocations));
    var ownReceipts =
        receipts.stream()
            .filter(receipt -> receipt.terms.requestId.equals(own.path("swapId").asString()))
            .toList();
    assertThat(ownReceipts).hasSize(settled ? 1 : 0);
    assertThat(ownReceipts)
        .allSatisfy(
            receipt -> {
              assertThat(
                      List.of(
                          receipt.inputAllocation.contractId, receipt.outputAllocation.contractId))
                  .containsExactlyInAnyOrderElementsOf(ownAllocations);
              assertThat(receipt.poolCid.contractId).isEqualTo(own.path("poolId").asString());
              assertThat(receipt.terms.requestId).isEqualTo(own.path("swapId").asString());
              assertThat(receipt.terms.amountIn)
                  .isEqualByComparingTo(own.path("amountIn").asString());
              assertThat(receipt.terms.minOut).isEqualByComparingTo(own.path("minOut").asString());
            });
  }

  public static void allocations(
      LedgerConnection ledger, String token, String party, JsonNode swap, boolean active) {
    var contracts = ledger.activeContracts(party, TokenAllocation.TEMPLATE_ID, token);
    var ids = new HashSet<String>();
    swap.path("allocationCids").forEach(id -> ids.add(id.asString()));
    assertThat(ids).hasSize(2);
    var matched = contracts.stream().filter(e -> ids.contains(e.getContractId())).toList();
    assertThat(matched).hasSize(active ? 2 : 0);
    if (!active) return;
    String poolId = swap.path("poolId").asString();
    var poolEvent =
        ledger.activeContracts(ledger.primaryParty(), Pool.TEMPLATE_ID).stream()
            .filter(event -> event.getContractId().equals(poolId))
            .findFirst()
            .orElseThrow();
    var pool = Pool.valueDecoder().decode(DamlRecord.fromProto(poolEvent.getCreateArguments()));
    String inputCid = swap.path("allocationCids").get(0).asString();
    Instant deadline = Instant.parse(swap.path("settlementDeadline").asString());
    String settlementId =
        "swap:"
            + swap.path("swapId").asString()
            + ":"
            + swap.path("direction").asString()
            + ":"
            + new BigDecimal(swap.path("amountIn").asString())
                .movePointRight(10)
                .toBigIntegerExact()
            + ":"
            + new BigDecimal(swap.path("minOut").asString()).movePointRight(10).toBigIntegerExact()
            + ":"
            + Math.addExact(
                Math.multiplyExact(deadline.getEpochSecond(), 1_000_000L),
                deadline.getNano() / 1_000);
    for (var event : matched) {
      var allocation =
          TokenAllocation.valueDecoder().decode(DamlRecord.fromProto(event.getCreateArguments()));
      boolean input = event.getContractId().equals(inputCid);
      var instrument = swap.path(input ? "inputInstrument" : "outputInstrument");
      var amount = new BigDecimal(swap.path(input ? "amountIn" : "minOut").asString());
      assertThat(allocation.allocation.authorizer)
          .isEqualTo(new Account(Optional.of(party), Optional.empty(), ""));
      assertThat(allocation.allocation.admin).isEqualTo(instrument.path("admin").asString());
      assertThat(allocation.allocation.committed).isTrue();
      assertThat(allocation.allocation.settlementDeadline)
          .contains(Instant.parse(swap.path("settlementDeadline").asString()));
      assertThat(allocation.numIterations).isZero();
      assertThat(allocation.settlement.id).isEqualTo(settlementId);
      assertThat(allocation.settlement.cid.map(cid -> cid.contractId)).contains(poolId);
      assertThat(allocation.settlement.executors)
          .containsExactly(pool.dvo, pool.venueOperator)
          .doesNotContain(party);
      var funding = allocation.allocation.nextIterationFunding.orElseThrow();
      if (input) {
        assertThat(funding).containsOnlyKeys(instrument.path("id").asString());
        assertThat(funding.get(instrument.path("id").asString())).isEqualByComparingTo(amount);
        assertThat(allocation.allocation.meta.values)
            .containsExactlyEntriesOf(
                Map.of(
                    AllocationMetadata.MIN_OUT,
                    new BigDecimal(swap.path("minOut").asString())
                        .stripTrailingZeros()
                        .toPlainString()));
      } else {
        assertThat(funding).isEmpty();
        assertThat(allocation.allocation.meta.values).isEmpty();
      }
      assertThat(allocation.allocation.transferLegSides).isEmpty();
    }
  }

  public static void backing(LedgerConnection ledger, String poolId) {
    long offset = ledger.ledgerEnd();
    var poolEvent =
        ledger.activeContracts(ledger.primaryParty(), Pool.TEMPLATE_ID, offset).stream()
            .filter(e -> Pool.PACKAGE_ID.equals(e.getTemplateId().getPackageId()))
            .filter(e -> e.getContractId().equals(poolId))
            .findFirst()
            .orElseThrow();
    var pool = Pool.valueDecoder().decode(DamlRecord.fromProto(poolEvent.getCreateArguments()));
    var states =
        ledger.activeContracts(pool.dvo, PoolState.TEMPLATE_ID, offset).stream()
            .filter(e -> Pool.PACKAGE_ID.equals(e.getTemplateId().getPackageId()))
            .map(e -> PoolState.valueDecoder().decode(DamlRecord.fromProto(e.getCreateArguments())))
            .filter(s -> s.poolCid.contractId.equals(poolId))
            .toList();
    assertThat(states).hasSize(1);
    var state = states.getFirst();
    var holdings = ledger.activeContracts(pool.dvo, TokenHolding.TEMPLATE_ID, offset);
    assertThat(total(holdings, state.baseHoldingCids, pool.baseAccount, pool.baseToken.instrument))
        .isEqualByComparingTo(state.baseReserve);
    assertThat(
            total(holdings, state.quoteHoldingCids, pool.quoteAccount, pool.quoteToken.instrument))
        .isEqualByComparingTo(state.quoteReserve);
  }

  public static void atomicBatch(LedgerConnection ledger, long beginOffset, JsonNode batch) {
    var transactions =
        ledger.transactions(beginOffset, ledger.primaryParty()).stream()
            .filter(tx -> tx.getUpdateId().equals(batch.path("updateId").asString()))
            .toList();
    assertThat(transactions).hasSize(1);
    var events = transactions.getFirst().getEventsList();
    var receiptEvents =
        events.stream()
            .filter(e -> e.hasCreated())
            .map(e -> e.getCreated())
            .filter(
                e ->
                    e.getTemplateId()
                            .getModuleName()
                            .equals(SwapReceipt.TEMPLATE_ID.getModuleName())
                        && e.getTemplateId()
                            .getEntityName()
                            .equals(SwapReceipt.TEMPLATE_ID.getEntityName()))
            .toList();
    assertThat(receiptEvents)
        .allSatisfy(
            event ->
                assertThat(event.getTemplateId().getPackageId())
                    .as("Settlement receipts must use the current application package")
                    .isEqualTo(SwapReceipt.PACKAGE_ID));
    var receipts =
        receiptEvents.stream()
            .map(
                e ->
                    SwapReceipt.valueDecoder().decode(DamlRecord.fromProto(e.getCreateArguments())))
            .toList();
    var expected = new ArrayList<String>();
    batch
        .path("requests")
        .forEach(
            ref -> {
              assertThat(ref.path("type").asString()).isEqualTo("swap");
              expected.add(ref.path("requestId").asString());
            });
    assertThat(receipts).extracting(r -> r.terms.requestId).containsExactlyElementsOf(expected);
    assertThat(receipts)
        .allSatisfy(
            r -> {
              assertThat(r.poolCid.contractId).isEqualTo(batch.path("poolId").asString());
              assertThat(r.batchId).isEqualTo(batch.path("settlementId").asString());
              assertThat(r.amountOut).isPositive();
            });
    for (int i = 0; i < receipts.size(); i++)
      assertThat(receipts.get(i).amountOut)
          .isEqualByComparingTo(batch.path("fills").get(i).path("amountOut").asString());
    var states =
        events.stream()
            .filter(e -> e.hasCreated())
            .map(e -> e.getCreated())
            .filter(
                e ->
                    e.getTemplateId().getModuleName().equals("Pool")
                        && e.getTemplateId().getEntityName().equals("PoolState"))
            .toList();
    assertThat(states).hasSize(1);
    assertThat(states.getFirst().getTemplateId().getPackageId())
        .as("Settlement must replace pool state through the current application package")
        .isEqualTo(PoolState.PACKAGE_ID);
    var consumedStates =
        events.stream()
            .filter(e -> e.hasExercised())
            .map(e -> e.getExercised())
            .filter(
                e ->
                    e.getConsuming()
                        && e.getContractId()
                            .equals(batch.path("before").path("stateId").asString()))
            .toList();
    assertThat(consumedStates)
        .singleElement()
        .satisfies(
            e -> {
              assertThat(e.getChoice()).isEqualTo("Archive");
              assertThat(e.getTemplateId().getPackageId()).isEqualTo(PoolState.PACKAGE_ID);
            });
    var poolSwaps =
        events.stream()
            .filter(e -> e.hasExercised())
            .map(e -> e.getExercised())
            .filter(e -> e.getChoice().equals("Pool_Swap"))
            .toList();
    assertThat(poolSwaps)
        .singleElement()
        .satisfies(
            e -> {
              assertThat(e.getConsuming()).isFalse();
              assertThat(e.getContractId()).isEqualTo(batch.path("poolId").asString());
            });
  }

  private static BigDecimal total(
      List<CreatedEvent> events,
      List<Holding.ContractId> ids,
      Account account,
      InstrumentId instrument) {
    var unique = ids.stream().map(id -> id.contractId).collect(java.util.stream.Collectors.toSet());
    assertThat(unique).hasSize(ids.size());
    var selected = events.stream().filter(e -> unique.contains(e.getContractId())).toList();
    assertThat(selected).hasSize(ids.size());
    BigDecimal total = BigDecimal.ZERO;
    for (var event : selected) {
      var h =
          TokenHolding.valueDecoder()
              .decode(DamlRecord.fromProto(event.getCreateArguments()))
              .holding;
      assertThat(h.account).isEqualTo(account);
      assertThat(h.instrumentId).isEqualTo(instrument);
      assertThat(h.lock).isEmpty();
      total = total.add(h.amount);
    }
    return total;
  }
}
