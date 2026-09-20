package com.openzeppelin.dex.canton;

import static com.daml.ledger.api.v2.CommandServiceOuterClass.*;
import static com.daml.ledger.api.v2.StateServiceOuterClass.*;
import static com.daml.ledger.api.v2.UpdateServiceOuterClass.*;
import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.CommandServiceGrpc;
import com.daml.ledger.api.v2.CommandsOuterClass.Commands;
import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.daml.ledger.api.v2.OffsetCheckpointOuterClass;
import com.daml.ledger.api.v2.StateServiceGrpc;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.api.v2.UpdateServiceGrpc;
import com.daml.ledger.javaapi.data.CreateCommand;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.Identifier;
import com.daml.ledger.javaapi.data.codegen.Update;
import com.google.protobuf.ByteString;
import com.google.protobuf.Timestamp;
import com.google.protobuf.UnknownFieldSet;
import com.sun.net.httpserver.HttpServer;
import io.grpc.*;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.stub.StreamObserver;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

class LedgerRecoveryTest {
  private static final Identifier TEMPLATE = new Identifier("package", "Test", "Rules");
  private static final Instant DEADLINE = Instant.parse("2099-01-01T00:00:00Z");

  @Test
  void checkpointProvesProgressWithoutVisibleTransactions() throws Exception {
    try (var fixture = new LedgerFixture()) {
      fixture.updates.add(checkpoint(40, "synchronizer", DEADLINE.plusSeconds(1)));
      var history = fixture.ledger.history(10, "operator");
      assertThat(history.transactions()).isEmpty();
      assertThat(history.recordTime()).contains(DEADLINE.plusSeconds(1));
      assertThat(history.endOffset()).isEqualTo(40);
      assertThat(fixture.request.getBeginExclusive()).isEqualTo(10);
      assertThat(fixture.request.getEndInclusive()).isEqualTo(40);
      assertThat(
              fixture
                  .request
                  .getUpdateFormat()
                  .getIncludeTransactions()
                  .getEventFormat()
                  .getFiltersByPartyMap())
          .containsOnlyKeys("operator");
      assertThat(
              fixture
                  .request
                  .getUpdateFormat()
                  .getIncludeTransactions()
                  .getEventFormat()
                  .getFiltersByPartyOrThrow("operator"))
          .isEqualTo(InterfaceViews.transactionFilter());
    }
  }

  @Test
  void neverUsesAnotherSynchronizerOrCheckpointBeyondSnapshot() throws Exception {
    try (var fixture = new LedgerFixture()) {
      fixture.updates.add(checkpoint(40, "other-synchronizer", DEADLINE.plusSeconds(5)));
      fixture.updates.add(checkpoint(41, "synchronizer", DEADLINE.plusSeconds(5)));
      assertThat(fixture.ledger.history(10, "operator").recordTime()).isEmpty();
    }
  }

  @Test
  void transactionFallbackUsesSameSynchronizerRecordTimeNotLedgerEffectiveTime() throws Exception {
    try (var fixture = new LedgerFixture()) {
      var transaction =
          Transaction.newBuilder()
              .setOffset(30)
              .setSynchronizerId("synchronizer")
              .setRecordTime(timestamp(DEADLINE.minusSeconds(1)))
              .setEffectiveAt(timestamp(DEADLINE.plusSeconds(500)))
              .build();
      fixture.updates.add(GetUpdatesResponse.newBuilder().setTransaction(transaction).build());
      fixture.updates.add(
          GetUpdatesResponse.newBuilder()
              .setTransaction(
                  transaction.toBuilder()
                      .setOffset(35)
                      .setSynchronizerId("other-synchronizer")
                      .setRecordTime(timestamp(DEADLINE.plusSeconds(500))))
              .build());
      var history = fixture.ledger.history(10, "operator");
      assertThat(history.transactions()).hasSize(2);
      assertThat(history.recordTime()).contains(DEADLINE.minusSeconds(1));
    }
  }

  @Test
  void unchangedOffsetOverlapsForCheckpointButDoesNotReplayTransaction() throws Exception {
    try (var fixture = new LedgerFixture()) {
      fixture.updates.add(
          GetUpdatesResponse.newBuilder()
              .setTransaction(
                  Transaction.newBuilder()
                      .setOffset(40)
                      .setSynchronizerId("synchronizer")
                      .setRecordTime(timestamp(DEADLINE.minusSeconds(5))))
              .build());
      fixture.updates.add(checkpoint(40, "synchronizer", DEADLINE.plusSeconds(1)));
      var history = fixture.ledger.history(40, "operator");
      assertThat(fixture.request.getBeginExclusive()).isEqualTo(39);
      assertThat(history.transactions()).isEmpty();
      assertThat(history.recordTime()).contains(DEADLINE.plusSeconds(1));
    }
  }

  @Test
  void interruptedStreamNeverReturnsPartialAbsenceProof() throws Exception {
    try (var fixture = new LedgerFixture()) {
      fixture.updates.add(checkpoint(20, "synchronizer", DEADLINE.plusSeconds(1)));
      fixture.streamFailure = Status.UNAVAILABLE;
      assertThatThrownBy(() -> fixture.ledger.history(10, "operator"))
          .isInstanceOf(StatusRuntimeException.class);
    }
  }

  @Test
  void replayPreservesStoredCommandsDisclosuresOffsetAndUnknownFields() throws Exception {
    try (var fixture = new LedgerFixture()) {
      var disclosure =
          DisclosedContract.newBuilder()
              .setContractId("rules")
              .setTemplateId(TEMPLATE.toProto())
              .setCreatedEventBlob(ByteString.copyFromUtf8("blob"))
              .setSynchronizerId("synchronizer")
              .build();
      var unknown =
          UnknownFieldSet.newBuilder()
              .addField(
                  100,
                  UnknownFieldSet.Field.newBuilder()
                      .addLengthDelimited(ByteString.copyFromUtf8("opaque"))
                      .build())
              .build();
      var built =
          fixture.ledger.storedCommands(
              "batch", "operator", List.of("vault"), command(), 17, List.of(disclosure));
      var stored =
          Commands.parseFrom(
              built.toBuilder()
                  .setUnknownFields(unknown)
                  .setCommands(0, built.getCommands(0).toBuilder().setUnknownFields(unknown))
                  .build()
                  .toByteArray());
      assertThat(fixture.ledger.submitStored(stored).getUpdateId()).isEqualTo("confirmed");
      assertThat(fixture.ledger.submitStored(stored).getUpdateId()).isEqualTo("confirmed");
      assertThat(fixture.submissions).hasSize(2);
      assertThat(stored.getDeduplicationOffset()).isEqualTo(17);
      assertThat(stored.getActAsList()).containsExactly("operator");
      assertThat(stored.getReadAsList()).containsExactly("vault");
      assertThat(stored.getDisclosedContractsList()).containsExactly(disclosure);
      assertThat(stored.getPackageIdSelectionPreferenceList())
          .containsExactly(com.openzeppelin.dex.canton.generated.pool.Pool.PACKAGE_ID);
      assertThat(fixture.submissions)
          .allSatisfy(
              request -> {
                assertThat(
                        request.getCommands().toBuilder().clearSubmissionId().build().toByteArray())
                    .containsExactly(stored.toByteArray());
                assertThat(request.getTransactionFormat().getEventFormat().getFiltersByPartyMap())
                    .containsOnlyKeys("operator", "vault")
                    .allSatisfy(
                        (party, filter) ->
                            assertThat(filter).isEqualTo(InterfaceViews.transactionFilter()));
              });
      assertThat(fixture.submissions.get(0).getCommands().getSubmissionId())
          .isNotEqualTo(fixture.submissions.get(1).getCommands().getSubmissionId());
      assertThat(fixture.tokens).isNotEmpty().allMatch("Bearer service-token"::equals);
    }
  }

  @Test
  void directSubmissionIncludesStandardViewsWithoutPinningAnIssuerPackage() throws Exception {
    try (var fixture = new LedgerFixture()) {
      fixture.ledger.submit("command", "operator", List.of("vault"), command());
      var request = fixture.submissions.getFirst();
      assertThat(request.getCommands().getPackageIdSelectionPreferenceList())
          .containsExactly(com.openzeppelin.dex.canton.generated.pool.Pool.PACKAGE_ID);
      assertThat(request.getTransactionFormat().getEventFormat().getFiltersByPartyMap())
          .containsOnlyKeys("operator", "vault")
          .allSatisfy(
              (party, filter) -> assertThat(filter).isEqualTo(InterfaceViews.transactionFilter()));
    }
  }

  @Test
  void submissionFailureIsPropagatedWithoutRetryOrChangingStoredIntent() throws Exception {
    try (var fixture = new LedgerFixture()) {
      var stored =
          fixture.ledger.storedCommands("batch", "operator", List.of(), command(), 0, List.of());
      for (var status :
          List.of(
              Status.DEADLINE_EXCEEDED,
              Status.ALREADY_EXISTS,
              Status.ABORTED,
              Status.FAILED_PRECONDITION)) {
        fixture.submitFailure = status;
        assertThatThrownBy(() -> fixture.ledger.submitStored(stored))
            .isInstanceOfSatisfying(
                StatusRuntimeException.class,
                failure -> assertThat(failure.getStatus().getCode()).isEqualTo(status.getCode()));
      }
      assertThat(fixture.submissions)
          .hasSize(4)
          .allSatisfy(
              request -> {
                assertThat(request.getCommands().hasDeduplicationOffset()).isTrue();
                assertThat(request.getCommands().getDeduplicationOffset()).isZero();
                assertThat(request.getCommands().getCommandId()).isEqualTo("batch");
              });
    }
  }

  @Test
  void storedCommandRequiresOriginalUserAndOffsetBeforeCallingParticipant() throws Exception {
    try (var fixture = new LedgerFixture()) {
      var stored =
          fixture.ledger.storedCommands("batch", "operator", List.of(), command(), 17, List.of());
      assertThatThrownBy(
              () -> fixture.ledger.submitStored(stored.toBuilder().setUserId("other-user").build()))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(
              () ->
                  fixture.ledger.submitStored(
                      stored.toBuilder().clearDeduplicationOffset().build()))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(
              () ->
                  fixture.ledger.submitStored(
                      stored.toBuilder().setDeduplicationOffset(-1).build()))
          .isInstanceOf(IllegalArgumentException.class);
      assertThat(fixture.submissions).isEmpty();
    }
  }

  private static Update<?> command() {
    return new Update.CreateUpdate<>(
        new CreateCommand(TEMPLATE, new DamlRecord()), created -> "result", Function.identity());
  }

  private static Timestamp timestamp(Instant time) {
    return Timestamp.newBuilder()
        .setSeconds(time.getEpochSecond())
        .setNanos(time.getNano())
        .build();
  }

  private static GetUpdatesResponse checkpoint(long offset, String synchronizer, Instant time) {
    return GetUpdatesResponse.newBuilder()
        .setOffsetCheckpoint(
            OffsetCheckpointOuterClass.OffsetCheckpoint.newBuilder()
                .setOffset(offset)
                .addSynchronizerTimes(
                    OffsetCheckpointOuterClass.SynchronizerTime.newBuilder()
                        .setSynchronizerId(synchronizer)
                        .setRecordTime(timestamp(time))))
        .build();
  }

  private static final class LedgerFixture implements AutoCloseable {
    final HttpServer auth;
    final Server grpc;
    final LedgerConnection ledger;
    final List<GetUpdatesResponse> updates = new ArrayList<>();
    final List<SubmitAndWaitForTransactionRequest> submissions = new ArrayList<>();
    final List<String> tokens = new ArrayList<>();
    GetUpdatesRequest request;
    Status streamFailure;
    Status submitFailure;

    LedgerFixture() throws Exception {
      auth = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      auth.createContext(
          "/token",
          exchange -> {
            byte[] body =
                "{\"access_token\":\"service-token\",\"expires_in\":3600}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (var output = exchange.getResponseBody()) {
              output.write(body);
            }
          });
      auth.start();
      grpc =
          NettyServerBuilder.forAddress(new InetSocketAddress("127.0.0.1", 0))
              .intercept(
                  new ServerInterceptor() {
                    @Override
                    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                        ServerCall<ReqT, RespT> call,
                        io.grpc.Metadata headers,
                        ServerCallHandler<ReqT, RespT> next) {
                      tokens.add(
                          headers.get(
                              io.grpc.Metadata.Key.of(
                                  "Authorization", io.grpc.Metadata.ASCII_STRING_MARSHALLER)));
                      return next.startCall(call, headers);
                    }
                  })
              .addService(
                  new StateServiceGrpc.StateServiceImplBase() {
                    @Override
                    public void getLedgerEnd(
                        GetLedgerEndRequest request,
                        StreamObserver<GetLedgerEndResponse> observer) {
                      observer.onNext(GetLedgerEndResponse.newBuilder().setOffset(40).build());
                      observer.onCompleted();
                    }

                    @Override
                    public void getConnectedSynchronizers(
                        GetConnectedSynchronizersRequest request,
                        StreamObserver<GetConnectedSynchronizersResponse> observer) {
                      observer.onNext(
                          GetConnectedSynchronizersResponse.newBuilder()
                              .addConnectedSynchronizers(
                                  GetConnectedSynchronizersResponse.ConnectedSynchronizer
                                      .newBuilder()
                                      .setSynchronizerId("synchronizer"))
                              .build());
                      observer.onCompleted();
                    }
                  })
              .addService(
                  new UpdateServiceGrpc.UpdateServiceImplBase() {
                    @Override
                    public void getUpdates(
                        GetUpdatesRequest actual, StreamObserver<GetUpdatesResponse> observer) {
                      request = actual;
                      updates.forEach(observer::onNext);
                      if (streamFailure != null)
                        observer.onError(streamFailure.asRuntimeException());
                      else observer.onCompleted();
                    }
                  })
              .addService(
                  new CommandServiceGrpc.CommandServiceImplBase() {
                    @Override
                    public void submitAndWaitForTransaction(
                        SubmitAndWaitForTransactionRequest request,
                        StreamObserver<SubmitAndWaitForTransactionResponse> observer) {
                      submissions.add(request);
                      if (submitFailure != null) {
                        observer.onError(submitFailure.asRuntimeException());
                        return;
                      }
                      observer.onNext(
                          SubmitAndWaitForTransactionResponse.newBuilder()
                              .setTransaction(Transaction.newBuilder().setUpdateId("confirmed"))
                              .build());
                      observer.onCompleted();
                    }
                  })
              .build()
              .start();
      ledger =
          new LedgerConnection(
              "127.0.0.1",
              grpc.getPort(),
              URI.create("http://127.0.0.1:" + auth.getAddress().getPort() + "/token"),
              new LedgerIdentity("operator-user", "operator", "secret"));
    }

    @Override
    public void close() throws Exception {
      ledger.close();
      grpc.shutdownNow().awaitTermination();
      auth.stop(0);
    }
  }
}
