package com.openzeppelin.dex.onboarding;

import static org.assertj.core.api.Assertions.*;

import jakarta.validation.Validation;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class DocumentsTest {
  @Test
  void readsHistoricalReferencesAndRejectsMissingOrRealUploads() {
    var json = JsonMapper.builder().build();
    try (var factory = Validation.buildDefaultValidatorFactory()) {
      var validator = factory.getValidator();
      var old =
          json.readValue(
              "{\"legalName\":\"David\",\"countryCode\":\"AR\",\"documentReferences\":[\"legacy-reference\"]}",
              OnboardingApplication.class);
      assertThat(old.documents()).isEmpty();
      assertThat(validator.validate(old)).isEmpty();
      assertThat(json.writeValueAsString(old)).doesNotContain("documentSelectionValid");
      var empty =
          json.readValue(
              "{\"legalName\":\"David\",\"countryCode\":\"AR\"}", OnboardingApplication.class);
      assertThat(validator.validate(empty)).isNotEmpty();
      var real =
          json.readValue(
              "{\"legalName\":\"David\",\"countryCode\":\"AR\",\"documents\":[{\"id\":\"00000000-0000-0000-0000-000000000001\",\"category\":\"IDENTITY\",\"fileName\":\"test.pdf\",\"mediaType\":\"application/pdf\",\"sizeBytes\":1,\"simulated\":false}]}",
              OnboardingApplication.class);
      assertThat(validator.validate(real)).isNotEmpty();
    }
  }
}
