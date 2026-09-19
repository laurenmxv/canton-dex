package com.openzeppelin.dex.http;

import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.iam.AccountDirectory;
import com.openzeppelin.dex.iam.CurrentAccount;
import java.lang.reflect.Proxy;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.ProviderManager;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.BearerTokenAuthenticationToken;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationProvider;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.servlet.function.ServerRequest;

class AccountAuthenticationTest {
  @Test
  void validatedCallerJwtSurvivesDefaultProviderManagerCredentialErasure() {
    var account =
        new Account(
            UUID.randomUUID(), "https://identity.test", "david-user", "David", Account.Role.TRADER);
    var jwt =
        Jwt.withTokenValue("validated-david-access-token")
            .header("alg", "RS256")
            .issuer(account.issuer())
            .subject(account.subject())
            .audience(List.of("backend"))
            .issuedAt(Instant.now().minusSeconds(10))
            .expiresAt(Instant.now().plusSeconds(120))
            .claim("name", account.displayName())
            .claim("roles", List.of("OPERATOR"))
            .build();
    var accounts =
        new AccountDirectory(null) {
          @Override
          public Account authenticate(String issuer, String subject, String name) {
            assertThat(issuer).isEqualTo(account.issuer());
            assertThat(subject).isEqualTo(account.subject());
            assertThat(name).isEqualTo(account.displayName());
            return account;
          }
        };
    var provider =
        new JwtAuthenticationProvider(
            value -> {
              assertThat(value).isEqualTo(jwt.getTokenValue());
              return jwt;
            });
    provider.setJwtAuthenticationConverter(
        new SecurityConfiguration().accountAuthenticationConverter(accounts));
    var manager = new ProviderManager(provider);
    assertThat(manager.isEraseCredentialsAfterAuthentication()).isTrue();

    Authentication result =
        manager.authenticate(new BearerTokenAuthenticationToken(jwt.getTokenValue()));

    assertThat(result).isInstanceOf(JwtAuthenticationToken.class);
    assertThat(result.isAuthenticated()).isTrue();
    assertThat(result.getPrincipal()).isSameAs(account);
    assertThat(result.getAuthorities())
        .extracting(GrantedAuthority::getAuthority)
        .containsExactly("ROLE_TRADER");
    var request =
        (ServerRequest)
            Proxy.newProxyInstance(
                ServerRequest.class.getClassLoader(),
                new Class<?>[] {ServerRequest.class},
                (proxy, method, arguments) -> {
                  if (method.getName().equals("principal")) return Optional.of(result);
                  throw new UnsupportedOperationException(method.getName());
                });
    assertThat(CurrentAccount.from(request)).isSameAs(account);
    assertThat(CurrentAccount.accessToken(request)).isEqualTo(jwt.getTokenValue());
    assertThat(result.toString()).doesNotContain(jwt.getTokenValue());
  }
}
