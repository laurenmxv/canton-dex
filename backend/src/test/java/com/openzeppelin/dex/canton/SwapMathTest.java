package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import java.math.BigDecimal;
import java.util.List;
import org.junit.jupiter.api.Test;

class SwapMathTest {
  @Test
  void matchesDamlReferenceVectors() {
    vector(6, "30", "1000000", "500", "1000", "0.498003");
    vector(8, "30", "1000000", "500", "1000", "0.49800349");
    vector(10, "30", "1000000", "500", "1000", "0.4980034905");
    vector(10, "0", "1", "1", "2", "0.6666666666");
    vector(0, "0", "1", "2", "1", "1");
    vector(10, "30", "997", "1000", "1000", "500");
    vector(10, "0", "1000000", "1000000", "1000000", "500000");
  }

  @Test
  void pricesAmountsAndReservesAboveOneMillion() {
    vector(10, "0", "2000000", "6000000", "2000000", "3000000");
    vector(10, "30", "2991000", "6000000", "3000000", "3000000");
    vector(6, "30", "997", "1000", "1000000000", "999.999");
  }

  @Test
  void neverRoundsDustUpToOneTokenQuantum() {
    vector(6, "0", "1000000", "1000000", "0.000001", "0");
    vector(10, "0", "1000000", "1000000", "0.0000000001", "0");
    vector(8, "30", "1", "1", "0.000001", "0.00000099");
    vector(10, "30", "1", "1", "0.000001", "0.0000009969");
  }

  @Test
  void acceptsNativeDecimalAmountsAndEnforcesTokenPrecision() {
    for (var valid : List.of("1000000.0000000001", "1000000000000000000000000000", "0.0000000001"))
      assertThat(SwapMath.amount(valid, 10, false)).isEqualByComparingTo(valid);
    assertThat(SwapMath.amount("0.1000000000", 8, false)).isEqualByComparingTo("0.1");
    assertThat(SwapMath.amount("0", 6, true)).isZero();
    assertThatThrownBy(() -> SwapMath.amount("0.000000001", 8, false))
        .isInstanceOf(IllegalArgumentException.class);
    for (var invalid :
        List.of("0", "-1", "10000000000000000000000000000", "0.00000000001", "1e3", "01", "1 "))
      assertThatThrownBy(() -> SwapMath.amount(invalid, 10, false))
          .as(invalid)
          .isInstanceOf(IllegalArgumentException.class);
  }

  private static void vector(
      int scale, String fee, String reserveIn, String reserveOut, String amount, String expected) {
    assertThat(
            SwapMath.output(
                new BigDecimal(reserveIn),
                new BigDecimal(reserveOut),
                new BigDecimal(amount),
                new BigDecimal(fee),
                scale))
        .isEqualByComparingTo(expected);
  }
}
