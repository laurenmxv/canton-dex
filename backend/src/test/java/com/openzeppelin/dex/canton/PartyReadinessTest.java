package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.*;
import com.daml.ledger.api.v2.PackageReferenceOuterClass.*;
import com.daml.ledger.api.v2.PackageServiceOuterClass.*;
import com.daml.ledger.api.v2.StateServiceOuterClass.*;
import com.daml.ledger.api.v2.admin.PartyManagementServiceGrpc;
import com.daml.ledger.api.v2.admin.PartyManagementServiceOuterClass.*;
import com.google.protobuf.Timestamp;
import com.openzeppelin.dex.canton.generated.pool.Pool;
import com.openzeppelin.dex.iam.IamProperties;
import com.openzeppelin.dex.onboarding.Onboarding;
import io.grpc.*;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.stub.StreamObserver;
import java.net.URI;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class PartyReadinessTest {
  private static final String PARTICIPANT = "venue::participant";
  private static final String SYNCHRONIZER = "local::synchronizer";
  private static final String PARTY = "david::key";
  private final List<String> tokens = new CopyOnWriteArrayList<>();
  private final List<String> methods = new CopyOnWriteArrayList<>();
  private String servingParticipant = PARTICIPANT;
  private boolean local = true;
  private boolean denyPartyRead;
  private ParticipantPermission permission =
      ParticipantPermission.PARTICIPANT_PERMISSION_CONFIRMATION;
  private PackageStatus packageStatus = PackageStatus.PACKAGE_STATUS_REGISTERED;
  private VettedPackages vetted =
      vetting(VettedPackage.newBuilder().setPackageId(Pool.PACKAGE_ID).build());
  private Server server;
  private CantonExternalParties parties;

  @BeforeEach
  void startServer() throws Exception {
    server =
        NettyServerBuilder.forPort(0)
            .intercept(
                new ServerInterceptor() {
                  @Override
                  public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                      ServerCall<ReqT, RespT> call,
                      Metadata headers,
                      ServerCallHandler<ReqT, RespT> next) {
                    tokens.add(
                        headers.get(
                            Metadata.Key.of("Authorization", Metadata.ASCII_STRING_MARSHALLER)));
                    methods.add(call.getMethodDescriptor().getBareMethodName());
                    return next.startCall(call, headers);
                  }
                })
            .addService(
                new PartyManagementServiceGrpc.PartyManagementServiceImplBase() {
                  @Override
                  public void getParticipantId(
                      GetParticipantIdRequest request,
                      StreamObserver<GetParticipantIdResponse> observer) {
                    respond(
                        observer,
                        GetParticipantIdResponse.newBuilder()
                            .setParticipantId(servingParticipant)
                            .build());
                  }

                  @Override
                  public void getParties(
                      GetPartiesRequest request, StreamObserver<GetPartiesResponse> observer) {
                    assertThat(request.getPartiesList()).containsExactly(PARTY);
                    assertThat(request.getIdentityProviderId()).isEqualTo("dex-users");
                    if (denyPartyRead) {
                      observer.onError(Status.PERMISSION_DENIED.asRuntimeException());
                      return;
                    }
                    respond(
                        observer,
                        GetPartiesResponse.newBuilder()
                            .addPartyDetails(
                                PartyDetails.newBuilder().setParty(PARTY).setIsLocal(local))
                            .build());
                  }
                })
            .addService(
                new StateServiceGrpc.StateServiceImplBase() {
                  @Override
                  public void getConnectedSynchronizers(
                      GetConnectedSynchronizersRequest request,
                      StreamObserver<GetConnectedSynchronizersResponse> observer) {
                    assertThat(request.getParty()).isEqualTo(PARTY);
                    assertThat(request.getIdentityProviderId()).isEqualTo("dex-users");
                    respond(
                        observer,
                        GetConnectedSynchronizersResponse.newBuilder()
                            .addConnectedSynchronizers(
                                GetConnectedSynchronizersResponse.ConnectedSynchronizer.newBuilder()
                                    .setSynchronizerId(SYNCHRONIZER)
                                    .setPermission(permission))
                            .build());
                  }
                })
            .addService(
                new PackageServiceGrpc.PackageServiceImplBase() {
                  @Override
                  public void getPackageStatus(
                      GetPackageStatusRequest request,
                      StreamObserver<GetPackageStatusResponse> observer) {
                    assertThat(request.getPackageId()).isEqualTo(Pool.PACKAGE_ID);
                    respond(
                        observer,
                        GetPackageStatusResponse.newBuilder()
                            .setPackageStatus(packageStatus)
                            .build());
                  }

                  @Override
                  public void listVettedPackages(
                      ListVettedPackagesRequest request,
                      StreamObserver<ListVettedPackagesResponse> observer) {
                    assertThat(request.getPackageMetadataFilter().getPackageIdsList())
                        .containsExactly(Pool.PACKAGE_ID);
                    assertThat(request.getTopologyStateFilter().getParticipantIdsList())
                        .containsExactly(PARTICIPANT);
                    assertThat(request.getTopologyStateFilter().getSynchronizerIdsList())
                        .containsExactly(SYNCHRONIZER);
                    respond(
                        observer,
                        ListVettedPackagesResponse.newBuilder().addVettedPackages(vetted).build());
                  }
                })
            .build()
            .start();
    // Unreachable token endpoint: readiness must exclusively relay the supplied caller token.
    parties =
        new CantonExternalParties(
            new CantonProperties(
                "127.0.0.1", server.getPort(), URI.create("http://127.0.0.1:1"), "", "", ""),
            new RegistrationProperties("dex-users"),
            new IamProperties("https://identity.test", null));
  }

  @AfterEach
  void closeServer() throws Exception {
    if (parties != null) parties.close();
    if (server != null) server.shutdownNow().awaitTermination();
  }

  @Test
  void confirmedPartyUsesFreshCallerTokenForEveryRead() {
    assertThat(parties.confirmed("first-token", preparation())).isTrue();
    assertThat(parties.confirmed("fresh-token", preparation())).isTrue();
    assertThat(tokens)
        .containsExactly(
            "Bearer first-token",
            "Bearer first-token",
            "Bearer first-token",
            "Bearer first-token",
            "Bearer first-token",
            "Bearer fresh-token",
            "Bearer fresh-token",
            "Bearer fresh-token",
            "Bearer fresh-token",
            "Bearer fresh-token");
    assertThat(methods)
        .containsExactly(
            "GetParticipantId",
            "GetParties",
            "GetConnectedSynchronizers",
            "GetPackageStatus",
            "ListVettedPackages",
            "GetParticipantId",
            "GetParties",
            "GetConnectedSynchronizers",
            "GetPackageStatus",
            "ListVettedPackages");
  }

  @Test
  void anotherServingParticipantCannotConfirmPreparation() {
    servingParticipant = "other::participant";
    assertThat(parties.confirmed("david-token", preparation())).isFalse();
    assertThat(methods).containsExactly("GetParticipantId");
  }

  @Test
  void packageMustBeUploadedEvenIfVetted() {
    packageStatus = PackageStatus.PACKAGE_STATUS_UNSPECIFIED;
    assertThat(parties.confirmed("david-token", preparation())).isFalse();
    assertThat(methods).doesNotContain("ListVettedPackages");
  }

  @Test
  void vettingMustBeEffectiveNow() {
    Instant now = Instant.now();
    vetted =
        vetting(
            VettedPackage.newBuilder()
                .setPackageId(Pool.PACKAGE_ID)
                .setValidFromInclusive(timestamp(now.plusSeconds(120)))
                .build());
    assertThat(parties.confirmed("david-token", preparation())).isFalse();
    vetted =
        vetting(
            VettedPackage.newBuilder()
                .setPackageId(Pool.PACKAGE_ID)
                .setValidUntilExclusive(timestamp(now.minusSeconds(120)))
                .build());
    assertThat(parties.confirmed("david-token", preparation())).isFalse();
    vetted =
        vetting(
            VettedPackage.newBuilder()
                .setPackageId(Pool.PACKAGE_ID)
                .setValidFromInclusive(timestamp(now.minusSeconds(120)))
                .setValidUntilExclusive(timestamp(now.plusSeconds(120)))
                .build());
    assertThat(parties.confirmed("david-token", preparation())).isTrue();
  }

  @Test
  void vettingMustReferToExactParticipantSynchronizerAndPackage() {
    VettedPackages correct = vetted;
    vetted = correct.toBuilder().setParticipantId("other::participant").build();
    assertThat(parties.confirmed("david-token", preparation())).isFalse();
    vetted = correct.toBuilder().setSynchronizerId("other::synchronizer").build();
    assertThat(parties.confirmed("david-token", preparation())).isFalse();
    vetted = vetting(VettedPackage.newBuilder().setPackageId("another-package").build());
    assertThat(parties.confirmed("david-token", preparation())).isFalse();
  }

  @Test
  void localConfirmationHostingIsRequired() {
    local = false;
    assertThat(parties.confirmed("david-token", preparation())).isFalse();
    local = true;
    permission = ParticipantPermission.PARTICIPANT_PERMISSION_SUBMISSION;
    assertThat(parties.confirmed("david-token", preparation())).isFalse();
    permission = ParticipantPermission.PARTICIPANT_PERMISSION_OBSERVATION;
    assertThat(parties.confirmed("david-token", preparation())).isFalse();
  }

  @Test
  void deniedCallerReadDoesNotBecomeConfirmationOrUseAnotherIdentity() {
    denyPartyRead = true;
    assertThatThrownBy(() -> parties.confirmed("david-token", preparation()))
        .isInstanceOf(StatusRuntimeException.class)
        .satisfies(
            e ->
                assertThat(Status.fromThrowable(e).getCode())
                    .isEqualTo(Status.Code.PERMISSION_DENIED));
    assertThat(tokens).containsExactly("Bearer david-token", "Bearer david-token");
  }

  private static VettedPackages vetting(VettedPackage pkg) {
    return VettedPackages.newBuilder()
        .setParticipantId(PARTICIPANT)
        .setSynchronizerId(SYNCHRONIZER)
        .addPackages(pkg)
        .build();
  }

  private static Timestamp timestamp(Instant time) {
    return Timestamp.newBuilder()
        .setSeconds(time.getEpochSecond())
        .setNanos(time.getNano())
        .build();
  }

  private static <T> void respond(StreamObserver<T> observer, T response) {
    observer.onNext(response);
    observer.onCompleted();
  }

  private static Onboarding.PartyPreparation preparation() {
    return new Onboarding.PartyPreparation(
        UUID.randomUUID(),
        PARTY,
        false,
        "key",
        "fingerprint",
        "hash",
        SYNCHRONIZER,
        "PREPARED",
        PARTICIPANT,
        List.of("AQID"));
  }
}
