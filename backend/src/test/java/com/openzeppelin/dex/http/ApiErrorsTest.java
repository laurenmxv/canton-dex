package com.openzeppelin.dex.http;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.onboarding.PartyAlreadyExists;
import com.openzeppelin.dex.swaps.SwapFailure;
import io.grpc.Status;
import java.lang.reflect.Proxy;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.http.HttpMethod;
import org.springframework.http.ProblemDetail;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.servlet.function.*;
import tools.jackson.databind.json.JsonMapper;

class ApiErrorsTest {
  private final ApiErrors errors = new ApiErrors(JsonMapper.builder().build());
  private final ServerRequest request =
      (ServerRequest)
          Proxy.newProxyInstance(
              ServerRequest.class.getClassLoader(),
              new Class<?>[] {ServerRequest.class},
              (proxy, method, args) ->
                  switch (method.getName()) {
                    case "method" -> HttpMethod.GET;
                    case "path" -> "/v1/admin/monitoring";
                    default -> throw new UnsupportedOperationException(method.getName());
                  });

  @ParameterizedTest
  @EnumSource(
      value = Status.Code.class,
      names = {"UNAVAILABLE", "DEADLINE_EXCEEDED", "CANCELLED", "RESOURCE_EXHAUSTED"})
  void transientParticipantReadsReturnSafe503(Status.Code code) throws Exception {
    var response =
        fail(Status.fromCode(code).withDescription("secret-access-token").asRuntimeException());
    assertThat(response.statusCode().value()).isEqualTo(503);
    var detail = (ProblemDetail) ((EntityResponse<?>) response).entity();
    assertThat(detail.getProperties()).containsEntry("code", "LEDGER_UNAVAILABLE");
    assertThat(detail.getDetail())
        .isEqualTo("The participant is temporarily unavailable; try again");
    assertThat(detail.toString()).doesNotContain("secret-access-token");
  }

  @ParameterizedTest
  @EnumSource(
      value = Status.Code.class,
      names = {"INVALID_ARGUMENT", "FAILED_PRECONDITION", "UNAUTHENTICATED", "PERMISSION_DENIED"})
  void otherRawGrpcFailuresKeepTheirExistingStatus(Status.Code code) throws Exception {
    assertThat(fail(Status.fromCode(code).asRuntimeException()).statusCode().value())
        .isEqualTo(500);
  }

  @Test
  void preservesDomainAuthConflictAndUnknownOutcomeErrors() throws Exception {
    assertThat(fail(new AccessDeniedException("denied")).statusCode().value()).isEqualTo(403);
    for (var failure :
        new SwapFailure[] {
          new SwapFailure("SESSION_EXPIRED", "Sign in again", 401),
          SwapFailure.conflict("POOL_CHANGED", "Pool changed"),
          SwapFailure.unavailable("Confirmation is pending")
        }) {
      var response = fail(failure);
      assertThat(response.statusCode().value()).isEqualTo(failure.status());
      assertThat(((ProblemDetail) ((EntityResponse<?>) response).entity()).getProperties())
          .containsEntry("code", failure.code());
    }
  }

  private ServerResponse fail(RuntimeException failure) throws Exception {
    return errors.filter(
        request,
        ignored -> {
          throw failure;
        });
  }

  @Test
  void duplicatePartyReturnsAnExplicitConflict() throws Exception {
    var response = fail(new PartyAlreadyExists());
    assertThat(response.statusCode().value()).isEqualTo(409);
    var detail = (ProblemDetail) ((EntityResponse<?>) response).entity();
    assertThat(detail.getProperties()).containsEntry("code", "PARTY_ALREADY_EXISTS");
    assertThat(detail.getDetail())
        .isEqualTo("This party already exists. Registration was stopped.");
  }
}
