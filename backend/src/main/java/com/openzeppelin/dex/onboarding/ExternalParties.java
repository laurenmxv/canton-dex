package com.openzeppelin.dex.onboarding;

import com.openzeppelin.dex.iam.Account;
import java.util.List;

/** Wallet-authorized registration: API rights belong to the caller, never the backend. */
public interface ExternalParties {
  record Preparation(
      String partyId,
      String fingerprint,
      String multiHash,
      List<String> transactions,
      String participantId) {}

  void enableUser(Account operator, String accessToken, Account account);

  Preparation prepare(
      String accessToken, String hint, String publicKey, String synchronizer, String participantId);

  void allocate(
      Account caller,
      String accessToken,
      Onboarding.PartyPreparation party,
      List<String> transactions,
      String signature);

  boolean confirmed(String accessToken, Onboarding.PartyPreparation party);
}
