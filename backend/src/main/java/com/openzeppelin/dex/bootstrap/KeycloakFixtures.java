package com.openzeppelin.dex.bootstrap;

import com.openzeppelin.dex.canton.LedgerIdentity;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Test accounts and service identities in the isolated development realms. */
public final class KeycloakFixtures implements AutoCloseable {
  private final String baseUrl;
  private final String username;
  private final String password;
  private final HttpClient http =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final JsonMapper json = JsonMapper.builder().build();

  public KeycloakFixtures(String baseUrl, String username, String password) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
  }

  public LedgerIdentity ledgerIdentity(String name) {
    String clientId = "dex-fixture-" + name;
    String secret = "local-fixture-" + name;
    var existing =
        request("GET", "/admin/realms/AppProvider/clients?clientId=" + clientId, null, 200);
    var client =
        Map.ofEntries(
            Map.entry("clientId", clientId),
            Map.entry("enabled", true),
            Map.entry("secret", secret),
            Map.entry("publicClient", false),
            Map.entry("clientAuthenticatorType", "client-secret"),
            Map.entry("serviceAccountsEnabled", true),
            Map.entry("standardFlowEnabled", false),
            Map.entry("directAccessGrantsEnabled", false),
            Map.entry("protocol", "openid-connect"),
            Map.entry("defaultClientScopes", List.of("audience_canton_network", "basic")));
    if (existing.isEmpty()) {
      request("POST", "/admin/realms/AppProvider/clients", client, 201);
      existing =
          request("GET", "/admin/realms/AppProvider/clients?clientId=" + clientId, null, 200);
    }
    String id = existing.get(0).path("id").asString();
    request("PUT", "/admin/realms/AppProvider/clients/" + id, client, 204);
    var user =
        request(
            "GET", "/admin/realms/AppProvider/clients/" + id + "/service-account-user", null, 200);
    return new LedgerIdentity(user.path("id").asString(), clientId, secret);
  }

  public void enableRegistration() {
    var realm =
        (tools.jackson.databind.node.ObjectNode) request("GET", "/admin/realms/Dex", null, 200);
    realm.put("registrationAllowed", true);
    request("PUT", "/admin/realms/Dex", realm, 204);
  }

  public String createTrader(String name) {
    request(
        "POST",
        "/admin/realms/Dex/users",
        Map.ofEntries(
            Map.entry("username", name),
            Map.entry("enabled", true),
            Map.entry("firstName", name),
            Map.entry("lastName", "Fixture"),
            Map.entry("email", name + "@example.test"),
            Map.entry("emailVerified", true),
            Map.entry(
                "credentials",
                List.of(Map.of("type", "password", "value", "test-password", "temporary", false)))),
        201);
    return request("GET", "/admin/realms/Dex/users?exact=true&username=" + name, null, 200)
        .get(0)
        .path("id")
        .asString();
  }

  public String userToken(String name) {
    return token(
        "Dex",
        "client_id=backend-tests&grant_type=password&username="
            + encode(name)
            + "&password=test-password");
  }

  private String token(String realm, String form) {
    var request =
        HttpRequest.newBuilder(
                URI.create(baseUrl + "/realms/" + realm + "/protocol/openid-connect/token"))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .POST(HttpRequest.BodyPublishers.ofString(form))
            .build();
    return send(request, 200).path("access_token").asString();
  }

  private JsonNode request(String method, String path, Object body, int expected) {
    String token =
        token(
            "master",
            "client_id=admin-cli&grant_type=password&username="
                + encode(username)
                + "&password="
                + encode(password));
    var payload =
        body == null
            ? HttpRequest.BodyPublishers.noBody()
            : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body));
    return send(
        HttpRequest.newBuilder(URI.create(baseUrl + path))
            .timeout(Duration.ofSeconds(10))
            .header("Authorization", "Bearer " + token)
            .header("Content-Type", "application/json")
            .method(method, payload)
            .build(),
        expected);
  }

  private JsonNode send(HttpRequest request, int expected) {
    try {
      var response = http.send(request, HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() != expected)
        throw new IllegalStateException(
            "Keycloak fixture request "
                + request.method()
                + " "
                + request.uri().getPath()
                + " returned HTTP "
                + response.statusCode());
      return response.body().isBlank() ? json.nullNode() : json.readTree(response.body());
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Keycloak request interrupted", e);
    } catch (java.io.IOException e) {
      throw new IllegalStateException("Keycloak request failed", e);
    }
  }

  private static String encode(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8);
  }

  @Override
  public void close() {
    http.close();
  }
}
