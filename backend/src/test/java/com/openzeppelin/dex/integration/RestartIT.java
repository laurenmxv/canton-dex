package com.openzeppelin.dex.integration;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import com.openzeppelin.dex.canton.OnboardingLedgerAssertions;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

@Tag("integration")
class RestartIT {
  @Test
  @EnabledIfSystemProperty(named = "scenario", matches = "restart-prepare")
  void prepare() throws Exception {
    try (var test = new BackendFixture()) {
      String name = test.trader("restart"),
          token = test.token(name),
          id = test.create(token).path("id").asString();
      test.approve(id);
      var completed = test.register(id, token);
      OnboardingLedgerAssertions.completed(test.fixtures, completed, List.of(test.poolId()));
      test.json.writeValue(
          Path.of(DevelopmentFixtures.env("DEX_RESTART_STATE")).toFile(),
          Map.of("name", name, "onboarding", completed, "poolId", test.poolId()));
    }
  }

  @Test
  @EnabledIfSystemProperty(named = "scenario", matches = "restart-mark-uncertain")
  void markUncertainWhileBackendIsStopped() throws Exception {
    var json = tools.jackson.databind.json.JsonMapper.builder().build();
    var state = json.readTree(Path.of(DevelopmentFixtures.env("DEX_RESTART_STATE")).toFile());
    // Exceed the submission's 30-second deduplication window before testing recovery.
    Thread.sleep(java.time.Duration.ofSeconds(31));
    try (var fixtures = new DevelopmentFixtures()) {
      assertThat(
              fixtures
                  .sql()
                  .sql(
                      "UPDATE onboarding_steps SET status='SUBMITTING',contract_id=NULL,update_id=NULL,issuer=NULL WHERE onboarding_id=? AND step_key='attestation' AND status='CONFIRMED'")
                  .param(UUID.fromString(state.path("onboarding").path("id").asString()))
                  .update())
          .isEqualTo(1);
    }
  }

  @Test
  @EnabledIfSystemProperty(named = "scenario", matches = "restart-verify")
  void verify() throws Exception {
    try (var test = new BackendFixture()) {
      var state =
          test.json.readTree(Path.of(DevelopmentFixtures.env("DEX_RESTART_STATE")).toFile());
      String token = test.token(state.path("name").asString());
      var current = test.completed(token);
      assertThat(current).isEqualTo(state.path("onboarding"));
      OnboardingLedgerAssertions.completed(
          test.fixtures, current, List.of(state.path("poolId").asString()));
    }
  }
}
