package com.openzeppelin.dex.swaps;

/** Only use when Canton has definitively rejected a submission without committing it. */
public final class LedgerRejected extends RuntimeException {
  private final String code;

  public LedgerRejected(String code, String message) {
    super(message);
    this.code = code;
  }

  public String code() {
    return code;
  }
}
