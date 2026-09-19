package com.openzeppelin.dex.pools;

public final class PoolConflict extends RuntimeException {
  public PoolConflict(String message) {
    super(message);
  }
}
