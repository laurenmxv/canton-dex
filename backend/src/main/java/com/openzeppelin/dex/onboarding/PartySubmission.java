package com.openzeppelin.dex.onboarding;

import jakarta.validation.constraints.*;
import java.util.UUID;

public record PartySubmission(
    @NotNull UUID preparationId, @NotBlank @Size(max = 100) String signature) {}
