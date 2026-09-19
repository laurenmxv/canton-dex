package com.openzeppelin.dex.onboarding;

import java.util.*;

public interface OnboardingLedger {
  record Confirmation(String contractId, String updateId, String issuer) {}

  String packageId();

  long ledgerEnd();

  Confirmation attest(String commandId, String trader, List<String> poolIds);

  Confirmation grantAccess(String commandId, String trader, String poolId, String attestationId);

  Optional<Confirmation> recover(
      long beginOffset, LedgerStep step, Onboarding onboarding, String attestationId);
}
