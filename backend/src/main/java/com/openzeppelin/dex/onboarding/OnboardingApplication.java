package com.openzeppelin.dex.onboarding;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.util.*;

public record OnboardingApplication(
    @NotBlank @Size(max = 120) String legalName,
    @NotNull @Pattern(regexp = "[A-Z]{2}") String countryCode,
    @Size(max = 10) List<@NotBlank @Size(max = 200) String> documentReferences,
    @Size(max = 10) List<@NotNull @Valid Document> documents) {
  public OnboardingApplication {
    documentReferences = documentReferences == null ? List.of() : List.copyOf(documentReferences);
    documents = documents == null ? List.of() : List.copyOf(documents);
  }

  @com.fasterxml.jackson.annotation.JsonIgnore
  @AssertTrue(
      message = "Provide between one and ten distinct simulated documents or historical references")
  public boolean isDocumentSelectionValid() {
    int n = documents.size() + documentReferences.size();
    return n >= 1
        && n <= 10
        && documents.stream().map(Document::id).distinct().count() == documents.size();
  }

  public record Document(
      @NotNull UUID id,
      @NotNull Category category,
      @NotBlank @Size(max = 200) String fileName,
      @NotBlank @Size(max = 120) String mediaType,
      @NotNull @Min(0) @Max(10485760) Long sizeBytes,
      @NotNull @AssertTrue Boolean simulated) {}

  public enum Category {
    IDENTITY,
    ADDRESS,
    OTHER
  }
}
