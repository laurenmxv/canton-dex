package com.openzeppelin.dex.http;

import com.openzeppelin.dex.canton.LedgerAvailability;
import com.openzeppelin.dex.onboarding.OnboardingConflict;
import com.openzeppelin.dex.onboarding.PartyAlreadyExists;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.ConstraintViolationException;
import java.io.IOException;
import java.util.NoSuchElementException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.*;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.function.*;
import tools.jackson.databind.ObjectMapper;

@Component
public final class ApiErrors implements HandlerFilterFunction<ServerResponse, ServerResponse> {
  private static final Logger LOG = LoggerFactory.getLogger(ApiErrors.class);
  private final ObjectMapper json;

  public ApiErrors(ObjectMapper json) {
    this.json = json;
  }

  @Override
  public ServerResponse filter(ServerRequest request, HandlerFunction<ServerResponse> next)
      throws Exception {
    try {
      return next.handle(request);
    } catch (AccessDeniedException e) {
      return problem(HttpStatus.FORBIDDEN, "This account cannot perform that operation");
    } catch (NoSuchElementException e) {
      return problem(HttpStatus.NOT_FOUND, "Resource not found");
    } catch (com.openzeppelin.dex.swaps.SwapFailure e) {
      var detail =
          ProblemDetail.forStatusAndDetail(HttpStatusCode.valueOf(e.status()), e.getMessage());
      detail.setProperty("code", e.code());
      return ServerResponse.status(e.status())
          .contentType(MediaType.APPLICATION_PROBLEM_JSON)
          .body(detail);
    } catch (com.openzeppelin.dex.tokens.TokenConflict e) {
      return problem(HttpStatus.CONFLICT, e.getMessage());
    } catch (ConstraintViolationException
        | IllegalArgumentException
        | HttpMessageNotReadableException e) {
      return problem(HttpStatus.BAD_REQUEST, "Invalid request fields or request body");
    } catch (com.openzeppelin.dex.pools.PoolUnavailable e) {
      return problem(HttpStatus.SERVICE_UNAVAILABLE, e.getMessage());
    } catch (com.openzeppelin.dex.pools.PoolConflict e) {
      return problem(HttpStatus.CONFLICT, e.getMessage());
    } catch (PartyAlreadyExists e) {
      var detail = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, e.getMessage());
      detail.setProperty("code", "PARTY_ALREADY_EXISTS");
      return ServerResponse.status(HttpStatus.CONFLICT)
          .contentType(MediaType.APPLICATION_PROBLEM_JSON)
          .body(detail);
    } catch (OnboardingConflict e) {
      return problem(HttpStatus.CONFLICT, e.getMessage());
    } catch (DuplicateKeyException e) {
      return problem(HttpStatus.CONFLICT, "An onboarding already exists for this account");
    } catch (Exception e) {
      if (LedgerAvailability.isTransientFailure(e)) {
        var detail =
            ProblemDetail.forStatusAndDetail(
                HttpStatus.SERVICE_UNAVAILABLE,
                "The participant is temporarily unavailable; try again");
        detail.setProperty("code", "LEDGER_UNAVAILABLE");
        return ServerResponse.status(HttpStatus.SERVICE_UNAVAILABLE)
            .contentType(MediaType.APPLICATION_PROBLEM_JSON)
            .body(detail);
      }
      LOG.error("Request failed: {} {}", request.method(), request.path(), e);
      return problem(HttpStatus.INTERNAL_SERVER_ERROR, "The request could not be completed");
    }
  }

  private static ServerResponse problem(HttpStatus status, String detail) {
    return ServerResponse.status(status)
        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
        .body(ProblemDetail.forStatusAndDetail(status, detail));
  }

  public void write(HttpServletResponse response, HttpStatus status, String detail)
      throws IOException {
    response.setStatus(status.value());
    response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
    json.writeValue(response.getOutputStream(), ProblemDetail.forStatusAndDetail(status, detail));
  }
}
