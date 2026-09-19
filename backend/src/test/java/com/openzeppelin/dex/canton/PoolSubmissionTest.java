package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.google.protobuf.Any;
import com.google.rpc.ErrorInfo;
import com.openzeppelin.dex.pools.PoolLedger;
import io.grpc.Status;
import io.grpc.protobuf.StatusProto;
import org.junit.jupiter.api.Test;

class PoolSubmissionTest {
  @Test
  void knownRejectionIsDistinctFromTransportFailureAndDuplicateCommand() {
    for (var status :
        new Status[] {Status.PERMISSION_DENIED, Status.UNAUTHENTICATED, Status.INVALID_ARGUMENT})
      assertThatThrownBy(
              () ->
                  CantonPoolLedger.submit(
                      () -> {
                        throw status.asRuntimeException();
                      }))
          .isInstanceOf(PoolLedger.Rejected.class);
    for (var status :
        new Status[] {
          Status.DEADLINE_EXCEEDED,
          Status.CANCELLED,
          Status.UNKNOWN,
          Status.UNAVAILABLE,
          Status.NOT_FOUND,
          Status.ALREADY_EXISTS
        }) {
      var error = status.asRuntimeException();
      assertThatThrownBy(
              () ->
                  CantonPoolLedger.submit(
                      () -> {
                        throw error;
                      }))
          .isSameAs(error);
    }
  }

  @Test
  void missingUpdateDoesNotProveRejectionButMissingInputContractDoes() {
    for (String reason : new String[] {"UPDATE_NOT_FOUND", "CONTRACT_NOT_FOUND"}) {
      var error =
          StatusProto.toStatusRuntimeException(
              com.google.rpc.Status.newBuilder()
                  .setCode(Status.Code.NOT_FOUND.value())
                  .addDetails(Any.pack(ErrorInfo.newBuilder().setReason(reason).build()))
                  .build());
      assertThat(CantonPoolLedger.definitivelyRejected(error))
          .isEqualTo(reason.equals("CONTRACT_NOT_FOUND"));
    }
  }

  @Test
  void cantonDefiniteAnswerIsRespectedWithoutTreatingDuplicateAsFailure() {
    var detail = Any.pack(ErrorInfo.newBuilder().putMetadata("definite_answer", "true").build());
    var error =
        StatusProto.toStatusRuntimeException(
            com.google.rpc.Status.newBuilder()
                .setCode(Status.Code.ABORTED.value())
                .addDetails(detail)
                .build());
    assertThat(CantonPoolLedger.definitivelyRejected(error)).isTrue();
    var duplicate =
        StatusProto.toStatusRuntimeException(
            com.google.rpc.Status.newBuilder()
                .setCode(Status.Code.ALREADY_EXISTS.value())
                .addDetails(detail)
                .build());
    assertThat(CantonPoolLedger.definitivelyRejected(duplicate)).isFalse();
  }
}
