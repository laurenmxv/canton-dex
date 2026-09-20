package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.api.v2.EventOuterClass.InterfaceView;
import com.daml.ledger.javaapi.data.Identifier;
import com.openzeppelin.dex.canton.generated.lib.swap.*;
import com.openzeppelin.dex.canton.generated.lib.tokens.Token;
import com.openzeppelin.dex.canton.generated.pool.Pool;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationinstructionv2.AllocationFactory;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.*;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.InstrumentId;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.AnyContract;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.Metadata;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;

class CantonSwapRequestTest {
  private static final Instant DEADLINE = Instant.parse("2026-09-19T12:00:00Z");
  private static final Metadata EMPTY = new Metadata(Map.of());
  private static final Account BASE = new Account(Optional.of("dvo"), Optional.empty(), "base");
  private static final Account QUOTE = new Account(Optional.of("dvo"), Optional.empty(), "quote");
  private static final SwapRoute<Pool> ROUTE =
      new SwapRoute<>(
          new Pool.ContractId("pool"), "dvo", "operator", token("BTC"), token("USDC"), BASE, QUOTE);

  @Test
  void acceptsSignedNativeLegsAndZeroMinimumWithoutAnyTokenTemplateDependency() {
    for (var direction : List.of(SwapDirection.BASETOQUOTE, SwapDirection.QUOTETOBASE)) {
      for (String minimum : List.of("9", "0")) {
        var request = request(direction, minimum);
        CantonSwapLedger.validateAllocation(
            allocation(request, true, "pool", "10", "trader"), request, ROUTE, true);
        CantonSwapLedger.validateAllocation(
            allocation(request, false, "pool", minimum, "trader"), request, ROUTE, false);
      }
    }
  }

  @Test
  void rejectsAnAllocationBoundToAnotherPoolOrTrader() {
    var request = request(SwapDirection.BASETOQUOTE, "9");
    assertThatThrownBy(
            () ->
                CantonSwapLedger.validateAllocation(
                    allocation(request, true, "another-pool", "10", "trader"),
                    request,
                    ROUTE,
                    true))
        .isInstanceOf(IllegalStateException.class);
    assertThatThrownBy(
            () ->
                CantonSwapLedger.validateAllocation(
                    allocation(request, true, "pool", "10", "another-trader"),
                    request,
                    ROUTE,
                    true))
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  void rejectsChangedInputOrMinimumOutputTermsEvenWhenTheAllocationIdsMatch() {
    var request = request(SwapDirection.BASETOQUOTE, "9");
    assertThatThrownBy(
            () ->
                CantonSwapLedger.validateAllocation(
                    allocation(request, true, "pool", "11", "trader"), request, ROUTE, true))
        .isInstanceOf(IllegalStateException.class);
    assertThatThrownBy(
            () ->
                CantonSwapLedger.validateAllocation(
                    allocation(request, false, "pool", "8", "trader"), request, ROUTE, false))
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  void settlementIdentityBindsBothLegsToTheSameEconomicTerms() {
    var expected = request(SwapDirection.BASETOQUOTE, "9");
    var other =
        new SwapRequest<>(
            expected.poolCid,
            expected.trader,
            new SwapTerms(
                "request",
                SwapDirection.BASETOQUOTE,
                BigDecimal.ONE,
                new BigDecimal("9"),
                DEADLINE),
            expected.inputAllocation,
            expected.outputAllocation);
    assertThatThrownBy(
            () ->
                CantonSwapLedger.validateAllocation(
                    allocation(other, false, "pool", "9", "trader"), expected, ROUTE, false))
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  void settlementIdentityUsesTheSameIntegerUnitsAsDaml() {
    var terms =
        new SwapTerms(
            "request",
            SwapDirection.BASETOQUOTE,
            new BigDecimal("10"),
            new BigDecimal("0.5"),
            Instant.parse("2026-01-01T00:10:00Z"));
    assertThat(CantonSwapLedger.settlementId(terms))
        .isEqualTo("swap:request:BaseToQuote:100000000000:5000000000:1767226200000000");
  }

  @Test
  void settlementIdentityPreservesIntegerUnitsBeyondInt64() {
    var terms =
        new SwapTerms(
            "request",
            SwapDirection.BASETOQUOTE,
            new BigDecimal("1000000000.0000000001"),
            new BigDecimal("9999999999.9999999999"),
            Instant.parse("2026-01-01T00:10:00Z"));
    assertThat(CantonSwapLedger.settlementId(terms))
        .isEqualTo(
            "swap:request:BaseToQuote:10000000000000000001:99999999999999999999:1767226200000000");
  }

  private static SwapRequest<Pool> request(SwapDirection direction, String minimum) {
    return new SwapRequest<>(
        new Pool.ContractId("pool"),
        "trader",
        new SwapTerms(
            "request", direction, new BigDecimal("10"), new BigDecimal(minimum), DEADLINE),
        new Allocation.ContractId("input"),
        new Allocation.ContractId("output"));
  }

  private static Token token(String id) {
    return new Token(
        new InstrumentId("issuer", id),
        new AllocationFactory.ContractId("factory"),
        new SettlementFactory.ContractId("factory"),
        8L);
  }

  private static CreatedEvent allocation(
      SwapRequest<Pool> request, boolean input, String pool, String amount, String trader) {
    boolean base = input == (request.terms.direction == SwapDirection.BASETOQUOTE);
    var sides =
        !input && request.terms.minOut.signum() == 0
            ? List.<TransferLegSide>of()
            : List.of(
                new TransferLegSide(
                    input ? "input" : "minimum-output",
                    input ? TransferSide.SENDERSIDE : TransferSide.RECEIVERSIDE,
                    base ? BASE : QUOTE,
                    new BigDecimal(amount),
                    base ? "BTC" : "USDC",
                    EMPTY));
    var specification =
        new AllocationSpecification(
            "issuer",
            new Account(Optional.of(trader), Optional.empty(), ""),
            sides,
            Optional.of(DEADLINE),
            input ? Optional.empty() : Optional.of(Map.of()),
            true,
            EMPTY);
    var view =
        new AllocationView(
            Optional.empty(),
            new SettlementInfo(
                List.of("dvo", "operator"),
                CantonSwapLedger.settlementId(request.terms),
                Optional.of(new AnyContract.ContractId(pool)),
                EMPTY),
            specification,
            List.of(),
            DEADLINE.minusSeconds(60),
            0L,
            Optional.empty(),
            Map.of(),
            EMPTY);
    return CreatedEvent.newBuilder()
        .setContractId(input ? "input" : "output")
        .setTemplateId(
            new Identifier("independent-token-package", "Issuer", "Allocation").toProto())
        .addInterfaceViews(
            InterfaceView.newBuilder()
                .setInterfaceId(Allocation.INTERFACE_ID_WITH_PACKAGE_ID.toProto())
                .setViewValue(view.toValue().toProtoRecord()))
        .build();
  }
}
