package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.admin.PartyManagementServiceGrpc;
import com.daml.ledger.api.v2.admin.PartyManagementServiceOuterClass.*;
import com.google.protobuf.Any;
import com.google.rpc.ErrorInfo;
import com.openzeppelin.dex.iam.*;
import com.openzeppelin.dex.onboarding.Onboarding;
import com.openzeppelin.dex.onboarding.PartyAlreadyExists;
import io.grpc.*;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.stub.StreamObserver;
import java.net.URI;
import java.security.KeyPairGenerator;
import java.util.*;
import org.junit.jupiter.api.Test;

class CallerRegistrationTest {
  @Test
  void registrationRelaysEachCallerTokenAndNeverUsesProvisionerCredentials() throws Exception {
    var requests = new ArrayList<AllocateExternalPartyRequest>();
    var tokens = new ArrayList<String>();
    var failure = new java.util.concurrent.atomic.AtomicReference<StatusRuntimeException>();
    var rpc =
        new PartyManagementServiceGrpc.PartyManagementServiceImplBase() {
          @Override
          public void allocateExternalParty(
              AllocateExternalPartyRequest request,
              StreamObserver<AllocateExternalPartyResponse> observer) {
            if (failure.get() != null) {
              observer.onError(failure.get());
              return;
            }
            requests.add(request);
            observer.onNext(
                AllocateExternalPartyResponse.newBuilder().setPartyId("david::key").build());
            observer.onCompleted();
          }
        };
    var server =
        NettyServerBuilder.forPort(0)
            .addService(
                ServerInterceptors.intercept(
                    rpc,
                    new ServerInterceptor() {
                      @Override
                      public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                          ServerCall<ReqT, RespT> call,
                          Metadata headers,
                          ServerCallHandler<ReqT, RespT> next) {
                        tokens.add(
                            headers.get(
                                Metadata.Key.of(
                                    "Authorization", Metadata.ASCII_STRING_MARSHALLER)));
                        return next.startCall(call, headers);
                      }
                    }))
            .build()
            .start();
    // The token endpoint is deliberately unreachable: allocating must only use the supplied bearer.
    var config =
        new CantonProperties(
            "127.0.0.1", server.getPort(), URI.create("http://127.0.0.1:1"), "", "", "");
    var parties =
        new CantonExternalParties(
            config,
            new RegistrationProperties("dex-users"),
            new IamProperties("https://identity.test", null));
    var caller =
        new Account(
            UUID.randomUUID(), "https://identity.test", "david-user", "David", Account.Role.TRADER);
    var party =
        new Onboarding.PartyPreparation(
            UUID.randomUUID(),
            "david::key",
            false,
            Base64.getEncoder()
                .encodeToString(
                    KeyPairGenerator.getInstance("Ed25519")
                        .generateKeyPair()
                        .getPublic()
                        .getEncoded()),
            "fingerprint",
            "hash",
            "synchronizer",
            "PREPARED",
            "participant",
            List.of("AQID"));
    try {
      parties.allocate(caller, "first-token", party, party.topologyTransactions(), "AA==");
      parties.allocate(caller, "fresh-token", party, party.topologyTransactions(), "AA==");
      assertThat(tokens).containsExactly("Bearer first-token", "Bearer fresh-token");
      assertThat(requests)
          .allSatisfy(
              request -> {
                assertThat(request.getUserId()).isEqualTo(caller.subject());
                assertThat(request.getIdentityProviderId()).isEqualTo("dex-users");
                assertThat(request.getOnboardingTransactions(0).getTransaction().toByteArray())
                    .containsExactly(1, 2, 3);
                assertThat(request.getWaitForAllocation()).isTrue();
              });
      assertThatThrownBy(
              () ->
                  parties.allocate(
                      new Account(
                          UUID.randomUUID(),
                          "https://foreign.test",
                          "david-user",
                          "David",
                          Account.Role.TRADER),
                      "foreign-token",
                      party,
                      party.topologyTransactions(),
                      "AA=="))
          .isInstanceOf(IllegalArgumentException.class);
      assertThat(requests).hasSize(2);
      for (var duplicate :
          List.of(
              Status.ALREADY_EXISTS
                  .withDescription("EXTERNAL_PARTY_ALREADY_EXISTS(10,test): Party already exists")
                  .asRuntimeException(),
              Status.INVALID_ARGUMENT
                  .withDescription(
                      "INVALID_ARGUMENT(8,test): EXTERNAL_PARTY_ALREADY_EXISTS(10,test): Party already exists")
                  .asRuntimeException(),
              Status.INVALID_ARGUMENT
                  .withDescription(
                      "INVALID_ARGUMENT(8,test): The submitted request has invalid arguments: Party dex_david_test::1220fa7429be... already exists on synchronizer global-domain::12202c7087a9...")
                  .asRuntimeException(),
              io.grpc.protobuf.StatusProto.toStatusRuntimeException(
                  com.google.rpc.Status.newBuilder()
                      .setCode(Status.Code.ALREADY_EXISTS.value())
                      .addDetails(
                          Any.pack(
                              ErrorInfo.newBuilder()
                                  .setReason("EXTERNAL_PARTY_ALREADY_EXISTS")
                                  .build()))
                      .build()))) {
        failure.set(duplicate);
        assertThatThrownBy(
                () ->
                    parties.allocate(caller, "token", party, party.topologyTransactions(), "AA=="))
            .isInstanceOf(PartyAlreadyExists.class);
      }
      for (var other :
          List.of(
              Status.ALREADY_EXISTS
                  .withDescription("Another resource already exists")
                  .asRuntimeException(),
              Status.INVALID_ARGUMENT.withDescription("Invalid topology").asRuntimeException(),
              Status.UNAVAILABLE.asRuntimeException(),
              Status.DEADLINE_EXCEEDED.asRuntimeException())) {
        failure.set(other);
        assertThatThrownBy(
                () ->
                    parties.allocate(caller, "token", party, party.topologyTransactions(), "AA=="))
            .isInstanceOfSatisfying(
                StatusRuntimeException.class,
                e -> assertThat(e.getStatus().getCode()).isEqualTo(other.getStatus().getCode()));
      }
    } finally {
      parties.close();
      server.shutdownNow().awaitTermination();
    }
  }
}
