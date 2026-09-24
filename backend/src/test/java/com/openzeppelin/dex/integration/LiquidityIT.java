package com.openzeppelin.dex.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import com.openzeppelin.dex.canton.LiquidityLedgerAssertions;
import com.openzeppelin.dex.canton.SwapLedgerAssertions;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import tools.jackson.databind.JsonNode;

@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "liquidity|all")
class LiquidityIT {
  @Test
  void liquidityRequiresAccessAndPartialRecoveryReturnsRemainingFunds() throws Exception {
    try (var f = new BackendFixture();
        var ledger = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
      String pool =
          f.fixtures
              .sql()
              .sql("SELECT pool_id FROM test_token_pools WHERE pair='BTC/USDC'")
              .query(String.class)
              .single();
      String operator = f.token("operator");
      var policy =
          f.request(
              "GET", "/v1/admin/pools/" + pool + "/settlement-policy/deposit", operator, null, 200);
      assertThat(policy.path("automaticEnabled").asBoolean()).isFalse();
      assertThat(
              f.request(
                  "GET",
                  "/v1/admin/settlement-requests?poolId=" + pool + "&status=active",
                  operator,
                  null,
                  200))
          .isEmpty();
      var swaps = new SwapIT();
      var trader = swaps.onboard(f, "liquidity", List.of(pool));
      swaps.faucet(f, trader);
      String token = f.token(trader.name());
      var before = balances(f, token);
      var beforePool = monitor(f, operator, pool).path("pool");
      var deposit = deposit(f, trader, pool, null);
      var terms = deposit.path("terms");
      assertThat(terms.path("mode").asString()).isEqualTo("PROPORTIONAL");
      assertThat(amount(terms, "expectedBaseRefund").add(amount(terms, "expectedQuoteRefund")))
          .isPositive();
      assertThat(deposit.path("allocationCids")).hasSize(3);
      var depositSettlement =
          settle(f, operator, pool, "deposit", deposit.path("requestId").asString());
      deposit = requestStatus(f, token, "deposit", deposit.path("requestId").asString(), "SETTLED");
      var deposited = deposit.path("result");
      assertThat(deposited).isNotNull();
      for (String field :
          List.of(
              "actualBaseIn",
              "actualQuoteIn",
              "actualBaseRefund",
              "actualQuoteRefund",
              "actualLpOut"))
        assertThat(deposited.path(field))
            .isEqualTo(depositSettlement.path("fills").get(0).path(field));
      assertThat(amount(deposited, "actualBaseIn").add(amount(deposited, "actualBaseRefund")))
          .isEqualByComparingTo(amount(terms, "maxBaseAmount"));
      assertThat(amount(deposited, "actualQuoteIn").add(amount(deposited, "actualQuoteRefund")))
          .isEqualByComparingTo(amount(terms, "maxQuoteAmount"));
      var afterDeposit = balances(f, token);
      assertThat(balance(afterDeposit, "BTC", "available"))
          .isEqualByComparingTo(
              balance(before, "BTC", "available").subtract(amount(deposited, "actualBaseIn")));
      assertThat(balance(afterDeposit, "USDC", "available"))
          .isEqualByComparingTo(
              balance(before, "USDC", "available").subtract(amount(deposited, "actualQuoteIn")));
      assertThat(amount(position(f, token, pool), "availableLp"))
          .isEqualByComparingTo(amount(deposited, "actualLpOut"));
      assertThat(amount(monitor(f, operator, pool).path("pool"), "lpTokenSupply"))
          .isEqualByComparingTo(
              amount(beforePool, "lpTokenSupply").add(amount(deposited, "actualLpOut")));
      SwapLedgerAssertions.backing(ledger, pool);

      var expiring =
          deposit(f, trader, pool, Instant.now().plusSeconds(45).truncatedTo(ChronoUnit.SECONDS));
      String expiredId = expiring.path("requestId").asString();
      var access = LiquidityLedgerAssertions.revokeAccess(ledger, trader.party(), pool);
      String lpAmount =
          amount(deposited, "actualLpOut")
              .divide(new BigDecimal("2"), 10, RoundingMode.DOWN)
              .toPlainString();
      assertThat(
              f.request(
                      "POST",
                      "/v1/lp/withdraw/quote",
                      token,
                      Map.of("poolId", pool, "lpAmount", lpAmount, "slippageBps", 100),
                      409)
                  .path("code")
                  .asString())
          .isEqualTo("POOL_ACCESS_REQUIRED");
      LiquidityLedgerAssertions.restoreAccess(ledger, access);
      var quote =
          f.request(
              "POST",
              "/v1/lp/withdraw/quote",
              token,
              Map.of("poolId", pool, "lpAmount", lpAmount, "slippageBps", 100),
              200);
      var prepared =
          f.request(
              "POST",
              "/v1/lp/withdraw/prepare",
              token,
              Map.of(
                  "quoteId",
                  quote.path("quoteId").asString(),
                  "minBaseOut",
                  quote.path("minBaseOut").asString(),
                  "minQuoteOut",
                  quote.path("minQuoteOut").asString(),
                  "settlementDeadline",
                  quote.path("settlementDeadline").asString()),
              200);
      f.request("POST", "/v1/lp/withdraw/submit", token, SwapIT.sign(trader.key(), prepared), 202);
      String withdrawalId = prepared.path("requestId").asString();
      requestStatus(f, token, "withdraw", withdrawalId, "READY");
      settle(f, operator, pool, "withdraw", withdrawalId);
      var withdrawal = requestStatus(f, token, "withdraw", withdrawalId, "SETTLED").path("result");
      assertThat(amount(withdrawal, "actualLpBurned")).isEqualByComparingTo(lpAmount);
      assertThat(amount(position(f, token, pool), "availableLp"))
          .isEqualByComparingTo(
              amount(deposited, "actualLpOut").subtract(new BigDecimal(lpAmount)));
      SwapLedgerAssertions.backing(ledger, pool);

      await()
          .atMost(Duration.ofSeconds(55))
          .pollInterval(Duration.ofSeconds(1))
          .until(
              () -> {
                monitor(f, operator, pool);
                return f.request("GET", "/v1/lp/deposit/" + expiredId, token, null, 200)
                    .path("canRecover")
                    .asBoolean();
              });
      String baseAllocation = expiring.path("allocationCids").get(0).asString();
      LiquidityLedgerAssertions.withdrawAllocation(
          f.fixtures, ledger, token, trader.party(), trader.key(), baseAllocation);
      access = LiquidityLedgerAssertions.revokeAccess(ledger, trader.party(), pool);
      assertThat(
              f.request("POST", "/v1/lp/deposit/" + expiredId + "/cancel/prepare", token, null, 409)
                  .path("code")
                  .asString())
          .isEqualTo("POOL_ACCESS_REQUIRED");
      LiquidityLedgerAssertions.restoreAccess(ledger, access);
      var recovery =
          f.request("POST", "/v1/lp/deposit/" + expiredId + "/cancel/prepare", token, null, 200);
      assertThat(recovery.path("recoveryEffects")).hasSize(2);
      assertThat(recovery.path("recoveryEffects"))
          .noneMatch(effect -> effect.path("allocationCid").asString().equals(baseAllocation));
      assertThat(recovery.path("recoveryEffects"))
          .anyMatch(effect -> effect.path("kind").asString().equals("RETURN_FUNDS"));
      assertThat(recovery.path("recoveryEffects"))
          .anyMatch(effect -> effect.path("kind").asString().equals("RELEASE_PERMISSION"));
      f.request(
          "POST",
          "/v1/lp/deposit/" + expiredId + "/cancel/submit",
          token,
          SwapIT.sign(trader.key(), recovery),
          202);
      requestStatus(f, token, "deposit", expiredId, "RECOVERED");
      var after = balances(f, token);
      assertThat(balance(after, "BTC", "available"))
          .isEqualByComparingTo(
              balance(afterDeposit, "BTC", "available").add(amount(withdrawal, "actualBaseOut")));
      assertThat(balance(after, "USDC", "available"))
          .isEqualByComparingTo(
              balance(afterDeposit, "USDC", "available").add(amount(withdrawal, "actualQuoteOut")));
      assertThat(balance(after, "BTC", "locked")).isZero();
      assertThat(balance(after, "USDC", "locked")).isZero();
      assertThat(amount(position(f, token, pool), "allocatedLp")).isZero();
      SwapLedgerAssertions.backing(ledger, pool);
      var activity = f.request("GET", "/v1/activity?type=all", token, null, 200).path("items");
      assertThat(activity).hasSize(3);
      assertThat(activity).anyMatch(item -> item.path("type").asString().equals("withdraw"));
      assertThat(activity)
          .anyMatch(item -> item.path("request").path("status").asString().equals("RECOVERED"));
    }
  }

  private static JsonNode deposit(
      BackendFixture f, SwapIT.Trader trader, String pool, Instant deadline) throws Exception {
    String token = f.token(trader.name());
    var quote =
        f.request(
            "POST",
            "/v1/lp/deposit/quote",
            token,
            Map.of(
                "poolId",
                pool,
                "maxBaseAmount",
                "0.005",
                "maxQuoteAmount",
                "1000",
                "slippageBps",
                100),
            200);
    var preparation =
        f.request(
            "POST",
            "/v1/lp/deposit/prepare",
            token,
            Map.of(
                "quoteId",
                quote.path("quoteId").asString(),
                "minLpOut",
                quote.path("minLpOut").asString(),
                "minRatio",
                quote.path("minRatio").asString(),
                "maxRatio",
                quote.path("maxRatio").asString(),
                "settlementDeadline",
                deadline == null
                    ? quote.path("settlementDeadline").asString()
                    : deadline.toString()),
            200);
    f.request("POST", "/v1/lp/deposit/submit", token, SwapIT.sign(trader.key(), preparation), 202);
    return requestStatus(f, token, "deposit", preparation.path("requestId").asString(), "READY");
  }

  private static JsonNode settle(
      BackendFixture f, String operator, String pool, String type, String requestId)
      throws Exception {
    var batch =
        f.request(
            "POST",
            "/v1/admin/pools/" + pool + "/settlements",
            operator,
            Map.of("idempotencyKey", UUID.randomUUID()),
            202);
    var result =
        status(
            f,
            "/v1/admin/settlements/" + batch.path("settlementId").asString(),
            operator,
            "CONFIRMED");
    assertThat(result.path("requests")).hasSize(1);
    assertThat(result.path("requests").get(0).path("type").asString()).isEqualTo(type);
    assertThat(result.path("requests").get(0).path("requestId").asString()).isEqualTo(requestId);
    return result;
  }

  private static JsonNode requestStatus(
      BackendFixture f, String token, String kind, String id, String expected) {
    return status(f, "/v1/lp/" + kind + "/" + id, token, expected);
  }

  private static JsonNode status(BackendFixture f, String path, String token, String expected) {
    var result = new AtomicReference<JsonNode>();
    await()
        .atMost(Duration.ofSeconds(55))
        .pollInterval(Duration.ofMillis(500))
        .until(
            () -> {
              result.set(f.request("GET", path, token, null, 200));
              assertThat(result.get().path("status").asString())
                  .as(result.get().toString())
                  .isNotIn("FAILED", "REJECTED", "CANCELLED", "BLOCKED");
              return result.get().path("status").asString().equals(expected);
            });
    return result.get();
  }

  private static JsonNode balances(BackendFixture f, String token) throws Exception {
    return f.request("GET", "/v1/balances", token, null, 200);
  }

  private static JsonNode position(BackendFixture f, String token, String pool) throws Exception {
    for (var item : f.request("GET", "/v1/lp/positions", token, null, 200).path("items"))
      if (item.path("poolId").asString().equals(pool)) return item;
    throw new AssertionError("LP position missing");
  }

  private static JsonNode monitor(BackendFixture f, String operator, String pool) throws Exception {
    return f.request("GET", "/v1/admin/monitoring?poolId=" + pool, operator, null, 200);
  }

  private static BigDecimal balance(JsonNode balances, String symbol, String field) {
    for (var item : balances.path("balances"))
      if (item.path("symbol").asString().equals(symbol)) return amount(item, field);
    throw new AssertionError("Balance missing: " + symbol);
  }

  private static BigDecimal amount(JsonNode node, String field) {
    return new BigDecimal(node.path(field).asString());
  }
}
