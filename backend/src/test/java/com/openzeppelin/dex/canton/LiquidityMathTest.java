package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.liquidity.LiquidityFailure;
import java.math.BigDecimal;
import org.junit.jupiter.api.Test;

class LiquidityMathTest {
  @Test
  void initializationAndFinalRedemptionKeepThePermanentMinimumBacked() {
    var deposit = LiquidityMath.deposit(d("10"), d("30"), d("2"), d("0"), d("0"), d("0"), 8, 6);
    assertThat(deposit.base()).isEqualByComparingTo("10");
    assertThat(deposit.quote()).isEqualByComparingTo("20");
    assertThat(deposit.quoteRefund()).isEqualByComparingTo("10");
    assertThat(deposit.lp()).isEqualByComparingTo("14.1421355237");
    var supply = deposit.lp().add(LiquidityMath.MINIMUM);
    assertThat(supply).isEqualByComparingTo("14.1421356237");
    assertThat(supply.multiply(supply)).isLessThanOrEqualTo(d("200"));
    assertThat(supply.add(d("0.0000000001")).pow(2)).isGreaterThan(d("200"));
    var withdrawal =
        LiquidityMath.withdraw(deposit.lp(), deposit.base(), deposit.quote(), supply, 8, 6);
    assertThat(deposit.base().subtract(withdrawal.base())).isPositive();
    assertThat(deposit.quote().subtract(withdrawal.quote())).isPositive();
    assertThat(supply.subtract(withdrawal.lp())).isEqualByComparingTo(LiquidityMath.MINIMUM);
  }

  @Test
  void proportionalSharesRoundDownAndRequiredInputsRoundUpWithRefunds() {
    var deposit = LiquidityMath.deposit(d("1"), d("3"), d("2"), d("3"), d("7"), d("5"), 8, 6);
    assertThat(deposit.lp()).isEqualByComparingTo("1.6666666666");
    assertThat(deposit.base()).isEqualByComparingTo("1");
    assertThat(deposit.quote()).isEqualByComparingTo("2.333334");
    assertThat(deposit.quoteRefund()).isEqualByComparingTo("0.666666");
    var withdrawal = LiquidityMath.withdraw(d("1"), d("3"), d("7"), d("5"), 8, 6);
    assertThat(withdrawal.base()).isEqualByComparingTo("0.6");
    assertThat(withdrawal.quote()).isEqualByComparingTo("1.4");
    assertThatThrownBy(() -> LiquidityMath.requireRatio(d("3"), d("7"), d("2"), d("2.3")))
        .isInstanceOf(LiquidityFailure.class);
  }

  @Test
  void arithmeticAcceptsBoundaryProductsAndRejectsOverflowLikeTheLedger() {
    var boundary = d("999999999.9999999999");
    assertThat(LiquidityMath.initialSupply(boundary, boundary)).isEqualByComparingTo(boundary);
    assertThat(
            LiquidityMath.ratio(boundary, boundary, d("1164153218269348144.5847505093"), 10, false))
        .isEqualByComparingTo("0.8589934591");
    assertThat(
            LiquidityMath.ratio(boundary, boundary, d("1164153218269348144.5847505093"), 10, true))
        .isEqualByComparingTo("0.8589934592");
    assertThatThrownBy(() -> LiquidityMath.initialSupply(d("1000000000"), d("1000000000")))
        .isInstanceOfSatisfying(
            LiquidityFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("AMOUNT_TOO_LARGE"));
    assertThatThrownBy(
            () -> LiquidityMath.ratio(d("1000000000"), d("1000000000"), d("1"), 10, false))
        .isInstanceOf(LiquidityFailure.class);
    assertThatThrownBy(
            () ->
                LiquidityMath.deposit(
                    d("0.00000001"), d("0.00000001"), d("1"), d("0"), d("0"), d("0"), 8, 8))
        .isInstanceOfSatisfying(
            LiquidityFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("AMOUNT_TOO_SMALL"));
  }

  private static BigDecimal d(String amount) {
    return new BigDecimal(amount);
  }
}
