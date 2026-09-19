package com.openzeppelin.dex.onboarding;

import jakarta.validation.constraints.*;

public record PartyKey(@NotBlank @Size(max = 200) String publicKey) {}
