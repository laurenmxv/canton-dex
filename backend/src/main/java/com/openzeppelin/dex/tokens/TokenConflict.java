package com.openzeppelin.dex.tokens;

public final class TokenConflict extends RuntimeException {
  public TokenConflict(String message) {
    super(message);
  }
}
