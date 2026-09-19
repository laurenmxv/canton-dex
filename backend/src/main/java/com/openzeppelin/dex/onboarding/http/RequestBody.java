package com.openzeppelin.dex.onboarding.http;

import jakarta.validation.ConstraintViolationException;
import jakarta.validation.Validator;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.function.ServerRequest;

@Component
public final class RequestBody {
  private final Validator validator;

  public RequestBody(Validator validator) {
    this.validator = validator;
  }

  public <T> T read(ServerRequest request, Class<T> type) throws Exception {
    T body = request.body(type);
    var violations = validator.validate(body);
    if (!violations.isEmpty()) throw new ConstraintViolationException(violations);
    return body;
  }
}
