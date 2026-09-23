package com.openzeppelin.dex.liquidity;

public final class LiquidityFailure extends RuntimeException {
  private final String code;

  public LiquidityFailure(String code, String message) {
    super(message);
    this.code = code;
  }

  public String code() {
    return code;
  }
}
