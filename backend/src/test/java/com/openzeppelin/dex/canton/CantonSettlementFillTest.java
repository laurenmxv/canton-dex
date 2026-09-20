package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.api.v2.EventOuterClass.Event;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.Identifier;
import com.daml.ledger.javaapi.data.Template;
import com.google.protobuf.Timestamp;
import com.openzeppelin.dex.canton.generated.lib.swap.SwapDirection;
import com.openzeppelin.dex.canton.generated.lib.swap.SwapTerms;
import com.openzeppelin.dex.canton.generated.pool.Pool;
import com.openzeppelin.dex.canton.generated.pool.PoolState;
import com.openzeppelin.dex.canton.generated.pool.SwapReceipt;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.Allocation;
import com.openzeppelin.dex.pools.PoolModels.Instrument;
import com.openzeppelin.dex.settlements.SettlementModels.*;
import com.openzeppelin.dex.swaps.SwapModels;
import com.openzeppelin.dex.swaps.SwapModels.Swap;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;

class CantonSettlementFillTest {
  private static final Instant NOW = Instant.parse("2026-09-19T00:00:00Z");
  private static final Instrument BTC = new Instrument("btc-admin", "BTC");
  private static final Instrument USDC = new Instrument("usdc-admin", "USDC");

  @Test
  void mixedDirectionReceiptsCarryEachRequestsOutputInstrumentInBatchOrder() {
    var sellBase = swap(SwapModels.Direction.BaseToQuote, BTC, USDC);
    var sellQuote = swap(SwapModels.Direction.QuoteToBase, USDC, BTC);
    var pending = pending(List.of(sellBase, sellQuote));
    var tx =
        transaction(
            receipt(pending, sellQuote, "0.00123456", SwapDirection.QUOTETOBASE),
            receipt(pending, sellBase, "18.123456", SwapDirection.BASETOQUOTE));
    var result = CantonSettlementLedger.confirm(tx, pending);
    assertThat(result.fills())
        .extracting(Fill::swapId)
        .containsExactly(sellBase.swapId(), sellQuote.swapId());
    assertThat(result.fills()).extracting(Fill::outputInstrument).containsExactly(USDC, BTC);
    assertThat(result.fills())
        .extracting(Fill::amountOut)
        .containsExactly("18.123456", "0.00123456");
  }

  @Test
  void receiptWithAnotherDirectionCannotMislabelThePayment() {
    var swap = swap(SwapModels.Direction.BaseToQuote, BTC, USDC);
    var pending = pending(List.of(swap));
    var tx = transaction(receipt(pending, swap, "18.123456", SwapDirection.QUOTETOBASE));
    assertThatThrownBy(() -> CantonSettlementLedger.confirm(tx, pending))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("Confirmed receipt direction differs from the request");
  }

  private static Pending pending(List<Swap> swaps) {
    UUID id = UUID.randomUUID();
    var settlement =
        new Settlement(
            id,
            "pool",
            Trigger.MANUAL,
            Status.SUBMITTING,
            swaps.stream().map(Swap::swapId).toList(),
            List.of(),
            new Reserves("before-state", "100", "200", "2", "20000"),
            null,
            0,
            NOW,
            NOW,
            null,
            null,
            null);
    return new Pending(settlement, swaps, id, 42, "before-state:config");
  }

  private static Swap swap(SwapModels.Direction direction, Instrument input, Instrument output) {
    UUID id = UUID.randomUUID();
    return new Swap(
        id,
        UUID.randomUUID(),
        "pool",
        "Pool",
        "trader",
        direction,
        input,
        output,
        "1",
        "18",
        "0.003",
        "0",
        NOW.plusSeconds(60),
        SwapModels.Status.SETTLING,
        1L,
        NOW,
        NOW,
        NOW,
        null,
        null,
        List.of("input-" + id, "output-" + id),
        null,
        null,
        null,
        false);
  }

  private static Event receipt(Pending pending, Swap swap, String amount, SwapDirection direction) {
    var receipt =
        new SwapReceipt(
            "dvo",
            "operator",
            swap.trader(),
            new Pool.ContractId(swap.poolId()),
            new Allocation.ContractId(swap.allocationCids().get(0)),
            new Allocation.ContractId(swap.allocationCids().get(1)),
            pending.settlement().settlementId().toString(),
            new SwapTerms(
                swap.swapId().toString(),
                direction,
                new BigDecimal(swap.amountIn()),
                new BigDecimal(swap.minOut()),
                swap.settlementDeadline()),
            new BigDecimal(amount),
            NOW);
    return created("receipt-" + swap.swapId(), SwapReceipt.TEMPLATE_ID_WITH_PACKAGE_ID, receipt);
  }

  private static Transaction transaction(Event... receipts) {
    var state =
        new PoolState(
            new Pool.ContractId("pool"),
            "dvo",
            "operator",
            new BigDecimal("100"),
            new BigDecimal("201"),
            new BigDecimal("1000"),
            Optional.empty());
    return Transaction.newBuilder()
        .setUpdateId("confirmed-update")
        .setOffset(43)
        .setEffectiveAt(Timestamp.newBuilder().setSeconds(NOW.getEpochSecond()))
        .addAllEvents(List.of(receipts))
        .addEvents(created("after-state", PoolState.TEMPLATE_ID_WITH_PACKAGE_ID, state))
        .build();
  }

  private static Event created(String id, Identifier template, Template value) {
    return Event.newBuilder()
        .setCreated(
            CreatedEvent.newBuilder()
                .setContractId(id)
                .setTemplateId(template.toProto())
                .setCreateArguments(value.toValue().toProtoRecord()))
        .build();
  }
}
