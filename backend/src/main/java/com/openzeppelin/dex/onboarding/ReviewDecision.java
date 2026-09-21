package com.openzeppelin.dex.onboarding;

import jakarta.validation.constraints.*;
import java.util.*;

public record ReviewDecision(
    @NotNull Decision decision,
    @NotNull @Size(max = 20) List<@NotBlank String> approvedPoolIds,
    String partyHint) {
  public enum Decision {
    APPROVED,
    REJECTED
  }

  public ReviewDecision {
    if (approvedPoolIds != null) approvedPoolIds = List.copyOf(approvedPoolIds);
  }

  public void validate() {
    if (decision == Decision.APPROVED) {
      if (approvedPoolIds.isEmpty())
        throw new IllegalArgumentException("Approval requires pools and a valid partyHint");
      validatePartyHint(partyHint);
    } else if (!approvedPoolIds.isEmpty() || partyHint != null)
      throw new IllegalArgumentException("Rejection cannot include pools or a partyHint");
  }

  static void validatePartyHint(String hint) {
    if (hint == null || !hint.matches("dex_[a-z0-9][a-z0-9_]{0,59}"))
      throw new IllegalArgumentException(
          "Party hint must start with dex_ and contain a name using lowercase letters, digits and underscores (64 characters maximum)");
  }
}
