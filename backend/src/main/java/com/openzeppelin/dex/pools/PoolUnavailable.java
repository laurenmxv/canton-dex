package com.openzeppelin.dex.pools;

public final class PoolUnavailable extends RuntimeException {
  public PoolUnavailable(String message) {
    super(message);
  }
}
