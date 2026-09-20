package com.openzeppelin.dex.canton;

import java.math.BigDecimal;
import java.math.RoundingMode;

/** Exact decimal counterpart of Lib.Math.swapOutputAtScale. */
final class SwapMath {
  private static final BigDecimal BPS = new BigDecimal("10000");

  private SwapMath() {}

  static BigDecimal amount(String text, int scale, boolean allowZero) {
    if (text == null || !text.matches("(?:0|[1-9][0-9]{0,27})(?:\\.[0-9]{1,10})?"))
      throw new IllegalArgumentException(
          "Use a plain decimal amount with at most 28 integer and ten fractional digits");
    BigDecimal amount = new BigDecimal(text);
    if (amount.signum() < (allowZero ? 0 : 1) || amount.stripTrailingZeros().scale() > scale)
      throw new IllegalArgumentException("Amount must be positive and fit the token precision");
    return amount;
  }

  static BigDecimal output(
      BigDecimal reserveIn,
      BigDecimal reserveOut,
      BigDecimal amountIn,
      BigDecimal feeBps,
      int outputScale) {
    if (outputScale < 0
        || outputScale > 10
        || feeBps.signum() < 0
        || feeBps.compareTo(BPS) >= 0
        || feeBps.stripTrailingZeros().scale() > 0)
      throw new IllegalArgumentException("Unsupported pool fee or token precision");
    for (var amount : new BigDecimal[] {reserveIn, reserveOut, amountIn})
      if (amount.signum() <= 0) throw new IllegalArgumentException("Pool amounts must be positive");
    BigDecimal effective = amountIn.multiply(BPS.subtract(feeBps));
    return reserveOut
        .multiply(effective)
        .divide(reserveIn.multiply(BPS).add(effective), outputScale, RoundingMode.FLOOR);
  }

  static String text(BigDecimal value) {
    return value.stripTrailingZeros().toPlainString();
  }
}
