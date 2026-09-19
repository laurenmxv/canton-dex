package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.CryptoOuterClass.*;
import com.daml.ledger.api.v2.admin.PartyManagementServiceGrpc;
import com.daml.ledger.api.v2.admin.PartyManagementServiceOuterClass.*;
import com.daml.ledger.api.v2.admin.UserManagementServiceGrpc;
import com.daml.ledger.api.v2.admin.UserManagementServiceOuterClass.*;
import com.google.protobuf.ByteString;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import java.util.*;
import java.util.concurrent.TimeUnit;
import tools.jackson.databind.JsonNode;

/** Assert caller rights through the caller token, never the fixture administrator. */
public final class RegistrationAuthorityAssertions {
  private RegistrationAuthorityAssertions() {}

  public static void browserOperatorScope(LedgerConnection transport, String token) {
    var users =
        UserManagementServiceGrpc.newBlockingStub(transport.authenticatedChannel(token))
            .withDeadlineAfter(10, TimeUnit.SECONDS);
    var user =
        users
            .getUser(GetUserRequest.newBuilder().setIdentityProviderId("dex-users").build())
            .getUser();
    assertThat(user.getIdentityProviderId()).isEqualTo("dex-users");
    var rights =
        users
            .listUserRights(
                ListUserRightsRequest.newBuilder().setIdentityProviderId("dex-users").build())
            .getRightsList();
    assertThat(rights)
        .containsExactly(
            Right.newBuilder()
                .setIdentityProviderAdmin(Right.IdentityProviderAdmin.getDefaultInstance())
                .build());
    denied(
        () ->
            users.createUser(
                CreateUserRequest.newBuilder()
                    .setUser(
                        User.newBuilder()
                            .setId("must-not-exist-" + UUID.randomUUID())
                            .setIdentityProviderId("foreign-idp"))
                    .build()));
    // A missing target prevents any privilege mutation even if this authorization check regresses.
    denied(
        () ->
            users.grantUserRights(
                GrantUserRightsRequest.newBuilder()
                    .setUserId("must-not-exist-" + UUID.randomUUID())
                    .setIdentityProviderId("dex-users")
                    .addRights(
                        Right.newBuilder()
                            .setParticipantAdmin(Right.ParticipantAdmin.getDefaultInstance()))
                    .build()));
    // Empty IDP fields normally infer the caller's IDP; reassignment names the source explicitly.
    denied(
        () ->
            users.updateUserIdentityProviderId(
                UpdateUserIdentityProviderIdRequest.newBuilder()
                    .setUserId("must-not-exist-" + UUID.randomUUID())
                    .setSourceIdentityProviderId("")
                    .setTargetIdentityProviderId("dex-users")
                    .build()));
  }

  public static void serviceOnlyActsAsVenue(LedgerConnection transport, String davidParty) {
    var users =
        UserManagementServiceGrpc.newBlockingStub(transport.authenticatedChannel())
            .withDeadlineAfter(10, TimeUnit.SECONDS);
    var user = users.getUser(GetUserRequest.getDefaultInstance()).getUser();
    assertThat(user.getIdentityProviderId()).isEmpty();
    assertThat(user.getPrimaryParty()).isNotBlank().isNotEqualTo(davidParty);
    var rights = users.listUserRights(ListUserRightsRequest.getDefaultInstance()).getRightsList();
    // Existing development volumes may retain read-only governance access from older fixtures.
    assertThat(rights.stream().filter(Right::hasCanActAs).toList())
        .containsExactly(
            Right.newBuilder()
                .setCanActAs(Right.CanActAs.newBuilder().setParty(user.getPrimaryParty()))
                .build());
    assertThat(rights).noneMatch(r -> r.hasParticipantAdmin() || r.hasIdentityProviderAdmin());
    assertThat(rights)
        .noneMatch(r -> r.hasCanReadAs() && r.getCanReadAs().getParty().equals(davidParty));
  }

  public static void cannotAllocateForAnotherUser(
      LedgerConnection transport,
      String token,
      String ownerSubject,
      JsonNode party,
      String signature) {
    var request =
        AllocateExternalPartyRequest.newBuilder()
            .setUserId(ownerSubject)
            .setIdentityProviderId("dex-users")
            .setSynchronizer(party.path("synchronizerId").asString())
            .setWaitForAllocation(true)
            .addMultiHashSignatures(
                Signature.newBuilder()
                    .setFormat(SignatureFormat.SIGNATURE_FORMAT_CONCAT)
                    .setSignature(ByteString.copyFrom(Base64.getDecoder().decode(signature)))
                    .setSignedBy(party.path("publicKeyFingerprint").asString())
                    .setSigningAlgorithmSpec(SigningAlgorithmSpec.SIGNING_ALGORITHM_SPEC_ED25519));
    party
        .path("topologyTransactions")
        .forEach(
            tx ->
                request.addOnboardingTransactions(
                    AllocateExternalPartyRequest.SignedTransaction.newBuilder()
                        .setTransaction(
                            ByteString.copyFrom(Base64.getDecoder().decode(tx.asString())))));
    var parties =
        PartyManagementServiceGrpc.newBlockingStub(transport.authenticatedChannel(token))
            .withDeadlineAfter(10, TimeUnit.SECONDS);
    denied(() -> parties.allocateExternalParty(request.build()));
  }

  private static void denied(Runnable action) {
    assertThatThrownBy(action::run)
        .isInstanceOfSatisfying(
            StatusRuntimeException.class,
            e -> assertThat(e.getStatus().getCode()).isEqualTo(Status.Code.PERMISSION_DENIED));
  }

  public static void ordinaryUser(
      LedgerConnection transport, String token, String subject, String party) {
    var channel = transport.authenticatedChannel(token);
    var users =
        UserManagementServiceGrpc.newBlockingStub(channel).withDeadlineAfter(10, TimeUnit.SECONDS);
    var user =
        users
            .getUser(GetUserRequest.newBuilder().setIdentityProviderId("dex-users").build())
            .getUser();
    assertThat(user.getId()).isEqualTo(subject);
    assertThat(user.getIdentityProviderId()).isEqualTo("dex-users");
    var rights =
        users
            .listUserRights(
                ListUserRightsRequest.newBuilder().setIdentityProviderId("dex-users").build())
            .getRightsList();
    if (party == null) assertThat(rights).isEmpty();
    else
      assertThat(rights)
          .containsExactly(
              Right.newBuilder().setCanActAs(Right.CanActAs.newBuilder().setParty(party)).build());
    denied(
        () ->
            users.grantUserRights(
                GrantUserRightsRequest.newBuilder()
                    .setUserId(subject)
                    .setIdentityProviderId("dex-users")
                    .addRights(
                        Right.newBuilder()
                            .setIdentityProviderAdmin(
                                Right.IdentityProviderAdmin.getDefaultInstance()))
                    .build()));
    assertThatThrownBy(
            () ->
                users.createUser(
                    CreateUserRequest.newBuilder()
                        .setUser(
                            User.newBuilder()
                                .setId("must-not-exist-" + UUID.randomUUID())
                                .setIdentityProviderId("dex-users"))
                        .build()))
        .isInstanceOfSatisfying(
            StatusRuntimeException.class,
            e -> assertThat(e.getStatus().getCode()).isEqualTo(Status.Code.PERMISSION_DENIED));
  }
}
