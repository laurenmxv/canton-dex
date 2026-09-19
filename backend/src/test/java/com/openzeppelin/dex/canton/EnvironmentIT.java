package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.assertThat;

import com.daml.ledger.javaapi.data.DamlRecord;
import com.openzeppelin.dex.bootstrap.DevelopmentFixtures;
import com.openzeppelin.dex.canton.generated.pool.*;
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
                      "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()")
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
      var row =
          fixtures
              .sql()
              .sql("SELECT * FROM pools WHERE active ORDER BY name LIMIT 1")
              .query()
              .singleRow();
      assertThat(row.get("package_id")).isEqualTo(Pool.PACKAGE_ID);
      String authority =
          fixtures
              .sql()
              .sql("SELECT party_id FROM fixture_parties WHERE name = 'dvv'")
              .query(String.class)
              .single();
      var runtimeRights = fixtures.admin().rights(DevelopmentFixtures.operatorIdentity().userId());
      assertThat(
              runtimeRights.stream()
                  .filter(r -> r.hasCanActAs())
                  .map(r -> r.getCanActAs().getParty()))
          .containsExactly(ledger.primaryParty());
      var pools = ledger.activeContracts(ledger.primaryParty(), Pool.TEMPLATE_ID);
      var event =
          pools.stream()
              .filter(e -> e.getContractId().equals(row.get("pool_id")))
              .findFirst()
              .orElseThrow();
      assertThat(event.getTemplateId().getPackageId()).isEqualTo(Pool.PACKAGE_ID);
      var pool = Pool.valueDecoder().decode(DamlRecord.fromProto(event.getCreateArguments()));
      var roles =
          fixtures
              .sql()
              .sql("SELECT name, party_id FROM fixture_parties")
              .query()
              .listOfRows()
              .stream()
              .collect(
                  java.util.stream.Collectors.toMap(
                      r -> (String) r.get("name"), r -> (String) r.get("party_id")));
      assertThat(pool.dvv).isEqualTo(authority);
      assertThat(pool.venueOperator).isEqualTo(ledger.primaryParty());
      assertThat(event.getSignatoriesList()).containsExactly(authority);
      assertThat(event.getObserversList()).contains(ledger.primaryParty());
      assertThat(pool.lpTokenInstrumentId.admin).isEqualTo(authority);
      assertThat(pool.baseAccount.owner).contains(authority);
      assertThat(pool.quoteAccount.owner).contains(authority);
      assertThat(pool.baseInstrumentId.admin).isNotEqualTo(authority);
      assertThat(pool.quoteInstrumentId.admin).isNotEqualTo(authority);
      assertThat(ledger.primaryParty()).isEqualTo(roles.get("operator"));
      assertThat(pool.baseInstrumentId.id).isEqualTo("BASE");
      assertThat(pool.quoteInstrumentId.id).isEqualTo("QUOTE");
      var configEvent =
          ledger.activeContracts(ledger.primaryParty(), PoolConfig.TEMPLATE_ID).stream()
              .filter(e -> e.getContractId().equals(row.get("config_id")))
              .findFirst()
              .orElseThrow();
      var stateEvent =
          ledger.activeContracts(ledger.primaryParty(), PoolState.TEMPLATE_ID).stream()
              .filter(e -> e.getContractId().equals(row.get("state_id")))
              .findFirst()
              .orElseThrow();
      var config =
          PoolConfig.valueDecoder().decode(DamlRecord.fromProto(configEvent.getCreateArguments()));
      var state =
          PoolState.valueDecoder().decode(DamlRecord.fromProto(stateEvent.getCreateArguments()));
      assertThat(config.poolCid.contractId).isEqualTo(row.get("pool_id"));
      assertThat(state.poolCid.contractId).isEqualTo(row.get("pool_id"));
      assertThat(config.dvv).isEqualTo(authority);
      assertThat(state.dvv).isEqualTo(authority);
      assertThat(config.venueOperator).isEqualTo(ledger.primaryParty());
      assertThat(state.venueOperator).isEqualTo(ledger.primaryParty());
      assertThat(config.feeBps).isEqualByComparingTo("30");
      assertThat(state.baseReserve).isEqualByComparingTo("997");
      assertThat(state.quoteReserve).isEqualByComparingTo("1000");
      assertThat(state.lpTokenSupply).isEqualByComparingTo("1000");
      System.out.println(
          "PASS environment: real PostgreSQL, Keycloak, authenticated ledger, exact DAR and pool contracts.");
    }
  }
}
