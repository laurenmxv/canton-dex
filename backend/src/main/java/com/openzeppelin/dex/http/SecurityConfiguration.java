package com.openzeppelin.dex.http;

import com.openzeppelin.dex.iam.*;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.convert.converter.Converter;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.*;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.security.web.SecurityFilterChain;

@Configuration(proxyBeanMethods = false)
public class SecurityConfiguration {
  @Bean
  JwtDecoder jwtDecoder(IamProperties properties) {
    var decoder = NimbusJwtDecoder.withJwkSetUri(properties.jwkSetUri().toString()).build();
    decoder.setJwtValidator(
        new DelegatingOAuth2TokenValidator<>(
            JwtValidators.createDefaultWithIssuer(properties.issuer()),
            new JwtClaimValidator<List<String>>(
                "aud", audiences -> audiences != null && audiences.contains("backend"))));
    return decoder;
  }

  @Bean
  SecurityFilterChain security(HttpSecurity http, AccountDirectory accounts, ApiErrors errors)
      throws Exception {
    return http.csrf(csrf -> csrf.disable())
        .sessionManagement(
            session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(
            auth ->
                auth.requestMatchers("/actuator/health/**")
                    .permitAll()
                    .requestMatchers("/v1/me", "/v1/pools", "/v1/pools/*")
                    .authenticated()
                    .requestMatchers("/v1/admin/**")
                    .hasRole("OPERATOR")
                    .requestMatchers("/v1/onboardings", "/v1/onboardings/**")
                    .hasRole("TRADER")
                    .anyRequest()
                    .denyAll())
        .oauth2ResourceServer(
            oauth ->
                oauth
                    .jwt(
                        jwt ->
                            jwt.jwtAuthenticationConverter(
                                accountAuthenticationConverter(accounts)))
                    .authenticationEntryPoint(
                        (request, response, e) ->
                            errors.write(
                                response,
                                HttpStatus.UNAUTHORIZED,
                                "A valid access token is required")))
        .exceptionHandling(
            exceptions ->
                exceptions
                    .authenticationEntryPoint(
                        (request, response, e) ->
                            errors.write(
                                response,
                                HttpStatus.UNAUTHORIZED,
                                "A valid access token is required"))
                    .accessDeniedHandler(
                        (request, response, e) ->
                            errors.write(
                                response,
                                HttpStatus.FORBIDDEN,
                                "This account cannot perform that operation")))
        .build();
  }

  Converter<Jwt, JwtAuthenticationToken> accountAuthenticationConverter(AccountDirectory accounts) {
    return token -> {
      var account =
          accounts.authenticate(
              token.getIssuer().toString(), token.getSubject(), token.getClaimAsString("name"));
      return new JwtAuthenticationToken(
          token, account, List.of(new SimpleGrantedAuthority("ROLE_" + account.role())));
    };
  }
}
