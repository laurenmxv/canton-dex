package com.openzeppelin.dex.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import com.openzeppelin.dex.canton.LedgerConnection;
import com.openzeppelin.dex.canton.SwapLedgerAssertions;
import java.math.BigDecimal;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Provider;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import tools.jackson.databind.JsonNode;

@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "swaps|all")
class SwapIT {
  private static final Provider EC_PROVIDER = new BouncyCastleProvider();

  record Trader(String name, KeyPair key, String party) {}

  private final Map<String, JsonNode> policyWrites = new HashMap<>();

  @Test
  void externalSignaturesFundLockSettleBatchAndReclaimRealTokens() throws Exception {
    try (var f = new BackendFixture();
        var ledger = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
      String btc = pool(f, "BTC/USDC"), eth = pool(f, "ETH/USDC");
      String operator = f.token("operator");
      var savedBtc = policy(f, operator, btc);
      var savedEth = policy(f, operator, eth);
      for (String pool : List.of(btc, eth)) {
        assertThat(queue(f, operator, pool))
            .as("Fixture pool must have no unrelated pending swaps")
            .isEmpty();
        assertThat(monitor(f, operator, pool).path("pool").path("health").asString())
            .isEqualTo("READY");
        assertThat(policy(f, operator, pool).path("automaticEnabled").asBoolean())
            .as("Disable automatic settlement before running the isolated swap scenario")
            .isFalse();
      }
      try {
        var alice = onboard(f, "swap-alice", List.of(btc, eth), BackendFixture.keyPair());
        var generator = KeyPairGenerator.getInstance("EC", EC_PROVIDER);
        generator.initialize(new ECGenParameterSpec("secp256k1"));
        var bob = onboard(f, "swap-bob", List.of(btc, eth), generator.generateKeyPair());
        faucet(f, alice);
        faucet(f, bob);
        SwapLedgerAssertions.backing(ledger, btc);
        SwapLedgerAssertions.backing(ledger, eth);
        var untouchedEth = monitor(f, operator, eth).path("pool").path("reserves");

        updatePolicy(f, operator, btc, false, 2);
        assertThat(policy(f, operator, eth)).isEqualTo(savedEth);
        var changed = policy(f, operator, btc);
        f.request(
            "PUT",
            policyPath(btc),
            operator,
            Map.of(
                "automaticEnabled",
                false,
                "batchSize",
                1,
                "expectedVersion",
                savedBtc.path("version").asLong()),
            409);
        assertThat(policy(f, operator, btc)).isEqualTo(changed);
        f.request(
            "PUT",
            policyPath(btc),
            f.token(alice.name()),
            Map.of(
                "automaticEnabled",
                true,
                "batchSize",
                1,
                "expectedVersion",
                changed.path("version").asLong()),
            403);

        var before = balances(f, alice);
        var first = submit(f, alice, btc, "QuoteToBase", "100", null);
        var locked = balances(f, alice);
        assertAmount(
            balance(locked, "USDC", "available"),
            balance(before, "USDC", "available").subtract(decimal("100")));
        assertAmount(balance(locked, "USDC", "locked"), decimal("100"));
        assertAmount(balance(locked, "USDC", "total"), balance(before, "USDC", "total"));
        SwapLedgerAssertions.allocations(ledger, f.token(alice.name()), alice.party(), first, true);
        f.request(
            "GET", "/v1/swaps/" + first.path("swapId").asString(), f.token(bob.name()), null, 404);
        f.request(
            "POST",
            "/v1/swaps/" + first.path("swapId").asString() + "/cancel/prepare",
            f.token(alice.name()),
            null,
            409);
        long singleOffset = ledger.ledgerEnd();
        var single = manual(f, operator, btc);
        assertThat(single.path("requests").size()).isEqualTo(1);
        assertBatch(ledger, singleOffset, single, List.of(first));
        var firstSettled = swapStatus(f, alice, first.path("swapId").asString(), "SETTLED");
        assertAmount(
            balance(balances(f, alice), "BTC", "available"),
            balance(before, "BTC", "available").add(value(firstSettled, "amountOut")));
        assertAmount(balance(balances(f, alice), "USDC", "locked"), BigDecimal.ZERO);
        SwapLedgerAssertions.allocations(
            ledger, f.token(alice.name()), alice.party(), first, false);
        f.request(
            "POST",
            "/v1/admin/pools/" + btc + "/settlements",
            operator,
            Map.of("idempotencyKey", single.path("settlementId").asString()),
            202);
        assertThat(monitor(f, operator, eth).path("pool").path("reserves")).isEqualTo(untouchedEth);

        var second = submit(f, alice, btc, "QuoteToBase", "200", null);
        var third = submit(f, bob, btc, "BaseToQuote", "0.001", null);
        assertThat(second.path("arrivalSequence").asLong())
            .isLessThan(third.path("arrivalSequence").asLong());
        SwapLedgerAssertions.privateSwapContracts(
            ledger, f.token(alice.name()), alice.party(), second, third, false);
        SwapLedgerAssertions.privateSwapContracts(
            ledger, f.token(bob.name()), bob.party(), third, second, false);
        long batchOffset = ledger.ledgerEnd();
        var batch = manual(f, operator, btc);
        assertBatch(ledger, batchOffset, batch, List.of(second, third));
        assertThat(
                swapStatus(f, alice, second.path("swapId").asString(), "SETTLED").path("updateId"))
            .isEqualTo(
                swapStatus(f, bob, third.path("swapId").asString(), "SETTLED").path("updateId"));
        SwapLedgerAssertions.privateSwapContracts(
            ledger, f.token(alice.name()), alice.party(), second, third, true);
        SwapLedgerAssertions.privateSwapContracts(
            ledger, f.token(bob.name()), bob.party(), third, second, true);
        SwapLedgerAssertions.backing(ledger, btc);

        int maximum = policy(f, operator, btc).path("maxBatchSize").asInt();
        updatePolicy(f, operator, btc, false, maximum);
        var maximumRequests = new ArrayList<JsonNode>();
        for (int i = 0; i < maximum; i++)
          maximumRequests.add(submit(f, i % 2 == 0 ? alice : bob, btc, "QuoteToBase", "1", null));
        long maximumOffset = ledger.ledgerEnd();
        assertBatch(ledger, maximumOffset, manual(f, operator, btc), maximumRequests);
        updatePolicy(f, operator, btc, false, 2);
        var isolatedBtcPolicy = policy(f, operator, btc);

        updatePolicy(f, operator, eth, true, 2);
        long automaticOffset = ledger.ledgerEnd();
        var fourth = submit(f, alice, eth, "QuoteToBase", "50", null);
        await()
            .during(Duration.ofSeconds(5))
            .atMost(Duration.ofSeconds(8))
            .pollInterval(Duration.ofMillis(400))
            .untilAsserted(
                () ->
                    assertThat(
                            swap(f, alice, fourth.path("swapId").asString())
                                .path("status")
                                .asString())
                        .isEqualTo("READY"));
        var fifth = submit(f, bob, eth, "QuoteToBase", "75", null);
        var autoSettled = swapStatus(f, alice, fourth.path("swapId").asString(), "SETTLED");
        swapStatus(f, bob, fifth.path("swapId").asString(), "SETTLED");
        var automatic =
            status(
                f,
                "/v1/admin/settlements/" + autoSettled.path("settlementId").asString(),
                operator,
                "CONFIRMED");
        assertThat(automatic.path("trigger").asString()).isEqualTo("AUTOMATIC");
        assertBatch(ledger, automaticOffset, automatic, List.of(fourth, fifth));
        updatePolicy(f, operator, eth, false, 2);
        assertThat(policy(f, operator, eth).path("automaticEnabled").asBoolean()).isFalse();
        assertThat(policy(f, operator, btc)).isEqualTo(isolatedBtcPolicy);

        var reclaimBefore = balances(f, alice);
        var reclaimReserves = monitor(f, operator, eth).path("pool").path("reserves");
        var expiring =
            submit(
                f,
                alice,
                eth,
                "QuoteToBase",
                "25",
                Instant.now().plusSeconds(42).truncatedTo(java.time.temporal.ChronoUnit.SECONDS));
        String expiringId = expiring.path("swapId").asString();
        await()
            .atMost(Duration.ofSeconds(55))
            .pollInterval(Duration.ofSeconds(1))
            .until(
                () -> {
                  monitor(f, operator, eth);
                  return swap(f, alice, expiringId).path("canWithdraw").asBoolean();
                });
        var reclaim =
            f.request(
                "POST",
                "/v1/swaps/" + expiringId + "/cancel/prepare",
                f.token(alice.name()),
                null,
                200);
        f.request(
            "POST",
            "/v1/swaps/" + expiringId + "/cancel/submit",
            f.token(alice.name()),
            sign(alice.key(), reclaim),
            202);
        swapStatus(f, alice, expiringId, "WITHDRAWN");
        assertAmount(
            balance(balances(f, alice), "USDC", "available"),
            balance(reclaimBefore, "USDC", "available"));
        assertAmount(balance(balances(f, alice), "USDC", "locked"), BigDecimal.ZERO);
        assertThat(monitor(f, operator, eth).path("pool").path("reserves"))
            .isEqualTo(reclaimReserves);
        SwapLedgerAssertions.allocations(
            ledger, f.token(alice.name()), alice.party(), expiring, false);
        SwapLedgerAssertions.backing(ledger, eth);
      } finally {
        org.junit.jupiter.api.Assertions.assertAll(
            "Restore each fixture setting independently",
            () -> restorePolicy(f, operator, btc, savedBtc),
            () -> restorePolicy(f, operator, eth, savedEth));
      }
    }
  }

  Trader onboard(BackendFixture f, String name, List<String> pools) throws Exception {
    return onboard(f, name, pools, BackendFixture.keyPair());
  }

  private Trader onboard(BackendFixture f, String name, List<String> pools, KeyPair key)
      throws Exception {
    String username = f.trader(name), token = f.token(username);
    String id = f.create(token).path("id").asString();
    f.request(
        "POST",
        "/v1/admin/onboardings/" + id + "/review",
        f.token("operator"),
        Map.of("decision", "APPROVED", "approvedPoolIds", pools, "partyHint", "dex_swap_test"),
        200);
    var prepared =
        f.request(
            "POST",
            "/v1/onboardings/" + id + "/party/prepare",
            token,
            Map.of("publicKey", BackendFixture.publicKey(key)),
            200);
    f.request(
        "POST",
        "/v1/onboardings/" + id + "/party/submit",
        token,
        sign(key, prepared.path("party"), "multiHash"),
        200);
    return new Trader(username, key, f.completed(token).path("party").path("partyId").asString());
  }

  void faucet(BackendFixture f, Trader trader) throws Exception {
    String token = f.token(trader.name());
    var prepared = f.request("POST", "/v1/dev/faucet/prepare", token, null, 200);
    f.request(
        "POST", "/v1/dev/faucet/submit", token, sign(BackendFixture.keyPair(), prepared), 400);
    f.request("POST", "/v1/dev/faucet/submit", token, sign(trader.key(), prepared), 202);
    status(f, "/v1/dev/faucet", token, "COMPLETED");
    var available = balances(f, trader);
    assertAmount(balance(available, "USDC", "available"), decimal("10000"));
    assertAmount(balance(available, "BTC", "available"), decimal("0.1"));
    assertAmount(balance(available, "ETH", "available"), decimal("2"));
    f.request("POST", "/v1/dev/faucet/submit", token, sign(trader.key(), prepared), 202);
    assertThat(balances(f, trader).path("balances")).isEqualTo(available.path("balances"));
  }

  private JsonNode submit(
      BackendFixture f,
      Trader trader,
      String pool,
      String direction,
      String amount,
      Instant deadline)
      throws Exception {
    String token = f.token(trader.name());
    var quote =
        f.request(
            "POST",
            "/v1/swaps/quote",
            token,
            Map.of("poolId", pool, "direction", direction, "amountIn", amount, "slippageBps", 100),
            200);
    var prepared =
        f.request(
            "POST",
            "/v1/swaps/prepare",
            token,
            Map.of(
                "quoteId",
                quote.path("quoteId").asString(),
                "minOut",
                quote.path("minOut").asString(),
                "settlementDeadline",
                deadline == null
                    ? quote.path("settlementDeadline").asString()
                    : deadline.toString()),
            200);
    f.request("POST", "/v1/swaps/submit", token, sign(BackendFixture.keyPair(), prepared), 400);
    f.request("POST", "/v1/swaps/submit", token, sign(trader.key(), prepared), 202);
    return swapStatus(f, trader, prepared.path("swapId").asString(), "READY", "SETTLED");
  }

  private JsonNode manual(BackendFixture f, String operator, String pool) throws Exception {
    var started =
        f.request(
            "POST",
            "/v1/admin/pools/" + pool + "/settlements",
            operator,
            Map.of("idempotencyKey", UUID.randomUUID()),
            202);
    assertThat(started.path("trigger").asString()).isEqualTo("MANUAL");
    return status(
        f,
        "/v1/admin/settlements/" + started.path("settlementId").asString(),
        operator,
        "CONFIRMED");
  }

  private void assertBatch(
      LedgerConnection ledger, long offset, JsonNode batch, List<JsonNode> swaps) throws Exception {
    var expectedIds = swaps.stream().map(s -> s.path("swapId").asString()).toList();
    var actualIds = new ArrayList<String>();
    batch
        .path("requests")
        .forEach(
            ref -> {
              assertThat(ref.path("type").asString()).isEqualTo("swap");
              actualIds.add(ref.path("requestId").asString());
            });
    assertThat(actualIds).containsExactlyElementsOf(expectedIds);
    BigDecimal base = value(batch.path("before"), "baseReserve"),
        quote = value(batch.path("before"), "quoteReserve");
    for (int i = 0; i < swaps.size(); i++) {
      var swap = swaps.get(i);
      var fill = batch.path("fills").get(i);
      assertThat(fill.path("type").asString()).isEqualTo("swap");
      assertThat(fill.path("requestId")).isEqualTo(swap.path("swapId"));
      BigDecimal input = value(swap, "amountIn"), output = value(fill, "amountOut");
      assertThat(output).isGreaterThanOrEqualTo(value(swap, "minOut"));
      if (swap.path("direction").asString().equals("QuoteToBase")) {
        base = base.subtract(output);
        quote = quote.add(input);
      } else {
        base = base.add(input);
        quote = quote.subtract(output);
      }
    }
    assertAmount(value(batch.path("after"), "baseReserve"), base);
    assertAmount(value(batch.path("after"), "quoteReserve"), quote);
    assertThat(value(batch.path("after"), "invariant"))
        .isGreaterThanOrEqualTo(value(batch.path("before"), "invariant"));
    SwapLedgerAssertions.atomicBatch(ledger, offset, batch);
    SwapLedgerAssertions.backing(ledger, batch.path("poolId").asString());
  }

  static Map<String, Object> sign(KeyPair key, JsonNode preparation) throws Exception {
    assertThat(preparation.path("hashEncoding").asString()).isEqualTo("base64");
    return sign(key, preparation, "preparedTransactionHash");
  }

  private static Map<String, Object> sign(KeyPair key, JsonNode preparation, String hashField)
      throws Exception {
    var signature =
        key.getPrivate().getAlgorithm().equals("EC")
            ? Signature.getInstance("SHA256withECDSA", EC_PROVIDER)
            : Signature.getInstance("Ed25519");
    signature.initSign(key.getPrivate());
    signature.update(Base64.getDecoder().decode(preparation.path(hashField).asString()));
    return Map.of(
        "preparationId",
        preparation.path("preparationId").asString(),
        "signature",
        Base64.getEncoder().encodeToString(signature.sign()));
  }

  private static JsonNode status(BackendFixture f, String path, String token, String... expected) {
    var value = new AtomicReference<JsonNode>();
    await()
        .atMost(Duration.ofSeconds(55))
        .pollInterval(Duration.ofMillis(500))
        .until(
            () -> {
              value.set(f.request("GET", path, token, null, 200));
              assertThat(value.get().path("status").asString())
                  .as(value.get().toString())
                  .isNotIn("FAILED", "REJECTED", "CANCELLED", "BLOCKED");
              return Set.of(expected).contains(value.get().path("status").asString());
            });
    return value.get();
  }

  static JsonNode swapStatus(BackendFixture f, Trader t, String id, String... expected) {
    return status(f, "/v1/swaps/" + id, f.token(t.name()), expected);
  }

  private static JsonNode swap(BackendFixture f, Trader t, String id) throws Exception {
    return f.request("GET", "/v1/swaps/" + id, f.token(t.name()), null, 200);
  }

  private static JsonNode balances(BackendFixture f, Trader t) throws Exception {
    return f.request("GET", "/v1/balances", f.token(t.name()), null, 200);
  }

  private static JsonNode monitor(BackendFixture f, String token, String pool) throws Exception {
    return f.request("GET", "/v1/admin/monitoring?poolId=" + pool, token, null, 200);
  }

  private static JsonNode queue(BackendFixture f, String token, String pool) throws Exception {
    return f.request(
        "GET", "/v1/admin/settlement-requests?poolId=" + pool + "&status=active", token, null, 200);
  }

  private static JsonNode policy(BackendFixture f, String token, String pool) throws Exception {
    return f.request("GET", policyPath(pool), token, null, 200);
  }

  private static String policyPath(String pool) {
    return "/v1/admin/pools/" + pool + "/settlement-policy/swap";
  }

  private void updatePolicy(
      BackendFixture f, String token, String pool, boolean automatic, int size) throws Exception {
    var current = policy(f, token, pool);
    policyWrites.put(
        pool,
        f.request(
            "PUT",
            policyPath(pool),
            token,
            Map.of(
                "automaticEnabled",
                automatic,
                "batchSize",
                size,
                "expectedVersion",
                current.path("version").asLong()),
            200));
  }

  private void restorePolicy(BackendFixture f, String token, String pool, JsonNode saved)
      throws Exception {
    var written = policyWrites.get(pool);
    if (written == null) return;
    f.request(
        "PUT",
        policyPath(pool),
        token,
        Map.of(
            "automaticEnabled",
            saved.path("automaticEnabled").asBoolean(),
            "batchSize",
            saved.path("batchSize").asInt(),
            "expectedVersion",
            written.path("version").asLong()),
        200);
  }

  private static String pool(BackendFixture f, String pair) {
    return f.fixtures
        .sql()
        .sql("SELECT pool_id FROM test_token_pools WHERE pair=?")
        .param(pair)
        .query(String.class)
        .single();
  }

  private static BigDecimal balance(JsonNode balances, String symbol, String field) {
    for (var item : balances.path("balances"))
      if (item.path("symbol").asString().equals(symbol)) return value(item, field);
    throw new AssertionError("Balance missing: " + symbol);
  }

  private static BigDecimal value(JsonNode node, String field) {
    return decimal(node.path(field).asString());
  }

  private static BigDecimal decimal(String value) {
    return new BigDecimal(value);
  }

  private static void assertAmount(BigDecimal actual, BigDecimal expected) {
    assertThat(actual).isEqualByComparingTo(expected);
  }
}
