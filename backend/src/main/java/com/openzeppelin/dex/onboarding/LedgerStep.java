package com.openzeppelin.dex.onboarding;

import java.util.UUID;

public record LedgerStep(
    String key, UUID commandId, Status status, String contractId, String updateId, String issuer) {
  public enum Status {
    PENDING,
    SUBMITTING,
    CONFIRMED,
    UNRESOLVED
  }
}
