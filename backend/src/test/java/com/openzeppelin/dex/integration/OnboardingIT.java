package com.openzeppelin.dex.integration;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import com.openzeppelin.dex.canton.OnboardingLedgerAssertions;
import com.openzeppelin.dex.canton.RegistrationAuthorityAssertions;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "onboarding|all")
class OnboardingIT {
  @Test
  void existingPartyReturnsConflictAndNeverBindsOrIssuesContracts() throws Exception {
    try (var test = new BackendFixture()) {
      String token = test.token(test.trader("existing-party"));
      var created = test.create(token);
      String id = created.path("id").asString(), path = "/v1/onboardings/" + id;
      test.approve(id);
      var key = BackendFixture.keyPair();
      var publicKey = Map.of("publicKey", BackendFixture.publicKey(key));
      var prepared = test.request("POST", path + "/party/prepare", token, publicKey, 200);
      var submission = BackendFixture.sign(key, prepared.path("party"));
      // Register through another user first: the local quota permits one allocation per user.
      String existingOwnerToken = test.token(test.trader("existing-party-owner"));
      var existingOwner = test.create(existingOwnerToken);
      test.approve(existingOwner.path("id").asString());
      String subject =
          test.fixtures
              .sql()
              .sql("SELECT subject FROM accounts WHERE id=?")
              .param(UUID.fromString(existingOwner.path("accountId").asString()))
              .query(String.class)
              .single();
      try (var transport = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
        RegistrationAuthorityAssertions.allocateBeforeBackendSubmission(
            transport,
            existingOwnerToken,
            subject,
            prepared.path("party"),
            submission.get("signature").toString());
      }
      var error = test.request("POST", path + "/party/submit", token, submission, 409);
      assertThat(error.path("code").asString()).isEqualTo("PARTY_ALREADY_EXISTS");
      assertThat(error.path("detail").asString())
          .isEqualTo("This party already exists. Registration was stopped.");
      var conflict = test.request("GET", "/v1/onboardings/mine", token, null, 200);
      assertThat(conflict.path("status").asString()).isEqualTo("PARTY_CONFLICT");
      assertThat(conflict.path("party").path("status").asString()).isEqualTo("CONFLICT");
      assertThat(conflict.path("party").path("confirmed").asBoolean()).isFalse();
      assertThat(conflict.path("ledgerSteps").isEmpty()).isTrue();
      test.request("POST", path + "/party/prepare", token, publicKey, 409);
      test.request("POST", path + "/party/submit", token, submission, 409);
      assertThat(test.request("GET", path, token, null, 200)).isEqualTo(conflict);
      assertThat(test.request("GET", "/v1/me", token, null, 200).path("partyId").isNull()).isTrue();
    }
  }

  @Test
  void approvedNewExternalPartyUsesValidSignatureAndConfirmedLedgerReceipt() throws Exception {
    try (var test = new BackendFixture()) {
      String name = test.trader("david"), token = test.token(name);
      var created = test.create(token);
      String id = created.path("id").asString(), path = "/v1/onboardings/" + id;
      var key = BackendFixture.keyPair();
      var publicKey = Map.of("publicKey", BackendFixture.publicKey(key));
      test.request("POST", path + "/party/prepare", token, publicKey, 409);
      var review =
          Map.of(
              "decision",
              "APPROVED",
              "approvedPoolIds",
              List.of(test.poolId()),
              "partyHint",
              "dex_david_test");
      String reviewPath = "/v1/admin/onboardings/" + id + "/review",
          operator = test.token("operator");
      try (var transport = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
        RegistrationAuthorityAssertions.browserOperatorScope(transport, operator);
      }
      test.request("POST", reviewPath, token, review, 403);
      test.request(
          "POST",
          reviewPath,
          operator,
          Map.of(
              "decision",
              "APPROVED",
              "approvedPoolIds",
              List.of("fake-pool"),
              "partyHint",
              "dex_david_test"),
          400);
      test.request(
          "POST",
          reviewPath,
          operator,
          Map.of(
              "decision",
              "APPROVED",
              "approvedPoolIds",
              List.of(test.poolId()),
              "partyHint",
              "bad name"),
          400);
      test.approve(id);
      String subject =
          test.fixtures
              .sql()
              .sql("SELECT subject FROM accounts WHERE id=?")
              .param(UUID.fromString(created.path("accountId").asString()))
              .query(String.class)
              .single();
      try (var transport = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
        RegistrationAuthorityAssertions.ordinaryUser(transport, token, subject, null);
      }
      var prep = test.request("POST", path + "/party/prepare", token, publicKey, 200);
      assertThat(prep.path("party").path("partyId").asString()).startsWith("dex_david_test::");
      assertThat(test.request("POST", path + "/party/prepare", token, publicKey, 200))
          .isEqualTo(prep);
      test.request(
          "POST",
          path + "/party/prepare",
          token,
          Map.of("publicKey", BackendFixture.publicKey(BackendFixture.keyPair())),
          409);
      test.request(
          "POST",
          path + "/party/submit",
          token,
          BackendFixture.sign(BackendFixture.keyPair(), prep.path("party")),
          400);
      test.request(
          "POST",
          path + "/party/submit",
          token,
          Map.of(
              "preparationId",
              UUID.randomUUID(),
              "signature",
              Base64.getEncoder().encodeToString(new byte[64])),
          409);
      var altered = prep.path("party").deepCopy();
      ((tools.jackson.databind.node.ObjectNode) altered)
          .put("multiHash", Base64.getEncoder().encodeToString(new byte[32]));
      test.request("POST", path + "/party/submit", token, BackendFixture.sign(key, altered), 400);
      var submission = BackendFixture.sign(key, prep.path("party"));
      String foreignToken = test.token(test.trader("foreign-registration"));
      var foreign = test.create(foreignToken);
      test.approve(foreign.path("id").asString());
      try (var transport = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
        RegistrationAuthorityAssertions.cannotAllocateForAnotherUser(
            transport,
            foreignToken,
            subject,
            prep.path("party"),
            submission.get("signature").toString());
      }
      test.request("POST", path + "/party/submit", foreignToken, submission, 404);
      test.request("POST", path + "/party/submit", token, submission, 200);
      var completed = test.completed(token);
      try (var transport = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
        RegistrationAuthorityAssertions.ordinaryUser(
            transport,
            test.token(name),
            subject,
            completed.path("party").path("partyId").asString());
        RegistrationAuthorityAssertions.serviceOnlyActsAsVenue(
            transport, completed.path("party").path("partyId").asString());
        RegistrationAuthorityAssertions.browserOperatorScope(transport, test.token("operator"));
      }
      OnboardingLedgerAssertions.completed(test.fixtures, completed, List.of(test.poolId()));
      assertThat(test.request("POST", path + "/party/submit", token, submission, 200))
          .isEqualTo(completed);
      assertThat(test.request("POST", reviewPath, operator, review, 200)).isEqualTo(completed);
      test.request(
          "POST",
          reviewPath,
          operator,
          Map.of("decision", "REJECTED", "approvedPoolIds", List.of()),
          409);
      assertThat(test.request("GET", "/v1/onboardings/mine", test.token(name), null, 200))
          .isEqualTo(completed);
      assertThat(test.request("GET", "/v1/me", token, null, 200).path("partyId"))
          .isEqualTo(completed.path("party").path("partyId"));
      OnboardingLedgerAssertions.completed(test.fixtures, completed, List.of(test.poolId()));
    }
  }

  @Test
  void rejectedNewAccountNeverRegistersOrEmits() throws Exception {
    try (var test = new BackendFixture()) {
      String name = test.trader("rejected"), token = test.token(name);
      var created = test.create(token);
      String id = created.path("id").asString(), path = "/v1/onboardings/" + id;
      var result =
          test.request(
              "POST",
              "/v1/admin/onboardings/" + id + "/review",
              test.token("operator"),
              Map.of("decision", "REJECTED", "approvedPoolIds", List.of()),
              200);
      assertThat(result.path("status").asString()).isEqualTo("REJECTED");
      assertThat(result.path("party").isNull()).isTrue();
      assertThat(result.path("ledgerSteps").isEmpty()).isTrue();
      test.request(
          "POST",
          path + "/party/prepare",
          token,
          Map.of("publicKey", BackendFixture.publicKey(BackendFixture.keyPair())),
          409);
      assertThat(test.request("GET", "/v1/onboardings/mine", test.token(name), null, 200))
          .isEqualTo(result);
      assertThat(
              test.fixtures
                  .sql()
                  .sql("SELECT count(*) FROM onboarding_steps WHERE onboarding_id=?")
                  .param(UUID.fromString(id))
                  .query(Integer.class)
                  .single())
          .isZero();
      assertThat(test.request("GET", "/v1/me", token, null, 200).path("partyId").isNull()).isTrue();
    }
  }
}
