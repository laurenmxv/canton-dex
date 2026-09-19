package com.openzeppelin.dex.iam;

import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.servlet.function.ServerRequest;

public final class CurrentAccount {
  private CurrentAccount() {}

  public static String accessToken(ServerRequest request) {
    var authentication = (JwtAuthenticationToken) request.principal().orElseThrow();
    return authentication.getToken().getTokenValue();
  }

  public static Account from(ServerRequest request) {
    var authentication = (Authentication) request.principal().orElseThrow();
    return (Account) authentication.getPrincipal();
  }
}
