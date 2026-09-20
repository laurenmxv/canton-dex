package com.openzeppelin.dex.canton;

import io.grpc.StatusRuntimeException;

public final class LedgerAvailability {
  private LedgerAvailability() {}

  public static boolean isTransientFailure(Throwable failure) {
    if (!(failure instanceof StatusRuntimeException status)) return false;
    return switch (status.getStatus().getCode()) {
      case UNAVAILABLE, DEADLINE_EXCEEDED, CANCELLED, RESOURCE_EXHAUSTED -> true;
      default -> false;
    };
  }
}
