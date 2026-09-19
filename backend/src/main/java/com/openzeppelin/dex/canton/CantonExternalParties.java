package com.openzeppelin.dex.canton;

import static com.daml.ledger.api.v2.CryptoOuterClass.*;
import static com.daml.ledger.api.v2.admin.PartyManagementServiceOuterClass.*;

import com.daml.ledger.api.v2.*;
import com.daml.ledger.api.v2.admin.PartyManagementServiceGrpc;
import com.daml.ledger.api.v2.admin.UserManagementServiceGrpc;
import com.daml.ledger.api.v2.admin.UserManagementServiceOuterClass.*;
import com.google.protobuf.ByteString;
import com.openzeppelin.dex.canton.generated.pool.Pool;
import com.openzeppelin.dex.iam.*;
import com.openzeppelin.dex.onboarding.*;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import jakarta.annotation.PreDestroy;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Component;

@Component
public final class CantonExternalParties implements ExternalParties {
  private final LedgerConnection registration;

  private final String identityProviderId;
  private final String issuer;

  public CantonExternalParties(
      CantonProperties canton, RegistrationProperties config, IamProperties iam) {
    identityProviderId = config.identityProviderId();
    issuer = iam.issuer();
    registration = new LedgerConnection(canton.host(), canton.port(), null, null);
  }

  private PartyManagementServiceGrpc.PartyManagementServiceBlockingStub stub(String token) {
    return PartyManagementServiceGrpc.newBlockingStub(registration.authenticatedChannel(token))
        .withDeadlineAfter(60, TimeUnit.SECONDS);
  }

  @Override
  public void enableUser(Account operator, String accessToken, Account account) {
    operator.requireRole(Account.Role.OPERATOR);
    if (!issuer.equals(operator.issuer()))
      throw new IllegalArgumentException("Unexpected operator issuer");
    account.requireRole(Account.Role.TRADER);
    if (!issuer.equals(account.issuer()))
      throw new IllegalArgumentException("Unexpected identity issuer");
    var users =
        UserManagementServiceGrpc.newBlockingStub(registration.authenticatedChannel(accessToken))
            .withDeadlineAfter(10, TimeUnit.SECONDS);
    try {
      users.createUser(
          CreateUserRequest.newBuilder()
              .setUser(
                  User.newBuilder()
                      .setId(account.subject())
                      .setIdentityProviderId(identityProviderId))
              .build());
    } catch (StatusRuntimeException e) {
      if (e.getStatus().getCode() != Status.Code.ALREADY_EXISTS) throw e;
      users.getUser(
          GetUserRequest.newBuilder()
              .setUserId(account.subject())
              .setIdentityProviderId(identityProviderId)
              .build());
    }
  }

  @Override
  public Preparation prepare(
      String accessToken,
      String hint,
      String publicKey,
      String synchronizer,
      String participantId) {
    boolean secp256k1 = PartySignatures.algorithm(publicKey) == PartySignatures.Algorithm.SECP256K1;
    var response =
        stub(accessToken)
            .generateExternalPartyTopology(
                GenerateExternalPartyTopologyRequest.newBuilder()
                    .setSynchronizer(synchronizer)
                    .setPartyHint(hint)
                    .setPublicKey(
                        SigningPublicKey.newBuilder()
                            .setFormat(
                                CryptoKeyFormat.CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO)
                            .setKeySpec(
                                secp256k1
                                    ? SigningKeySpec.SIGNING_KEY_SPEC_EC_SECP256K1
                                    : SigningKeySpec.SIGNING_KEY_SPEC_EC_CURVE25519)
                            .setKeyData(bytes(publicKey)))
                    .build());
    if (response.getTopologyTransactionsCount() == 0
        || response.getMultiHash().isEmpty()
        || !response.getPartyId().equals(hint + "::" + response.getPublicKeyFingerprint()))
      throw new IllegalStateException("Invalid generated external topology");
    return new Preparation(
        response.getPartyId(),
        response.getPublicKeyFingerprint(),
        base64(response.getMultiHash()),
        response.getTopologyTransactionsList().stream().map(CantonExternalParties::base64).toList(),
        participantId);
  }

  @Override
  public void allocate(
      Account caller,
      String accessToken,
      Onboarding.PartyPreparation party,
      List<String> transactions,
      String signature) {
    caller.requireRole(Account.Role.TRADER);
    if (!issuer.equals(caller.issuer()))
      throw new IllegalArgumentException("Unexpected identity issuer");
    boolean secp256k1 =
        PartySignatures.algorithm(party.publicKey()) == PartySignatures.Algorithm.SECP256K1;
    var request =
        AllocateExternalPartyRequest.newBuilder()
            .setUserId(caller.subject())
            .setIdentityProviderId(identityProviderId)
            .setSynchronizer(party.synchronizerId())
            .setWaitForAllocation(true)
            .addMultiHashSignatures(
                Signature.newBuilder()
                    .setFormat(
                        secp256k1
                            ? SignatureFormat.SIGNATURE_FORMAT_DER
                            : SignatureFormat.SIGNATURE_FORMAT_CONCAT)
                    .setSignature(bytes(signature))
                    .setSignedBy(party.publicKeyFingerprint())
                    .setSigningAlgorithmSpec(
                        secp256k1
                            ? SigningAlgorithmSpec.SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256
                            : SigningAlgorithmSpec.SIGNING_ALGORITHM_SPEC_ED25519));
    for (String tx : transactions)
      request.addOnboardingTransactions(
          AllocateExternalPartyRequest.SignedTransaction.newBuilder().setTransaction(bytes(tx)));
    var user =
        PartyManagementServiceGrpc.newBlockingStub(registration.authenticatedChannel(accessToken))
            .withDeadlineAfter(60, TimeUnit.SECONDS);
    try {
      if (!user.allocateExternalParty(request.build()).getPartyId().equals(party.partyId()))
        throw new IllegalStateException("Allocated party differs from the signed preparation");
    } catch (StatusRuntimeException e) {
      if (e.getStatus().getCode() == Status.Code.UNAUTHENTICATED
          || e.getStatus().getCode() == Status.Code.PERMISSION_DENIED)
        throw new org.springframework.security.access.AccessDeniedException(
            "User registration authorization was rejected", e);
      throw e;
    }
  }

  @Override
  public boolean confirmed(String accessToken, Onboarding.PartyPreparation party) {
    String participant =
        stub(accessToken)
            .getParticipantId(GetParticipantIdRequest.getDefaultInstance())
            .getParticipantId();
    if (!participant.equals(party.participantId())) return false;
    boolean local =
        stub(accessToken)
            .getParties(
                GetPartiesRequest.newBuilder()
                    .addParties(party.partyId())
                    .setIdentityProviderId(identityProviderId)
                    .build())
            .getPartyDetailsList()
            .stream()
            .anyMatch(p -> p.getParty().equals(party.partyId()) && p.getIsLocal());
    if (!local) return false;
    var hosts =
        StateServiceGrpc.newBlockingStub(registration.authenticatedChannel(accessToken))
            .withDeadlineAfter(10, TimeUnit.SECONDS)
            .getConnectedSynchronizers(
                StateServiceOuterClass.GetConnectedSynchronizersRequest.newBuilder()
                    .setParty(party.partyId())
                    .setIdentityProviderId(identityProviderId)
                    .build());
    boolean external =
        hosts.getConnectedSynchronizersList().stream()
            .anyMatch(
                h ->
                    h.getSynchronizerId().equals(party.synchronizerId())
                        && h.getPermission()
                            == StateServiceOuterClass.ParticipantPermission
                                .PARTICIPANT_PERMISSION_CONFIRMATION);
    if (!external) return false;
    var packages =
        PackageServiceGrpc.newBlockingStub(registration.authenticatedChannel(accessToken))
            .withDeadlineAfter(10, TimeUnit.SECONDS);
    if (packages
            .getPackageStatus(
                PackageServiceOuterClass.GetPackageStatusRequest.newBuilder()
                    .setPackageId(Pool.PACKAGE_ID)
                    .build())
            .getPackageStatus()
        != PackageServiceOuterClass.PackageStatus.PACKAGE_STATUS_REGISTERED) return false;
    var vetted =
        packages.listVettedPackages(
            PackageServiceOuterClass.ListVettedPackagesRequest.newBuilder()
                .setPackageMetadataFilter(
                    PackageServiceOuterClass.PackageMetadataFilter.newBuilder()
                        .addPackageIds(Pool.PACKAGE_ID))
                .setTopologyStateFilter(
                    PackageServiceOuterClass.TopologyStateFilter.newBuilder()
                        .addParticipantIds(participant)
                        .addSynchronizerIds(party.synchronizerId()))
                .build());
    Instant now = Instant.now();
    return vetted.getVettedPackagesList().stream()
        .filter(
            v ->
                v.getParticipantId().equals(participant)
                    && v.getSynchronizerId().equals(party.synchronizerId()))
        .flatMap(v -> v.getPackagesList().stream())
        .anyMatch(
            p ->
                p.getPackageId().equals(Pool.PACKAGE_ID)
                    && (!p.hasValidFromInclusive()
                        || !now.isBefore(instant(p.getValidFromInclusive())))
                    && (!p.hasValidUntilExclusive()
                        || now.isBefore(instant(p.getValidUntilExclusive()))));
  }

  private static Instant instant(com.google.protobuf.Timestamp timestamp) {
    return Instant.ofEpochSecond(timestamp.getSeconds(), timestamp.getNanos());
  }

  private static ByteString bytes(String value) {
    return ByteString.copyFrom(Base64.getDecoder().decode(value));
  }

  private static String base64(ByteString value) {
    return Base64.getEncoder().encodeToString(value.toByteArray());
  }

  @PreDestroy
  public void close() {
    registration.close();
  }
}
