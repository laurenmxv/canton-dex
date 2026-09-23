package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.api.v2.EventOuterClass.InterfaceView;
import com.daml.ledger.javaapi.data.Identifier;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Holding;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.HoldingView;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.InstrumentId;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Lock;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.Metadata;
import com.openzeppelin.dex.swaps.SwapFailure;
import java.math.BigDecimal;
import java.util.*;
import org.junit.jupiter.api.Test;

class CantonSwapInputsTest {
  private static final InstrumentId TOKEN = new InstrumentId("issuer", "USDC");

  @Test
  void usesOneLargeHoldingDespiteSixteenEarlierSmallHoldings() {
    var holdings = new ArrayList<CreatedEvent>();
    for (int i = 0; i < 16; i++) holdings.add(holding("a-" + i, "0.01"));
    holdings.add(holding("z-large", "100"));
    assertThat(CantonPools.selectInputs(holdings, "trader", TOKEN, BigDecimal.ONE))
        .extracting(id -> id.contractId)
        .containsExactly("z-large");
  }

  @Test
  void breaksEqualAmountTiesByContractIdRegardlessOfLedgerOrder() {
    var holdings = List.of(holding("c", "1"), holding("b", "2"), holding("a", "2"));
    assertThat(CantonPools.selectInputs(holdings, "trader", TOKEN, new BigDecimal("3")))
        .extracting(id -> id.contractId)
        .containsExactly("a", "b");
    assertThat(CantonPools.selectInputs(holdings.reversed(), "trader", TOKEN, new BigDecimal("3")))
        .extracting(id -> id.contractId)
        .containsExactly("a", "b");
  }

  @Test
  void prefersUnlockedHoldingsAndLeavesLockPolicyToTheTokenFactory() {
    var lock = new Lock(List.of("trader"), Optional.empty(), Optional.empty(), Optional.empty());
    var holdings =
        List.of(
            holding("available", "1"),
            holding("locked", "100", "trader", TOKEN, Optional.of(lock)),
            holding("other-owner", "100", "other-trader", TOKEN, Optional.empty()),
            holding(
                "other-token",
                "100",
                "trader",
                new InstrumentId("issuer", "BTC"),
                Optional.empty()));
    assertThat(CantonPools.selectInputs(holdings, "trader", TOKEN, BigDecimal.ONE))
        .extracting(id -> id.contractId)
        .containsExactly("available");
    assertThat(CantonPools.selectInputs(holdings, "trader", TOKEN, new BigDecimal("2")))
        .extracting(id -> id.contractId)
        .containsExactly("available", "locked");
    assertThatThrownBy(
            () -> CantonPools.selectInputs(holdings, "trader", TOKEN, new BigDecimal("102")))
        .isInstanceOfSatisfying(
            SwapFailure.class, e -> assertThat(e.code()).isEqualTo("INSUFFICIENT_BALANCE"));
  }

  @Test
  void stillRejectsAnInputThatNeedsSeventeenHoldings() {
    var holdings = new ArrayList<CreatedEvent>();
    for (int i = 0; i < 17; i++) holdings.add(holding("holding-" + i, "1"));
    assertThatThrownBy(
            () -> CantonPools.selectInputs(holdings, "trader", TOKEN, new BigDecimal("17")))
        .isInstanceOfSatisfying(
            SwapFailure.class, e -> assertThat(e.code()).isEqualTo("TOO_MANY_HOLDINGS"));
  }

  private static CreatedEvent holding(String id, String amount) {
    return holding(id, amount, "trader", TOKEN, Optional.empty());
  }

  private static CreatedEvent holding(
      String id, String amount, String owner, InstrumentId instrument, Optional<Lock> lock) {
    var view =
        new HoldingView(
            new Account(Optional.of(owner), Optional.empty(), ""),
            instrument,
            new BigDecimal(amount),
            lock,
            new Metadata(Map.of()));
    return CreatedEvent.newBuilder()
        .setContractId(id)
        .setTemplateId(
            new Identifier("issuer-package-" + instrument.admin, "Issuer", "Holding").toProto())
        .addInterfaceViews(
            InterfaceView.newBuilder()
                .setInterfaceId(Holding.INTERFACE_ID_WITH_PACKAGE_ID.toProto())
                .setViewValue(view.toValue().toProtoRecord()))
        .build();
  }
}
