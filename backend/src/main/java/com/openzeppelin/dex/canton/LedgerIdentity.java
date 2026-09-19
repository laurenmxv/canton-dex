package com.openzeppelin.dex.canton;

public record LedgerIdentity(String userId, String clientId, String clientSecret) {
  @Override
  public String toString() {
    return "LedgerIdentity[userId=" + userId + ", clientId=" + clientId + "]";
  }
}
