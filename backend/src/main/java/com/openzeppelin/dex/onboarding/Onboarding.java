package com.openzeppelin.dex.onboarding;

import java.time.Instant;
import java.util.*;

public record Onboarding(
    UUID id,
    UUID accountId,
    OnboardingApplication application,
    String status,
    String partyMode,
    Instant createdAt,
    Review review,
    PartyPreparation party,
    List<LedgerStep> ledgerSteps,
    String suggestedPartyHint) {
  public Onboarding {
    ledgerSteps = List.copyOf(ledgerSteps);
  }

  public record Review(
      ReviewDecision.Decision decision,
      List<String> approvedPoolIds,
      UUID reviewedBy,
      Instant reviewedAt,
      String partyHint) {
    public Review {
      approvedPoolIds = List.copyOf(approvedPoolIds);
    }
  }

  public record PartyPreparation(
      UUID preparationId,
      String partyId,
      boolean confirmed,
      String publicKey,
      String publicKeyFingerprint,
      String multiHash,
      String synchronizerId,
      String status,
      String participantId,
      List<String> topologyTransactions) {
    public PartyPreparation {
      topologyTransactions =
          topologyTransactions == null ? List.of() : List.copyOf(topologyTransactions);
    }
  }
}
