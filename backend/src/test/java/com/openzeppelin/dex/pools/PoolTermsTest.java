package com.openzeppelin.dex.pools;

import static com.openzeppelin.dex.pools.PoolModels.*;
import static org.assertj.core.api.Assertions.*;

import java.util.*;
import org.junit.jupiter.api.Test;

class PoolTermsTest {
  private final Options options =
      new Options(
          "factory",
          "dvo",
          "operator",
          List.of(
              new RegisteredInstrument("a", "A", "A", 6),
              new RegisteredInstrument("a", "USD", "USD", 6),
              new RegisteredInstrument("b", "B", "B", 8),
              new RegisteredInstrument("b", "BTC", "BTC", 8),
              new RegisteredInstrument("b", "USD", "USD", 8)));

  private Create input(Instrument a, Instrument b, String fee) {
    return new Create("A / B", a, b, "base", "quote", "LP", fee, "100", "200", "100");
  }

  @Test
  void pairIdentityIgnoresDirectionButIncludesAdministrators() {
    var a = new Instrument("a", "USD");
    var b = new Instrument("b", "BTC");
    var forward = input(a, b, "30").terms(options);
    var reverse = input(b, a, "30").terms(options);
    assertThat(forward.pairKey()).isEqualTo(reverse.pairKey());
    assertThat(forward.pairKey())
        .isNotEqualTo(input(new Instrument("b", "USD"), b, "30").terms(options).pairKey());
    assertThat(forward.baseAccount().owner()).isEqualTo("dvo");
    assertThat(forward.lpTokenInstrumentId().admin()).isEqualTo("dvo");
  }

  @Test
  void decimalLimitsAndFeesAreEnforcedWithoutFloatingPoint() {
    for (String invalid :
        List.of("1e3", "NaN", "-1", "1.00000000001", "10000000000000000000000000000", " 1"))
      assertThatThrownBy(() -> decimal(invalid)).isInstanceOf(IllegalArgumentException.class);
    assertThat(decimal("9999999999999999999999999999.1234567890"))
        .hasToString("9999999999999999999999999999.1234567890");
    for (String fee : List.of("10000", "-1"))
      assertThatThrownBy(
              () -> input(new Instrument("a", "A"), new Instrument("b", "B"), fee).terms(options))
          .isInstanceOf(IllegalArgumentException.class);
    assertThat(
            input(new Instrument("a", "A"), new Instrument("b", "B"), "0").terms(options).feeBps())
        .isEqualTo("0");
  }

  @Test
  void malformedUnregisteredAndDuplicateInstrumentsAreRejected() {
    for (var pair :
        List.of(
            List.of(new Instrument("outside", "A"), new Instrument("b", "B")),
            List.of(new Instrument("a", "A"), new Instrument("a", "A")),
            List.of(new Instrument("a", "A\nB"), new Instrument("b", "B"))))
      assertThatThrownBy(() -> input(pair.get(0), pair.get(1), "30").terms(options))
          .isInstanceOf(IllegalArgumentException.class);
  }
}
