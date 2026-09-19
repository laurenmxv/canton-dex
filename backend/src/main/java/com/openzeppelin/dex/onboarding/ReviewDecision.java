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
      if (approvedPoolIds.isEmpty()
          || partyHint == null
          || !partyHint.matches("[a-z][a-z0-9_]{0,63}"))
        throw new IllegalArgumentException("Approval requires pools and a valid partyHint");
    } else if (!approvedPoolIds.isEmpty() || partyHint != null)
      throw new IllegalArgumentException("Rejection cannot include pools or a partyHint");
  }
}
