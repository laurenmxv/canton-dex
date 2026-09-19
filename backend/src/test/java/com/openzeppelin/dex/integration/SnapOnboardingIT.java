package com.openzeppelin.dex.integration;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import com.openzeppelin.dex.canton.OnboardingLedgerAssertions;
import com.openzeppelin.dex.canton.RegistrationAuthorityAssertions;
import java.security.*;
import java.security.spec.ECGenParameterSpec;
import java.util.*;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import tools.jackson.databind.JsonNode;

/**
 * Exercises the Snap's secp256k1 wire format against the local participant, without a browser
 * wallet.
 */
@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "onboarding|all")
class SnapOnboardingIT {
  private static final Provider EC_PROVIDER = new BouncyCastleProvider();

  @Test
  void secp256k1PartyRegistersAsTraderAndProducesConfirmedReceipt() throws Exception {
    try (var test = new BackendFixture()) {
      String name = test.trader("snap-david"), token = test.token(name);
      var created = test.create(token);
      String id = created.path("id").asString(), path = "/v1/onboardings/" + id;
      test.approve(id);
      var generator = KeyPairGenerator.getInstance("EC", EC_PROVIDER);
      generator.initialize(new ECGenParameterSpec("secp256k1"));
      var key = generator.generateKeyPair();
      var input = Map.of("publicKey", BackendFixture.publicKey(key));
      var prepared = test.request("POST", path + "/party/prepare", token, input, 200);
      var party = prepared.path("party");
      byte[] hash = Base64.getDecoder().decode(party.path("multiHash").asString());
      assertThat(hash).hasSize(34).startsWith((byte) 0x12, (byte) 0x20);
      assertThat(test.request("POST", path + "/party/prepare", token, input, 200))
          .isEqualTo(prepared);
      test.request(
          "POST",
          path + "/party/prepare",
          token,
          Map.of("publicKey", BackendFixture.publicKey(generator.generateKeyPair())),
          409);
      test.request(
          "POST",
          path + "/party/submit",
          token,
          sign(generator.generateKeyPair(), party, hash),
          400);
      test.request(
          "POST",
          path + "/party/submit",
          token,
          sign(key, party, MessageDigest.getInstance("SHA-256").digest(hash)),
          400);
      var submission = sign(key, party, hash);
      test.request("POST", path + "/party/submit", token, submission, 200);
      var completed = test.completed(token);
      assertThat(completed.path("party").path("publicKey")).isEqualTo(party.path("publicKey"));
      String subject =
          test.fixtures
              .sql()
              .sql("SELECT subject FROM accounts WHERE id=?")
              .param(UUID.fromString(created.path("accountId").asString()))
              .query(String.class)
              .single();
      try (var transport = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
        RegistrationAuthorityAssertions.ordinaryUser(
            transport,
            test.token(name),
            subject,
            completed.path("party").path("partyId").asString());
        RegistrationAuthorityAssertions.serviceOnlyActsAsVenue(
            transport, completed.path("party").path("partyId").asString());
      }
      OnboardingLedgerAssertions.completed(test.fixtures, completed, List.of(test.poolId()));
      assertThat(test.request("POST", path + "/party/submit", token, submission, 200))
          .isEqualTo(completed);
      assertThat(test.request("GET", "/v1/onboardings/mine", test.token(name), null, 200))
          .isEqualTo(completed);
      OnboardingLedgerAssertions.completed(test.fixtures, completed, List.of(test.poolId()));
    }
  }

  private static Map<String, Object> sign(KeyPair key, JsonNode party, byte[] hash)
      throws Exception {
    var signer = Signature.getInstance("SHA256withECDSA", EC_PROVIDER);
    signer.initSign(key.getPrivate());
    signer.update(hash);
    return Map.of(
        "preparationId",
        party.path("preparationId").asString(),
        "signature",
        Base64.getEncoder().encodeToString(signer.sign()));
  }
}
