package com.openzeppelin.dex.onboarding;

import static org.assertj.core.api.Assertions.*;

import java.security.*;
import java.security.spec.ECGenParameterSpec;
import java.util.*;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.junit.jupiter.api.Test;

class PartySignaturesTest {
  private static final Provider EC_PROVIDER = new BouncyCastleProvider();

  @Test
  void transactionSignatureUsesExplicitHashInsteadOfOnboardingMultihash() throws Exception {
    var key = ecKey("secp256k1");
    byte[] topologyHash = new byte[34];
    byte[] transactionHash = new byte[32];
    new SecureRandom().nextBytes(topologyHash);
    new SecureRandom().nextBytes(transactionHash);
    var party = preparation(key, topologyHash);
    var signature = ecSign(key, transactionHash);
    String expectedHash = Base64.getEncoder().encodeToString(transactionHash);
    PartySignatures.verify(party, expectedHash, signature);
    assertThatThrownBy(() -> PartySignatures.verify(party, signature))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                PartySignatures.verify(
                    party,
                    expectedHash,
                    ecSign(key, MessageDigest.getInstance("SHA-256").digest(transactionHash))))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void secp256k1DerSignatureCoversOriginalMultihashExactlyOnce() throws Exception {
    var key = ecKey("secp256k1");
    byte[] hash = new byte[34];
    new SecureRandom().nextBytes(hash);
    hash[0] = 0x12;
    hash[1] = 0x20;
    var party = preparation(key, hash);
    assertThat(PartySignatures.algorithm(party.publicKey()))
        .isEqualTo(PartySignatures.Algorithm.SECP256K1);
    var signature = ecSign(key, hash);
    PartySignatures.verify(party, signature);
    assertThatThrownBy(
            () -> PartySignatures.verify(preparation(ecKey("secp256k1"), hash), signature))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                PartySignatures.verify(
                    party, ecSign(key, MessageDigest.getInstance("SHA-256").digest(hash))))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () -> PartySignatures.verify(party, Base64.getEncoder().encodeToString(new byte[64])))
        .isInstanceOf(IllegalArgumentException.class);
    byte[] trailing =
        Arrays.copyOf(
            Base64.getDecoder().decode(signature),
            Base64.getDecoder().decode(signature).length + 1);
    assertThatThrownBy(
            () -> PartySignatures.verify(party, Base64.getEncoder().encodeToString(trailing)))
        .isInstanceOf(IllegalArgumentException.class);
    hash[2] ^= 1;
    assertThatThrownBy(() -> PartySignatures.verify(preparation(key, hash), signature))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void unsupportedCurveAndMalformedSpkiAreRejected() throws Exception {
    var key = ecKey("secp256r1");
    assertThatThrownBy(
            () ->
                PartySignatures.publicKey(
                    Base64.getEncoder().encodeToString(key.getPublic().getEncoded())))
        .isInstanceOf(IllegalArgumentException.class);
    byte[] der = ecKey("secp256k1").getPublic().getEncoded();
    byte[] trailing = Arrays.copyOf(der, der.length + 1);
    for (String encoded :
        List.of(
            "not-base64",
            "",
            Base64.getEncoder().encodeToString(trailing),
            Base64.getEncoder().encodeToString(Arrays.copyOf(der, der.length - 1)))) {
      assertThatThrownBy(() -> PartySignatures.publicKey(encoded))
          .isInstanceOf(IllegalArgumentException.class);
    }
  }

  private static KeyPair ecKey(String curve) throws Exception {
    var generator = KeyPairGenerator.getInstance("EC", EC_PROVIDER);
    generator.initialize(new ECGenParameterSpec(curve));
    return generator.generateKeyPair();
  }

  private static String ecSign(KeyPair key, byte[] hash) throws Exception {
    var signer = Signature.getInstance("SHA256withECDSA", EC_PROVIDER);
    signer.initSign(key.getPrivate());
    signer.update(hash);
    return Base64.getEncoder().encodeToString(signer.sign());
  }

  private static Onboarding.PartyPreparation preparation(KeyPair key, byte[] hash) {
    return new Onboarding.PartyPreparation(
        UUID.randomUUID(),
        "david::fingerprint",
        false,
        Base64.getEncoder().encodeToString(key.getPublic().getEncoded()),
        "fingerprint",
        Base64.getEncoder().encodeToString(hash),
        "synchronizer",
        "PREPARED",
        "participant::test",
        List.of());
  }

  @Test
  void signatureIsBoundToPreparedKeyAndExactHash() throws Exception {
    var key = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    byte[] hash = new byte[32];
    new SecureRandom().nextBytes(hash);
    String encoded = Base64.getEncoder().encodeToString(key.getPublic().getEncoded());
    var party =
        new Onboarding.PartyPreparation(
            UUID.randomUUID(),
            "david::fingerprint",
            false,
            encoded,
            "fingerprint",
            Base64.getEncoder().encodeToString(hash),
            "synchronizer",
            "PREPARED",
            "participant::test",
            java.util.List.of());
    var signer = Signature.getInstance("Ed25519");
    signer.initSign(key.getPrivate());
    signer.update(hash);
    String signed = Base64.getEncoder().encodeToString(signer.sign());
    PartySignatures.verify(party, signed);
    assertThatThrownBy(
            () -> PartySignatures.verify(party, Base64.getEncoder().encodeToString(new byte[64])))
        .isInstanceOf(IllegalArgumentException.class);
    hash[0] ^= 1;
    var altered =
        new Onboarding.PartyPreparation(
            party.preparationId(),
            party.partyId(),
            false,
            encoded,
            "fingerprint",
            Base64.getEncoder().encodeToString(hash),
            "synchronizer",
            "PREPARED",
            "participant::test",
            java.util.List.of());
    assertThatThrownBy(() -> PartySignatures.verify(altered, signed))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                PartySignatures.publicKey(
                    Base64.getEncoder()
                        .encodeToString(
                            KeyPairGenerator.getInstance("RSA")
                                .generateKeyPair()
                                .getPublic()
                                .getEncoded())))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void hintSuggestionProducesValidAsciiAndBoundedIdentifiers() {
    assertThat(OnboardingStore.suggestHint("Dávid Pérez")).isEqualTo("david_perez");
    for (String name : List.of("123", "名字", "a".repeat(120), "- _ ?"))
      assertThat(OnboardingStore.suggestHint(name)).matches("[a-z][a-z0-9_]{0,63}");
  }
}
