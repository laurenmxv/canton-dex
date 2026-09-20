package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.assertThat;

import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.*;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.Metadata;
import com.openzeppelin.dex.tokens.TokenRegistryStore;
import java.math.BigDecimal;
import java.util.*;
import org.junit.jupiter.api.Test;

class CantonTokenBalancesTest {
  @Test
  void keepsSameNamedInstrumentsFromDifferentIssuersSeparate() {
    var lock = new Lock(List.of("operator"), Optional.empty(), Optional.empty(), Optional.empty());
    var balances =
        CantonTokenLedger.balances(
            List.of(
                holding("issuer-a", "USD", "10", Optional.empty()),
                holding("issuer-a", "USD", "2", Optional.of(lock)),
                holding("issuer-b", "USD", "30", Optional.empty()),
                holding("unlisted", "USD", "100", Optional.empty())),
            List.of(
                new TokenRegistryStore.Instrument("issuer-a", "USD", "USD-A", 6),
                new TokenRegistryStore.Instrument("issuer-b", "USD", "USD-B", 8),
                new TokenRegistryStore.Instrument("issuer-b", "BTC", "BTC-B", 8)));
    assertThat(balances).hasSize(3);
    assertThat(balances.get(0).instrument().admin()).isEqualTo("issuer-a");
    assertThat(balances.get(0).available()).isEqualTo("10");
    assertThat(balances.get(0).locked()).isEqualTo("2");
    assertThat(balances.get(0).total()).isEqualTo("12");
    assertThat(balances.get(1).instrument().admin()).isEqualTo("issuer-b");
    assertThat(balances.get(1).available()).isEqualTo("30");
    assertThat(balances.get(2).total()).isEqualTo("0");
  }

  private static HoldingView holding(
      String admin, String instrument, String amount, Optional<Lock> lock) {
    return new HoldingView(
        new Account(Optional.of("trader"), Optional.empty(), ""),
        new InstrumentId(admin, instrument),
        new BigDecimal(amount),
        lock,
        new Metadata(Map.of()));
  }
}
