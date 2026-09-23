package com.openzeppelin.dex.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

public final class BackendFixture implements AutoCloseable {
  public final DevelopmentFixtures fixtures = new DevelopmentFixtures();
  private final HttpClient http =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  public final JsonMapper json = JsonMapper.builder().build();
  private final String baseUrl = DevelopmentFixtures.env("DEX_TEST_BASE_URL");

  public BackendFixture() {
    await()
        .atMost(Duration.ofSeconds(90))
        .pollInterval(Duration.ofMillis(500))
        .ignoreExceptions()
        .until(() -> send("GET", "/actuator/health/readiness", null, null).statusCode() == 200);
  }

  public String trader(String scenario) {
    String name = scenario + "-" + UUID.randomUUID();
    fixtures.keycloak().createTrader(name);
    return name;
  }

  public static java.security.KeyPair keyPair() throws Exception {
    return java.security.KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
  }

  public static String publicKey(java.security.KeyPair key) {
    return Base64.getEncoder().encodeToString(key.getPublic().getEncoded());
  }

  public static Map<String, Object> sign(java.security.KeyPair key, JsonNode party)
      throws Exception {
    var signature = java.security.Signature.getInstance("Ed25519");
    signature.initSign(key.getPrivate());
    signature.update(Base64.getDecoder().decode(party.path("multiHash").asString()));
    return Map.of(
        "preparationId",
        party.path("preparationId").asString(),
        "signature",
        Base64.getEncoder().encodeToString(signature.sign()));
  }

  public JsonNode approve(String id) throws Exception {
    return request(
        "POST",
        "/v1/admin/onboardings/" + id + "/review",
        token("operator"),
        Map.of(
            "decision",
            "APPROVED",
            "approvedPoolIds",
            List.of(poolId()),
            "partyHint",
            "dex_david_test"),
        200);
  }

  public JsonNode register(String id, String token) throws Exception {
    var key = keyPair();
    var prep =
        request(
            "POST",
            "/v1/onboardings/" + id + "/party/prepare",
            token,
            Map.of("publicKey", publicKey(key)),
            200);
    request(
        "POST",
        "/v1/onboardings/" + id + "/party/submit",
        token,
        sign(key, prep.path("party")),
        200);
    return completed(token);
  }

  public JsonNode completed(String token) throws Exception {
    var result = new java.util.concurrent.atomic.AtomicReference<JsonNode>();
    await()
        .atMost(Duration.ofSeconds(90))
        .pollInterval(Duration.ofSeconds(1))
        .until(
            () -> {
              result.set(request("GET", "/v1/onboardings/mine", token, null, 200));
              return result.get().path("status").asString().equals("COMPLETED");
            });
    return result.get();
  }

  public String token(String name) {
    return fixtures.keycloak().userToken(name);
  }

  public JsonNode request(String method, String path, String token, Object body, int expected)
      throws Exception {
    var response = send(method, path, token, body);
    assertThat(response.statusCode())
        .as("%s %s: %s", method, path, response.body())
        .isEqualTo(expected);
    var payload = json.readTree(response.body());
    if (expected >= 400) {
      assertThat(response.headers().firstValue("Content-Type").orElse(""))
          .contains("application/problem+json");
      assertThat(payload.path("status").asInt()).isEqualTo(expected);
      assertThat(payload.path("type").asString("about:blank")).isEqualTo("about:blank");
      assertThat(payload.path("title").asString()).isNotBlank();
      assertThat(payload.path("detail").asString()).isNotBlank();
    }
    return payload;
  }

  HttpResponse<String> send(String method, String path, String token, Object body)
      throws Exception {
    var request =
        HttpRequest.newBuilder(URI.create(baseUrl + path)).timeout(Duration.ofSeconds(90));
    if (token != null) request.header("Authorization", "Bearer " + token);
    var payload =
        body == null
            ? HttpRequest.BodyPublishers.noBody()
            : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body));
    return http.send(
        request.header("Content-Type", "application/json").method(method, payload).build(),
        HttpResponse.BodyHandlers.ofString());
  }

  public JsonNode create(String token) throws Exception {
    return request(
        "POST",
        "/v1/onboardings",
        token,
        Map.ofEntries(
            Map.entry("legalName", "Synthetic Trader"),
            Map.entry("countryCode", "AR"),
            Map.entry(
                "documents",
                List.of(
                    Map.of(
                        "id",
                        UUID.randomUUID(),
                        "category",
                        "IDENTITY",
                        "fileName",
                        "david-test.pdf",
                        "mediaType",
                        "application/pdf",
                        "sizeBytes",
                        1234,
                        "simulated",
                        true)))),
        201);
  }

  @Override
  public void close() {
    http.close();
    fixtures.close();
  }

  public String poolId() {
    return fixtures
        .sql()
        .sql(
            "SELECT p.pool_id FROM test_token_pools t JOIN pools p ON p.pool_id=t.pool_id WHERE"
                + " t.pair='BTC/USDC' AND p.active")
        .query(String.class)
        .single();
  }
}
