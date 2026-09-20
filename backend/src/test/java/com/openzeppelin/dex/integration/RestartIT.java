package com.openzeppelin.dex.integration;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import com.openzeppelin.dex.canton.OnboardingLedgerAssertions;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import tools.jackson.databind.JsonNode;

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
      var policies = test.json.createArrayNode();
      policies.add(savedPolicy(test, "BTC/USDC", true, 3));
      policies.add(savedPolicy(test, "ETH/USDC", false, 7));
      var state = test.json.createObjectNode();
      state.put("name", name);
      state.set("onboarding", completed);
      state.put("poolId", test.poolId());
      state.set("settlementPolicies", policies);
      // Save both original versions before the first write, including a possibly lost response.
      RestartSwaps.save(test.json, state);
      try {
        for (var policy : policies)
          writePolicy(test, policy, policy, policy.path("original").path("version").asLong());
        RestartSwaps.prepare(test, state);
      } catch (Exception | AssertionError failure) {
        restoreAfterFailure(test, policies, failure);
        throw failure;
      }
    }
  }

  @Test
  @EnabledIfSystemProperty(named = "scenario", matches = "restart-mark-uncertain")
  void markUncertainWhileBackendIsStopped() throws Exception {
    var json = tools.jackson.databind.json.JsonMapper.builder().build();
    var state = json.readTree(Path.of(DevelopmentFixtures.env("DEX_RESTART_STATE")).toFile());
    RestartSwaps.withdrawWhileStopped(json, state);
    // Exceed the submission's 30-second deduplication window before testing recovery.
    Thread.sleep(java.time.Duration.ofSeconds(31));
    try (var fixtures = new DevelopmentFixtures()) {
      assertThat(
              fixtures
                  .sql()
                  .sql(
                      "UPDATE onboarding_steps SET"
                          + " status='SUBMITTING',contract_id=NULL,update_id=NULL,issuer=NULL WHERE"
                          + " onboarding_id=? AND step_key='attestation' AND status='CONFIRMED'")
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
      var policies = state.path("settlementPolicies");
      try {
        String token = test.token(state.path("name").asString());
        var current = test.completed(token);
        assertThat(current).isEqualTo(state.path("onboarding"));
        OnboardingLedgerAssertions.completed(
            test.fixtures, current, List.of(state.path("poolId").asString()));
        RestartSwaps.verify(test, state);
        assertThat(policies.size()).isEqualTo(2);
        for (var expected : policies) {
          var actual = policy(test, expected.path("poolId").asString());
          assertThat(actual.path("automaticEnabled")).isEqualTo(expected.path("automaticEnabled"));
          assertThat(actual.path("batchSize")).isEqualTo(expected.path("batchSize"));
          assertThat(actual.path("version").asLong())
              .isEqualTo(expected.path("writtenVersion").asLong());
        }
      } catch (Exception | AssertionError failure) {
        restoreAfterFailure(test, policies, failure);
        throw failure;
      }
      restorePolicies(test, policies);
    }
  }

  @Test
  @EnabledIfSystemProperty(named = "scenario", matches = "restart-restore")
  void restorePoliciesAfterInterruptedRestart() throws Exception {
    var json = tools.jackson.databind.json.JsonMapper.builder().build();
    var state = json.readTree(Path.of(DevelopmentFixtures.env("DEX_RESTART_STATE")).toFile());
    try (var test = new BackendFixture()) {
      Assertions.assertAll(
          "Reclaim funded requests and restore settings independently",
          () -> RestartSwaps.restore(test, state),
          () -> restorePolicies(test, state.path("settlementPolicies")));
    }
  }

  private JsonNode savedPolicy(BackendFixture test, String pair, boolean automatic, int batchSize)
      throws Exception {
    String poolId =
        test.fixtures
            .sql()
            .sql("SELECT pool_id FROM test_token_pools WHERE pair=?")
            .param(pair)
            .query(String.class)
            .single();
    String operator = test.token("operator");
    assertThat(
            test.request(
                "GET",
                "/v1/admin/settlement-requests?poolId=" + poolId + "&status=active",
                operator,
                null,
                200))
        .as("Restart policy coverage requires an empty fixture queue: %s", pair)
        .isEmpty();
    assertThat(
            test.request("GET", "/v1/admin/monitoring?poolId=" + poolId, operator, null, 200)
                .path("activeSettlement")
                .isNull())
        .isTrue();
    var original = policy(test, poolId);
    assertThat(original.path("maxBatchSize").asInt()).isGreaterThanOrEqualTo(batchSize);
    var saved = test.json.createObjectNode();
    saved.put("poolId", poolId);
    saved.put("automaticEnabled", automatic);
    saved.put("batchSize", batchSize);
    saved.put("writtenVersion", original.path("version").asLong() + 1);
    saved.set("original", original);
    return saved;
  }

  private JsonNode policy(BackendFixture test, String poolId) throws Exception {
    return test.request("GET", policyPath(poolId), test.token("operator"), null, 200);
  }

  private JsonNode writePolicy(BackendFixture test, JsonNode saved, JsonNode values, long version)
      throws Exception {
    return test.request(
        "PUT",
        policyPath(saved.path("poolId").asString()),
        test.token("operator"),
        Map.of(
            "automaticEnabled",
            values.path("automaticEnabled").asBoolean(),
            "batchSize",
            values.path("batchSize").asInt(),
            "expectedVersion",
            version),
        200);
  }

  private void restorePolicies(BackendFixture test, JsonNode policies) {
    var restores = new ArrayList<org.junit.jupiter.api.function.Executable>();
    for (var saved : policies)
      restores.add(
          () -> {
            var current = policy(test, saved.path("poolId").asString());
            var original = saved.path("original");
            // Failed writes and repeated cleanup need no change when the original values remain.
            if (current.path("automaticEnabled").equals(original.path("automaticEnabled"))
                && current.path("batchSize").equals(original.path("batchSize"))) return;
            long writtenVersion = saved.path("writtenVersion").asLong();
            assertThat(current.path("automaticEnabled")).isEqualTo(saved.path("automaticEnabled"));
            assertThat(current.path("batchSize")).isEqualTo(saved.path("batchSize"));
            assertThat(current.path("version").asLong()).isEqualTo(writtenVersion);
            var restored = writePolicy(test, saved, original, writtenVersion);
            assertThat(restored.path("automaticEnabled"))
                .isEqualTo(original.path("automaticEnabled"));
            assertThat(restored.path("batchSize")).isEqualTo(original.path("batchSize"));
          });
    Assertions.assertAll("Restore both restart policy changes independently", restores);
  }

  private void restoreAfterFailure(BackendFixture test, JsonNode policies, Throwable failure) {
    try {
      restorePolicies(test, policies);
    } catch (AssertionError cleanup) {
      failure.addSuppressed(cleanup);
    }
  }

  private String policyPath(String poolId) {
    return "/v1/admin/pools/" + poolId + "/settlement-policy";
  }
}
