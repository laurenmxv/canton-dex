package com.openzeppelin.dex.swaps;

public final class SwapFailure extends RuntimeException {
  private final String code;
  private final int status;

  public SwapFailure(String code, String message, int status) {
    super(message);
    this.code = code;
    this.status = status;
  }

  public String code() {
    return code;
  }

  public int status() {
    return status;
  }

  public static SwapFailure conflict(String code, String message) {
    return new SwapFailure(code, message, 409);
  }

  public static SwapFailure unavailable(String message) {
    return new SwapFailure("LEDGER_UNAVAILABLE", message, 503);
  }
}
