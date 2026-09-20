package com.openzeppelin.dex.tokens;

import static org.assertj.core.api.Assertions.*;

import java.util.UUID;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;

@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "swaps|all")
@EnabledIfEnvironmentVariable(named = "DEX_SETTLEMENT_TEST_DATABASE_URL", matches = ".+")
class TokenRegistryStoreIT {
  private final String schema = "registry_test_" + UUID.randomUUID().toString().replace("-", "");
  private PGSimpleDataSource dataSource;
  private JdbcClient sql;

  @BeforeEach
  void createSchema() {
    dataSource = new PGSimpleDataSource();
    dataSource.setURL(System.getenv("DEX_SETTLEMENT_TEST_DATABASE_URL"));
    JdbcClient.create(dataSource).sql("CREATE SCHEMA " + schema).update();
    dataSource.setCurrentSchema(schema);
    sql = JdbcClient.create(dataSource);
    new ResourceDatabasePopulator(new ClassPathResource("db/V1__schema.sql")).execute(dataSource);
  }

  @AfterEach
  void dropSchema() {
    if (dataSource != null) {
      dataSource.setCurrentSchema("public");
      JdbcClient.create(dataSource).sql("DROP SCHEMA IF EXISTS " + schema + " CASCADE").update();
    }
  }

  @Test
  void issuerConfigurationAndOverlappingInstrumentNamesSurviveStoreRestart() {
    sql.sql(
            "INSERT INTO token_registries(admin,allocation_factory_id,settlement_factory_id)"
                + " VALUES('alice','alice-allocate','alice-settle'),('bob','bob-allocate','bob-settle')")
        .update();
    sql.sql(
            "INSERT INTO token_instruments(admin,instrument_id,symbol,decimals)"
                + " VALUES('alice','USD','USD',6),('bob','USD','USD',8)")
        .update();
    sql.sql(
            "INSERT INTO"
                + " token_registry_contracts(admin,contract_id,template_id,created_event_blob,synchronizer_id)"
                + " VALUES('alice','alice-allocate','alice:Token:Allocator','BwgJ','sync-alice'),"
                + " ('bob','bob-allocate','foreign:Token:Allocator','AQID','sync-bob'),"
                + " ('bob','bob-settle','other:Token:Settler','BAUG','sync-bob')")
        .update();

    var restarted = new TokenRegistryStore(sql);
    assertThat(restarted.source("alice").orElseThrow())
        .isEqualTo(new TokenRegistryStore.Source("alice", "alice-allocate", "alice-settle"));
    assertThat(restarted.source("bob").orElseThrow().allocationFactoryId())
        .isEqualTo("bob-allocate");
    assertThat(restarted.source("bob").orElseThrow().settlementFactoryId()).isEqualTo("bob-settle");
    assertThat(restarted.disclosures("alice", "bob-allocate")).isEmpty();
    assertThat(restarted.disclosures("bob", "alice-allocate")).isEmpty();
    assertThat(restarted.disclosures("alice", "alice-allocate"))
        .containsExactly(
            new TokenRegistryStore.Disclosure(
                "alice:Token:Allocator", "alice-allocate", "BwgJ", "sync-alice"));
    assertThat(restarted.disclosures("bob", "bob-settle"))
        .containsExactly(
            new TokenRegistryStore.Disclosure(
                "other:Token:Settler", "bob-settle", "BAUG", "sync-bob"));
    assertThat(restarted.instruments())
        .containsExactly(
            new TokenRegistryStore.Instrument("alice", "USD", "USD", 6),
            new TokenRegistryStore.Instrument("bob", "USD", "USD", 8));
    assertThat(restarted.source("unknown")).isEmpty();
  }
}
