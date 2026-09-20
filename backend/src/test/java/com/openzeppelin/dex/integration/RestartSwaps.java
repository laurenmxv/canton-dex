package com.openzeppelin.dex.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.daml.ledger.api.v2.admin.UserManagementServiceGrpc;
import com.daml.ledger.api.v2.admin.UserManagementServiceOuterClass.GetUserRequest;
import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import com.openzeppelin.dex.canton.DirectAllocationWithdrawal;
import com.openzeppelin.dex.canton.LedgerConnection;
import com.openzeppelin.dex.canton.SwapLedgerAssertions;
import com.openzeppelin.dex.onboarding.Onboarding;
import java.io.IOException;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.*;
import java.security.spec.*;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/** Exercises participant-only withdrawal across the existing backend restart boundary. */
final class RestartSwaps {
  private RestartSwaps() {}

  static void prepare(BackendFixture test, ObjectNode state) throws Exception {
    String poolId = state.path("settlementPolicies").get(1).path("poolId").asString();
    var api = new SwapIT();
    var trader = api.onboard(test, "restart-swaps", List.of(poolId));
    var wallet = test.json.createObjectNode();
    wallet.put("name", trader.name());
    wallet.put(
        "privateKey", Base64.getEncoder().encodeToString(trader.key().getPrivate().getEncoded()));
    wallet.set("party", test.completed(test.token(trader.name())).path("party"));
    wallet.put("poolId", poolId);
    wallet.set("requests", test.json.createArrayNode());
    state.set("swapWallet", wallet);
    // The only private-key copy outside memory is this owner-only, temporary recovery file.
    save(test.json, state);
    api.faucet(test, trader);
    try (var ledger = callerConnection()) {
      String token = test.token(trader.name());
      wallet.put(
          "userId",
          UserManagementServiceGrpc.newBlockingStub(ledger.authenticatedChannel(token))
              .withDeadlineAfter(10, TimeUnit.SECONDS)
              .getUser(GetUserRequest.newBuilder().setIdentityProviderId("dex-users").build())
              .getUser()
              .getId());
      wallet.set(
          "availableBefore", test.json.valueToTree(snapshot(ledger, token, wallet).available()));
    }
    wallet.set("reservesBefore", reserves(test, poolId));
    save(test.json, state);
    prepareRequest(test, state, trader, "25");
    prepareRequest(test, state, trader, "30");
    try (var ledger = callerConnection()) {
      var locked = snapshot(ledger, test.token(trader.name()), wallet);
      assertThat(locked.activeAllocationIds()).hasSize(4);
      assertThat(locked.fundedAllocationIds()).hasSize(2);
      assertThat(locked.locked().get("USDC")).isEqualByComparingTo("55");
    }
  }

  private static void prepareRequest(
      BackendFixture test, ObjectNode state, SwapIT.Trader trader, String amount) throws Exception {
    var wallet = (ObjectNode) state.path("swapWallet");
    String token = test.token(trader.name());
    var quote =
        test.request(
            "POST",
            "/v1/swaps/quote",
            token,
            Map.of(
                "poolId",
                wallet.path("poolId").asString(),
                "direction",
                "QuoteToBase",
                "amountIn",
                amount,
                "slippageBps",
                100),
            200);
    var prepared =
        test.request(
            "POST",
            "/v1/swaps/prepare",
            token,
            Map.of(
                "quoteId",
                quote.path("quoteId").asString(),
                "minOut",
                quote.path("minOut").asString(),
                "settlementDeadline",
                Instant.now().plusSeconds(45).truncatedTo(ChronoUnit.SECONDS).toString()),
            200);
    var requests = (tools.jackson.databind.node.ArrayNode) wallet.path("requests");
    int index = requests.size();
    requests.add(prepared);
    // Preserve the request ID before a submission can commit with a lost response.
    save(test.json, state);
    test.request("POST", "/v1/swaps/submit", token, SwapIT.sign(trader.key(), prepared), 202);
    requests.set(
        index, SwapIT.swapStatus(test, trader, prepared.path("swapId").asString(), "READY"));
    save(test.json, state);
  }

  static void withdrawWhileStopped(JsonMapper json, JsonNode state) throws Exception {
    assertBackendStopped();
    var wallet = (ObjectNode) state.path("swapWallet");
    assertThat(wallet.path("requests").size()).isEqualTo(2);
    var signer = signer(json, wallet);
    var key = key(wallet);
    try (var fixtures = new DevelopmentFixtures();
        var ledger = callerConnection()) {
      String token = fixtures.keycloak().userToken(wallet.path("name").asString());
      var before = snapshot(ledger, token, wallet);
      assertThat(before.activeAllocationIds()).hasSize(4);
      waitForDeadline(wallet.path("requests"));
      var full = wallet.path("requests").get(0);
      for (String cid : allocationIds(full)) {
        var tx =
            DirectAllocationWithdrawal.withdraw(
                ledger, token, wallet.path("userId").asString(), signer, key.getPrivate(), cid);
        wallet.put("fullWithdrawalUpdateId", tx.getUpdateId());
        save(json, state);
      }
      var partialIds = new HashSet<>(allocationIds(wallet.path("requests").get(1)));
      partialIds.retainAll(before.fundedAllocationIds());
      assertThat(partialIds).hasSize(1);
      DirectAllocationWithdrawal.withdraw(
          ledger,
          token,
          wallet.path("userId").asString(),
          signer,
          key.getPrivate(),
          partialIds.iterator().next());
      var after = snapshot(ledger, token, wallet);
      assertThat(after.activeAllocationIds())
          .hasSize(1)
          .isSubsetOf(allocationIds(wallet.path("requests").get(1)));
      assertThat(after.fundedAllocationIds()).isEmpty();
      assertAvailableRestored(after, wallet);
      wallet.put("offlineWithdrawalsConfirmed", true);
      save(json, state);
    }
    assertBackendStopped();
  }

  static void verify(BackendFixture test, JsonNode state) throws Exception {
    var wallet = (ObjectNode) state.path("swapWallet");
    assertThat(wallet.path("offlineWithdrawalsConfirmed").asBoolean()).isTrue();
    var trader = trader(wallet);
    String fullId = wallet.path("requests").get(0).path("swapId").asString();
    var full = SwapIT.swapStatus(test, trader, fullId, "WITHDRAWN");
    assertThat(full.path("updateId").asString())
        .isEqualTo(wallet.path("fullWithdrawalUpdateId").asString());
    String partialId = wallet.path("requests").get(1).path("swapId").asString();
    String token = test.token(trader.name());
    var partial = test.request("GET", "/v1/swaps/" + partialId, token, null, 200);
    assertThat(partial.path("status").asString()).isNotIn("SETTLED", "WITHDRAWN", "FAILED");
    assertThat(partial.path("canWithdraw").asBoolean()).isTrue();
    try (var ledger = callerConnection()) {
      var remaining = snapshot(ledger, token, wallet);
      assertThat(remaining.activeAllocationIds()).hasSize(1);
      assertThat(remaining.fundedAllocationIds()).isEmpty();
    }
    var prepared =
        test.request("POST", "/v1/swaps/" + partialId + "/cancel/prepare", token, null, 200);
    test.request(
        "POST",
        "/v1/swaps/" + partialId + "/cancel/submit",
        token,
        SwapIT.sign(trader.key(), prepared),
        202);
    SwapIT.swapStatus(test, trader, partialId, "WITHDRAWN");
    try (var ledger = callerConnection()) {
      var after = snapshot(ledger, token, wallet);
      assertThat(after.activeAllocationIds()).isEmpty();
      assertAvailableRestored(after, wallet);
    }
    assertThat(reserves(test, wallet.path("poolId").asString()))
        .isEqualTo(wallet.path("reservesBefore"));
    try (var ledger = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
      SwapLedgerAssertions.backing(ledger, wallet.path("poolId").asString());
    }
    wallet.put("fundedRequestsResolved", true);
    save(test.json, state);
  }

  static void restore(BackendFixture test, JsonNode state) throws Exception {
    if (!state.has("swapWallet")) return;
    var wallet = (ObjectNode) state.path("swapWallet");
    var trader = trader(wallet);
    String token = test.token(trader.name());
    try (var ledger = callerConnection()) {
      for (var saved : wallet.path("requests")) {
        String id = saved.path("swapId").asString();
        var current = new AtomicReference<JsonNode>();
        await()
            .atMost(Duration.ofSeconds(60))
            .pollInterval(Duration.ofMillis(500))
            .until(
                () -> {
                  current.set(test.request("GET", "/v1/swaps/" + id, token, null, 200));
                  return !Set.of(
                          "SUBMITTING",
                          "UNRESOLVED",
                          "SETTLING",
                          "WITHDRAWING",
                          "WITHDRAWAL_UNRESOLVED")
                      .contains(current.get().path("status").asString());
                });
        String status = current.get().path("status").asString();
        if (status.equals("PREPARED")) {
          // A timed-out submit handler may still send its transaction. Preserve the wallet
          // until a participant watermark proves that the signed transaction cannot commit.
          DirectAllocationWithdrawal.awaitRecordTimeAfter(
              ledger,
              token,
              signer(test.json, wallet),
              Instant.parse(saved.path("expiresAt").asString()));
          current.set(test.request("GET", "/v1/swaps/" + id, token, null, 200));
          status = current.get().path("status").asString();
        }
        if (Set.of("PREPARED", "FAILED", "SETTLED").contains(status)) continue;
        var ids = allocationIds(current.get());
        assertThat(ids).hasSize(2);
        if (!status.equals("WITHDRAWN")) {
          waitForDeadline(List.of(current.get()));
          var remaining = DirectAllocationWithdrawal.snapshot(ledger, token, trader.party(), ids);
          for (String cid : remaining.activeAllocationIds())
            DirectAllocationWithdrawal.withdraw(
                ledger,
                token,
                wallet.path("userId").asString(),
                signer(test.json, wallet),
                trader.key().getPrivate(),
                cid);
          SwapIT.swapStatus(test, trader, id, "WITHDRAWN", "SETTLED");
        }
        assertThat(
                DirectAllocationWithdrawal.snapshot(ledger, token, trader.party(), ids)
                    .activeAllocationIds())
            .isEmpty();
      }
      assertThat(
              DirectAllocationWithdrawal.snapshot(ledger, token, trader.party(), List.of())
                  .locked()
                  .values())
          .allSatisfy(amount -> assertThat(amount).isZero());
    }
    wallet.put("fundedRequestsResolved", true);
    save(test.json, state);
  }

  private static DirectAllocationWithdrawal.Snapshot snapshot(
      LedgerConnection ledger, String token, JsonNode wallet) {
    var ids = new ArrayList<String>();
    wallet.path("requests").forEach(request -> ids.addAll(allocationIds(request)));
    return DirectAllocationWithdrawal.snapshot(
        ledger, token, wallet.path("party").path("partyId").asString(), ids);
  }

  private static List<String> allocationIds(JsonNode request) {
    var ids = new ArrayList<String>();
    request.path("allocationCids").forEach(cid -> ids.add(cid.asString()));
    return ids;
  }

  private static void assertAvailableRestored(
      DirectAllocationWithdrawal.Snapshot snapshot, JsonNode wallet) {
    wallet
        .path("availableBefore")
        .properties()
        .forEach(
            entry ->
                assertThat(snapshot.available().getOrDefault(entry.getKey(), BigDecimal.ZERO))
                    .isEqualByComparingTo(entry.getValue().asString()));
    assertThat(snapshot.locked().values()).allSatisfy(amount -> assertThat(amount).isZero());
  }

  private static void waitForDeadline(Iterable<JsonNode> requests) {
    Instant deadline = Instant.MIN;
    for (var request : requests) {
      Instant value = Instant.parse(request.path("settlementDeadline").asString());
      if (value.isAfter(deadline)) deadline = value;
    }
    Instant afterDeadline = deadline.plusSeconds(1);
    await()
        .atMost(Duration.ofSeconds(60))
        .pollInterval(Duration.ofMillis(250))
        .until(() -> Instant.now().isAfter(afterDeadline));
  }

  private static JsonNode reserves(BackendFixture test, String pool) throws Exception {
    return test.request(
            "GET", "/v1/admin/monitoring?poolId=" + pool, test.token("operator"), null, 200)
        .path("pool")
        .path("reserves");
  }

  private static SwapIT.Trader trader(JsonNode wallet) throws Exception {
    return new SwapIT.Trader(
        wallet.path("name").asString(),
        key(wallet),
        wallet.path("party").path("partyId").asString());
  }

  private static KeyPair key(JsonNode wallet) throws Exception {
    var factory = KeyFactory.getInstance("Ed25519");
    return new KeyPair(
        factory.generatePublic(
            new X509EncodedKeySpec(
                Base64.getDecoder().decode(wallet.path("party").path("publicKey").asString()))),
        factory.generatePrivate(
            new PKCS8EncodedKeySpec(
                Base64.getDecoder().decode(wallet.path("privateKey").asString()))));
  }

  private static Onboarding.PartyPreparation signer(JsonMapper json, JsonNode wallet) {
    return json.treeToValue(wallet.path("party"), Onboarding.PartyPreparation.class);
  }

  private static LedgerConnection callerConnection() {
    return new LedgerConnection(
        DevelopmentFixtures.env("DEX_CANTON_HOST"),
        Integer.parseInt(DevelopmentFixtures.env("DEX_CANTON_PORT")),
        null,
        null);
  }

  private static void assertBackendStopped() throws Exception {
    try (var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build()) {
      var request =
          HttpRequest.newBuilder(
                  URI.create(
                      DevelopmentFixtures.env("DEX_TEST_BASE_URL") + "/actuator/health/readiness"))
              .timeout(Duration.ofSeconds(2))
              .build();
      try {
        client.send(request, HttpResponse.BodyHandlers.discarding());
        throw new AssertionError("The venue backend must be stopped during direct withdrawal");
      } catch (IOException stopped) {
        // The participant and identity provider stay online; no backend response is acceptable.
      }
    }
  }

  static void save(JsonMapper json, JsonNode state) throws IOException {
    Path target = Path.of(DevelopmentFixtures.env("DEX_RESTART_STATE"));
    Path replacement =
        Files.createTempFile(
            target.getParent(),
            "restart-state-",
            ".tmp",
            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
    try {
      json.writeValue(replacement.toFile(), state);
      Files.move(
          replacement, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    } finally {
      Files.deleteIfExists(replacement);
    }
  }
}
