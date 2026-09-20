package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.assertThat;

import com.daml.ledger.javaapi.data.DamlRecord;
import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import com.openzeppelin.dex.canton.generated.pool.*;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "environment|all")
class EnvironmentIT {
  @Test
  void actualInfrastructureAndContractsAreReady() throws Exception {
    try (var fixtures = new DevelopmentFixtures();
        var ledger = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity());
        var http = HttpClient.newHttpClient()) {
      assertThat(
              fixtures
                  .sql()
                  .sql(
                      "SELECT table_name FROM information_schema.tables WHERE"
                          + " table_schema=current_schema()")
                  .query(String.class)
                  .list())
          .contains(
              "accounts",
              "fixture_parties",
              "pools",
              "onboardings",
              "onboarding_steps",
              "venue_configuration",
              "pool_proposals",
              "pool_pair_claims");
      var discovery =
          http.send(
              HttpRequest.newBuilder(
                      URI.create(
                          DevelopmentFixtures.env("DEX_BOOTSTRAP_KEYCLOAK_URL")
                              + "/realms/Dex/.well-known/openid-configuration"))
                  .timeout(Duration.ofSeconds(10))
                  .GET()
                  .build(),
              HttpResponse.BodyHandlers.ofString());
      assertThat(discovery.statusCode()).isEqualTo(200);
      assertThat(discovery.body()).contains(DevelopmentFixtures.env("DEX_IAM_ISSUER"));
      assertThat(ledger.ledgerEnd()).isPositive();
      assertThat(ledger.connected()).isTrue();
      assertThat(fixtures.admin().rights(DevelopmentFixtures.operatorIdentity().userId()))
          .noneMatch(
              right ->
                  right.hasParticipantAdmin()
                      || right.hasCanReadAsAnyParty()
                      || right.hasCanExecuteAsAnyParty());
      assertThat(ledger.hasPackage(Pool.PACKAGE_ID)).isTrue();
      String authority =
          fixtures
              .sql()
              .sql("SELECT party_id FROM fixture_parties WHERE name = 'dvo'")
              .query(String.class)
              .single();
      var runtimeRights = fixtures.admin().rights(DevelopmentFixtures.operatorIdentity().userId());
      assertThat(
              runtimeRights.stream()
                  .filter(r -> r.hasCanActAs())
                  .map(r -> r.getCanActAs().getParty()))
          .containsExactly(ledger.primaryParty());
      var rows =
          fixtures
              .sql()
              .sql(
                  """
                  SELECT p.*, t.pair FROM test_token_pools t JOIN pools p ON p.pool_id=t.pool_id
                  WHERE p.active ORDER BY t.pair
                  """)
              .query()
              .listOfRows();
      assertThat(rows).extracting(r -> r.get("pair")).containsExactly("BTC/USDC", "ETH/USDC");
      var names = new HashMap<String, String>();
      rows.forEach(r -> names.put((String) r.get("pool_id"), (String) r.get("name")));
      var catalog = new CantonPoolLedger(ledger).pools(names, authority);
      var events = ledger.activeContracts(ledger.primaryParty(), Pool.TEMPLATE_ID);
      String issuer =
          fixtures
              .sql()
              .sql("SELECT issuer_party_id FROM test_token_configuration WHERE id=1")
              .query(String.class)
              .single();
      assertThat(
              runtimeRights.stream()
                  .filter(r -> r.hasCanReadAs())
                  .map(r -> r.getCanReadAs().getParty()))
          .contains(authority)
          .doesNotContain(issuer);
      for (var row : rows) {
        String poolId = (String) row.get("pool_id");
        var event =
            events.stream().filter(e -> e.getContractId().equals(poolId)).findFirst().orElseThrow();
        String sourcePackage = event.getTemplateId().getPackageId();
        assertThat(sourcePackage).isEqualTo(Pool.PACKAGE_ID);
        assertThat(row.get("package_id")).isEqualTo(sourcePackage);
        var pool = Pool.valueDecoder().decode(DamlRecord.fromProto(event.getCreateArguments()));
        assertThat(pool.dvo).isEqualTo(authority);
        assertThat(pool.venueOperator).isEqualTo(ledger.primaryParty());
        assertThat(event.getSignatoriesList()).containsExactly(authority);
        assertThat(event.getObserversList()).contains(ledger.primaryParty());
        assertThat(pool.lpTokenInstrumentId.admin).isEqualTo(authority);
        assertThat(pool.baseAccount.owner).contains(authority);
        assertThat(pool.quoteAccount.owner).contains(authority);
        assertThat(pool.baseAccount.provider).isEmpty();
        assertThat(pool.quoteAccount.provider).isEmpty();
        assertThat(pool.baseAccount.id).isNotBlank().isNotEqualTo(pool.quoteAccount.id);
        assertThat(pool.baseInstrumentId.admin).isEqualTo(issuer);
        assertThat(pool.quoteInstrumentId.admin).isEqualTo(issuer);
        assertThat(pool.baseInstrumentId.id + "/" + pool.quoteInstrumentId.id)
            .isEqualTo(row.get("pair"));
        var detail =
            catalog.stream().filter(p -> p.poolId().equals(poolId)).findFirst().orElseThrow();
        assertThat(detail.packageId()).isEqualTo(sourcePackage);
        assertThat(detail.settings().dvo()).isEqualTo(authority);
        assertThat(new BigDecimal(detail.settings().baseReserve())).isPositive();
        assertThat(new BigDecimal(detail.settings().quoteReserve())).isPositive();
        assertThat(new BigDecimal(detail.settings().lpTokenSupply())).isPositive();
        SwapLedgerAssertions.backing(ledger, poolId);
      }
      System.out.println(
          "PASS environment: real PostgreSQL, Keycloak, authenticated ledger, approved DAR versions"
              + " and backed fixture pools.");
    }
  }
}
