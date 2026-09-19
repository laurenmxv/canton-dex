package com.openzeppelin.dex.canton;

import com.daml.ledger.api.v2.admin.*;
import com.daml.ledger.api.v2.admin.IdentityProviderConfigServiceOuterClass.*;
import com.daml.ledger.api.v2.admin.PackageManagementServiceOuterClass.*;
import com.daml.ledger.api.v2.admin.PartyManagementServiceOuterClass.*;
import com.daml.ledger.api.v2.admin.UserManagementServiceOuterClass.*;
import com.google.protobuf.ByteString;
import com.google.protobuf.FieldMask;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Development administration. Never registered as a runtime Spring bean. */
public final class CantonAdmin {
  private final LedgerConnection connection;

  public CantonAdmin(LedgerConnection connection) {
    this.connection = connection;
  }

  public String participantId() {
    return PartyManagementServiceGrpc.newBlockingStub(connection.authenticatedChannel())
        .withDeadlineAfter(10, TimeUnit.SECONDS)
        .getParticipantId(GetParticipantIdRequest.getDefaultInstance())
        .getParticipantId();
  }

  /** The browser operator can provision ordinary users only within this identity provider. */
  public void ensureBrowserOperator(String id, String issuer, String jwks, String operatorSubject) {
    var configs =
        IdentityProviderConfigServiceGrpc.newBlockingStub(connection.authenticatedChannel())
            .withDeadlineAfter(10, TimeUnit.SECONDS);
    var desired =
        IdentityProviderConfig.newBuilder()
            .setIdentityProviderId(id)
            .setIssuer(issuer)
            .setJwksUrl(jwks)
            .setAudience("backend")
            .build();
    try {
      configs.createIdentityProviderConfig(
          CreateIdentityProviderConfigRequest.newBuilder()
              .setIdentityProviderConfig(desired)
              .build());
    } catch (StatusRuntimeException e) {
      if (e.getStatus().getCode() != Status.Code.ALREADY_EXISTS) throw e;
      var actual =
          configs
              .getIdentityProviderConfig(
                  GetIdentityProviderConfigRequest.newBuilder().setIdentityProviderId(id).build())
              .getIdentityProviderConfig();
      if (!actual.equals(desired))
        throw new IllegalStateException(
            "Existing DEX identity provider differs from configuration");
    }
    var users =
        UserManagementServiceGrpc.newBlockingStub(connection.authenticatedChannel())
            .withDeadlineAfter(10, TimeUnit.SECONDS);
    var right =
        Right.newBuilder()
            .setIdentityProviderAdmin(Right.IdentityProviderAdmin.getDefaultInstance())
            .build();
    try {
      users.createUser(
          CreateUserRequest.newBuilder()
              .setUser(User.newBuilder().setId(operatorSubject).setIdentityProviderId(id))
              .addRights(right)
              .build());
    } catch (StatusRuntimeException e) {
      if (e.getStatus().getCode() != Status.Code.ALREADY_EXISTS) throw e;
    }
    var rights =
        users
            .listUserRights(
                ListUserRightsRequest.newBuilder()
                    .setUserId(operatorSubject)
                    .setIdentityProviderId(id)
                    .build())
            .getRightsList();
    if (!rights.equals(List.of(right)))
      throw new IllegalStateException(
          "Unexpected browser operator rights; inspect before changing them");
  }

  public String ensureParty(String hint) {
    var stub =
        PartyManagementServiceGrpc.newBlockingStub(connection.authenticatedChannel())
            .withDeadlineAfter(60, TimeUnit.SECONDS);
    var request = ListKnownPartiesRequest.newBuilder().setFilterParty(hint + "::").setPageSize(100);
    var parties = stub.listKnownParties(request.build()).getPartyDetailsList();
    if (!parties.isEmpty()) return parties.getFirst().getParty();
    return stub.allocateParty(AllocatePartyRequest.newBuilder().setPartyIdHint(hint).build())
        .getPartyDetails()
        .getParty();
  }

  public void ensureUser(String userId, String party, List<String> readers) {
    var stub =
        UserManagementServiceGrpc.newBlockingStub(connection.authenticatedChannel())
            .withDeadlineAfter(30, TimeUnit.SECONDS);
    var rights = new ArrayList<Right>();
    rights.add(Right.newBuilder().setCanActAs(Right.CanActAs.newBuilder().setParty(party)).build());
    for (String reader : readers)
      rights.add(
          Right.newBuilder().setCanReadAs(Right.CanReadAs.newBuilder().setParty(reader)).build());
    try {
      stub.createUser(
          CreateUserRequest.newBuilder()
              .setUser(User.newBuilder().setId(userId).setPrimaryParty(party))
              .addAllRights(rights)
              .build());
    } catch (StatusRuntimeException e) {
      if (e.getStatus().getCode() != Status.Code.ALREADY_EXISTS) throw e;
      stub.updateUser(
          UpdateUserRequest.newBuilder()
              .setUser(User.newBuilder().setId(userId).setPrimaryParty(party))
              .setUpdateMask(FieldMask.newBuilder().addPaths("primary_party"))
              .build());
      stub.grantUserRights(
          GrantUserRightsRequest.newBuilder().setUserId(userId).addAllRights(rights).build());
    }
  }

  public void uploadAndVet(Path dar) throws IOException {
    PackageManagementServiceGrpc.newBlockingStub(connection.authenticatedChannel())
        .withDeadlineAfter(120, TimeUnit.SECONDS)
        .uploadDarFile(
            UploadDarFileRequest.newBuilder()
                .setDarFile(ByteString.copyFrom(Files.readAllBytes(dar)))
                .setVettingChange(
                    UploadDarFileRequest.VettingChange.VETTING_CHANGE_VET_ALL_PACKAGES)
                .build());
  }

  public List<Right> rights(String userId) {
    return UserManagementServiceGrpc.newBlockingStub(connection.authenticatedChannel())
        .withDeadlineAfter(10, TimeUnit.SECONDS)
        .listUserRights(ListUserRightsRequest.newBuilder().setUserId(userId).build())
        .getRightsList();
  }
}
