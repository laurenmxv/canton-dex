package com.openzeppelin.dex.integration;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.canton.OnboardingLedgerAssertions;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "onboarding|all")
class OnboardingUncertaintyIT {
  @Test
  void missingDatabaseConfirmationRecoversTheExactCommandWithoutDuplicateEmission()
      throws Exception {
    try (var test = new BackendFixture()) {
      String name = test.trader("recovery"), token = test.token(name);
      String id = test.create(token).path("id").asString();
      test.approve(id);
      var completed = test.register(id, token);
      // Reproduce the durable state at a crash after ledger commit but before its database
      // confirmation.
      test.fixtures
          .sql()
          .sql(
              "UPDATE onboarding_steps SET status='SUBMITTING',contract_id=NULL,update_id=NULL,issuer=NULL WHERE onboarding_id=? AND step_key='attestation'")
          .param(UUID.fromString(id))
          .update();
      assertThat(test.completed(token)).isEqualTo(completed);
      OnboardingLedgerAssertions.completed(test.fixtures, completed, List.of(test.poolId()));
    }
  }
}
