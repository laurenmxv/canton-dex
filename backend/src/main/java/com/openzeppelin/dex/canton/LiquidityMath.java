package com.openzeppelin.dex.canton;

import com.openzeppelin.dex.liquidity.LiquidityFailure;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;

/** Exact counterpart of Lib.Math and Lib.Liquidity at the ledger's ten-decimal precision. */
final class LiquidityMath {
  static final BigDecimal MINIMUM = new BigDecimal("0.0000001");
  private static final BigInteger MAX_NUMERIC = BigInteger.TEN.pow(38).subtract(BigInteger.ONE);

  private LiquidityMath() {}

  record Deposit(
      BigDecimal base,
      BigDecimal quote,
      BigDecimal baseRefund,
      BigDecimal quoteRefund,
      BigDecimal lp) {}

  record Withdrawal(BigDecimal base, BigDecimal quote, BigDecimal lp) {}

  static Deposit deposit(
      BigDecimal maxBase,
      BigDecimal maxQuote,
      BigDecimal initialRatio,
      BigDecimal baseReserve,
      BigDecimal quoteReserve,
      BigDecimal supply,
      int baseDecimals,
      int quoteDecimals) {
    BigDecimal base, quote, shares;
    if (supply.signum() == 0) {
      base = maxBase.min(ratio(maxQuote, BigDecimal.ONE, initialRatio, baseDecimals, false));
      quote = ratio(base, initialRatio, BigDecimal.ONE, quoteDecimals, true);
      shares = initialSupply(base, quote).subtract(MINIMUM);
    } else {
      shares =
          ratio(maxBase, supply, baseReserve, 10, false)
              .min(ratio(maxQuote, supply, quoteReserve, 10, false));
      base = ratio(shares, baseReserve, supply, baseDecimals, true);
      quote = ratio(shares, quoteReserve, supply, quoteDecimals, true);
    }
    if (base.signum() <= 0 || quote.signum() <= 0 || shares.signum() <= 0)
      throw new LiquidityFailure(
          "AMOUNT_TOO_SMALL", "Deposit is too small at the pool's precision");
    if (base.compareTo(maxBase) > 0 || quote.compareTo(maxQuote) > 0)
      throw new LiquidityFailure("DEPOSIT_LIMIT", "Deposit exceeds the signed maximum amounts");
    return new Deposit(base, quote, maxBase.subtract(base), maxQuote.subtract(quote), shares);
  }

  static Withdrawal withdraw(
      BigDecimal lp,
      BigDecimal baseReserve,
      BigDecimal quoteReserve,
      BigDecimal supply,
      int baseDecimals,
      int quoteDecimals) {
    if (supply.signum() <= 0 || lp.compareTo(supply.subtract(MINIMUM)) > 0)
      throw new LiquidityFailure("INSUFFICIENT_LP", "Withdrawal exceeds circulating LP supply");
    var base = ratio(lp, baseReserve, supply, baseDecimals, false);
    var quote = ratio(lp, quoteReserve, supply, quoteDecimals, false);
    if (base.signum() <= 0 || quote.signum() <= 0)
      throw new LiquidityFailure(
          "AMOUNT_TOO_SMALL", "Withdrawal is too small at the token precision");
    return new Withdrawal(base, quote, lp);
  }

  static BigDecimal initialSupply(BigDecimal base, BigDecimal quote) {
    return new BigDecimal(checked(units(base).multiply(units(quote))).sqrt(), 10);
  }

  static BigDecimal ratio(
      BigDecimal amount,
      BigDecimal numerator,
      BigDecimal denominator,
      int decimals,
      boolean roundUp) {
    if (decimals < 0 || decimals > 10 || denominator.signum() <= 0)
      throw new IllegalArgumentException("Invalid liquidity ratio");
    var quantum = BigInteger.TEN.pow(10 - decimals);
    var top = checked(units(amount).multiply(units(numerator)));
    var bottom = checked(units(denominator).multiply(quantum));
    var parts = top.divideAndRemainder(bottom);
    var result = roundUp && parts[1].signum() != 0 ? parts[0].add(BigInteger.ONE) : parts[0];
    return new BigDecimal(checked(result.multiply(quantum)), 10);
  }

  static void requireRatio(BigDecimal base, BigDecimal quote, BigDecimal min, BigDecimal max) {
    var quoteUnits = checked(units(quote).multiply(BigInteger.TEN.pow(10)));
    var lower = checked(units(base).multiply(units(min)));
    var upper = checked(units(base).multiply(units(max)));
    if (quoteUnits.compareTo(lower) < 0 || quoteUnits.compareTo(upper) > 0)
      throw new LiquidityFailure("RATIO_LIMIT", "Pool ratio is outside the signed bounds");
  }

  static BigDecimal minimum(BigDecimal expected, int slippageBps, int decimals) {
    return expected
        .multiply(BigDecimal.valueOf(10000L - slippageBps))
        .divide(new BigDecimal("10000"), decimals, RoundingMode.FLOOR);
  }

  private static BigInteger units(BigDecimal amount) {
    return checked(amount.movePointRight(10).toBigIntegerExact());
  }

  private static BigInteger checked(BigInteger value) {
    if (value.signum() < 0 || value.compareTo(MAX_NUMERIC) > 0)
      throw new LiquidityFailure(
          "AMOUNT_TOO_LARGE", "Amounts exceed the ledger's exact arithmetic range");
    return value;
  }
}
