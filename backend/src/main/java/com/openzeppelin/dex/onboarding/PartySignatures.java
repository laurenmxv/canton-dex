package com.openzeppelin.dex.onboarding;

import java.security.*;
import java.security.interfaces.EdECPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.*;
import org.bouncycastle.asn1.ASN1ObjectIdentifier;
import org.bouncycastle.asn1.sec.SECObjectIdentifiers;
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo;
import org.bouncycastle.asn1.x9.X9ObjectIdentifiers;
import org.bouncycastle.jce.provider.BouncyCastleProvider;

/** Validates the wallet key and signature; the algorithm comes from the stored SPKI key. */
public final class PartySignatures {
  public enum Algorithm {
    ED25519,
    SECP256K1
  }

  // A local provider keeps secp256k1 support independent of the JVM's global provider order.
  private static final Provider EC_PROVIDER = new BouncyCastleProvider();
  private static final ASN1ObjectIdentifier ED25519_OID = new ASN1ObjectIdentifier("1.3.101.112");

  private PartySignatures() {}

  public static Algorithm algorithm(String encoded) {
    return parse(encoded).algorithm();
  }

  static PublicKey publicKey(String encoded) {
    return parse(encoded).key();
  }

  private record ParsedKey(PublicKey key, Algorithm algorithm) {}

  private static ParsedKey parse(String encoded) {
    try {
      byte[] der = Base64.getDecoder().decode(encoded);
      var info = SubjectPublicKeyInfo.getInstance(der);
      var identifier = info.getAlgorithm();
      PublicKey key;
      Algorithm algorithm;
      if (ED25519_OID.equals(identifier.getAlgorithm())) {
        key = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(der));
        if (!(key instanceof EdECPublicKey ed)
            || !ed.getParams().getName().equals("Ed25519")
            || identifier.getParameters() != null)
          throw new IllegalArgumentException("Expected Ed25519 SPKI public key");
        algorithm = Algorithm.ED25519;
      } else if (X9ObjectIdentifiers.id_ecPublicKey.equals(identifier.getAlgorithm())
          && SECObjectIdentifiers.secp256k1.equals(identifier.getParameters())) {
        key = KeyFactory.getInstance("EC", EC_PROVIDER).generatePublic(new X509EncodedKeySpec(der));
        algorithm = Algorithm.SECP256K1;
      } else {
        throw new IllegalArgumentException("Unsupported signing key");
      }
      if (!Arrays.equals(key.getEncoded(), der))
        throw new IllegalArgumentException("Expected canonical SPKI public key");
      return new ParsedKey(key, algorithm);
    } catch (GeneralSecurityException | IllegalArgumentException e) {
      throw new IllegalArgumentException("Expected canonical Ed25519 or secp256k1 SPKI public key");
    }
  }

  static void verify(Onboarding.PartyPreparation party, String encoded) {
    try {
      byte[] signature = Base64.getDecoder().decode(encoded);
      var parsed = parse(party.publicKey());
      boolean ed25519 = parsed.algorithm() == Algorithm.ED25519;
      if (ed25519 ? signature.length != 64 : signature.length < 8 || signature.length > 72)
        throw new IllegalArgumentException("Invalid signature length");
      var verifier =
          ed25519
              ? Signature.getInstance("Ed25519")
              : Signature.getInstance("SHA256withECDSA", EC_PROVIDER);
      verifier.initVerify(parsed.key());
      verifier.update(Base64.getDecoder().decode(party.multiHash()));
      if (!verifier.verify(signature))
        throw new IllegalArgumentException("Invalid preparation signature");
    } catch (GeneralSecurityException | IllegalArgumentException e) {
      throw new IllegalArgumentException("Invalid preparation signature");
    }
  }
}
