package com.openzeppelin.dex.integration;

import static org.assertj.core.api.Assertions.*;

import java.util.*;
import java.util.concurrent.*;
import java.util.stream.IntStream;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "iam|all")
class IamIT {
  @Test
  void concurrentFirstRequestsProvisionExactlyOneTraderAndIsolateOwners() throws Exception {
    try (var test = new BackendFixture()) {
      String alice = test.trader("iam"), bob = test.trader("foreign"), token = test.token(alice);
      var ids = new HashSet<String>();
      try (var readers = Executors.newVirtualThreadPerTaskExecutor()) {
        var start = new CountDownLatch(1);
        var results =
            IntStream.range(0, 24)
                .mapToObj(
                    i ->
                        readers.submit(
                            () -> {
                              start.await();
                              return test.request("GET", "/v1/me", token, null, 200);
                            }))
                .toList();
        start.countDown();
        for (var result : results) {
          var profile = result.get(20, TimeUnit.SECONDS);
          ids.add(profile.path("accountId").asString());
          assertThat(profile.path("role").asString()).isEqualTo("TRADER");
          assertThat(profile.path("partyId").isNull()).isTrue();
        }
      }
      assertThat(ids).hasSize(1);
      assertThat(test.request("GET", "/v1/onboardings/mine", token, null, 200).isNull()).isTrue();
      var onboarding = test.create(token);
      String path = "/v1/onboardings/" + onboarding.path("id").asString();
      assertThat(onboarding.path("partyMode").asString()).isEqualTo("external");
      assertThat(test.request("GET", "/v1/onboardings/mine", test.token(alice), null, 200))
          .isEqualTo(onboarding);
      var account =
          test.fixtures
              .sql()
              .sql("SELECT * FROM accounts WHERE id=?")
              .param(UUID.fromString(ids.iterator().next()))
              .query()
              .singleRow();
      assertThat(account.get("role")).isEqualTo("TRADER");
      assertThat(account.get("party_id")).isNull();
      var application =
          test.fixtures
              .sql()
              .sql("SELECT application::text FROM onboardings WHERE id=?")
              .param(UUID.fromString(onboarding.path("id").asString()))
              .query(String.class)
              .single();
      assertThat(test.json.readTree(application)).isEqualTo(onboarding.path("application"));
      var queue = test.request("GET", "/v1/admin/onboardings", test.token("operator"), null, 200);
      assertThat(queue.findValuesAsString("id")).contains(onboarding.path("id").asString());
      test.request("GET", path, null, null, 401);
      test.request("GET", "/v1/me", "invalid", null, 401);
      test.request("GET", "/v1/admin/onboardings", token, null, 403);
      String foreign = test.token(bob);
      test.request("GET", path, foreign, null, 404);
      test.request(
          "POST",
          path + "/party/prepare",
          foreign,
          Map.of("publicKey", BackendFixture.publicKey(BackendFixture.keyPair())),
          404);
      test.request(
          "POST",
          path + "/party/submit",
          foreign,
          Map.of(
              "preparationId",
              UUID.randomUUID(),
              "signature",
              Base64.getEncoder().encodeToString(new byte[64])),
          404);
      assertThat(test.request("GET", "/v1/onboardings/mine", foreign, null, 200).isNull()).isTrue();
      test.request("POST", "/v1/onboardings", foreign, Map.of("legalName", ""), 400);
      test.request("POST", "/v1/onboardings", token, onboarding.path("application"), 409);
      System.out.println(
          "PASS IAM: concurrent provisioning, persisted documents, fresh login and owner isolation.");
    }
  }

  @Test
  void documentMetadataMustBeSimulatedAndUseIntegerSizes() throws Exception {
    try (var test = new BackendFixture()) {
      String token = test.token(test.trader("documents"));
      var document =
          new HashMap<String, Object>(
              Map.of(
                  "id",
                  UUID.randomUUID(),
                  "category",
                  "IDENTITY",
                  "fileName",
                  "test.pdf",
                  "mediaType",
                  "application/pdf",
                  "sizeBytes",
                  1,
                  "simulated",
                  false));
      var request =
          Map.of("legalName", "David Fixture", "countryCode", "AR", "documents", List.of(document));
      test.request("POST", "/v1/onboardings", token, request, 400);
      document.put("simulated", true);
      document.put("sizeBytes", 1.5);
      test.request("POST", "/v1/onboardings", token, request, 400);
      document.put("sizeBytes", 10485761);
      test.request("POST", "/v1/onboardings", token, request, 400);
      assertThat(test.request("GET", "/v1/onboardings/mine", token, null, 200).isNull()).isTrue();
    }
  }
}
