package com.openzeppelin.dex.pools;

import static com.openzeppelin.dex.pools.PoolModels.*;
import static org.assertj.core.api.Assertions.*;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import tools.jackson.databind.json.JsonMapper;

@Tag("integration")
@EnabledIfEnvironmentVariable(named = "DEX_SETTLEMENT_TEST_DATABASE_URL", matches = ".+")
class PoolStoreIT {
  private final String schema = "pool_store_test_" + UUID.randomUUID().toString().replace("-", "");
  private final JsonMapper json = JsonMapper.builder().build();
  private final Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
  private final Terms terms =
      new Terms(
          "dvo",
          new Instrument("issuer", "BTC"),
          new Instrument("issuer", "USDC"),
          new ReserveAccount("dvo", "provider", "base"),
          new ReserveAccount("dvo", "provider", "quote"),
          new Instrument("dvo", "LP"),
          "30",
          "100",
          "200",
          "100");
  private PGSimpleDataSource dataSource;
  private JdbcClient sql;

  @BeforeEach
  void createIsolatedSchema() {
    dataSource = new PGSimpleDataSource();
    dataSource.setURL(System.getenv("DEX_SETTLEMENT_TEST_DATABASE_URL"));
    JdbcClient.create(dataSource).sql("CREATE SCHEMA " + schema).update();
    dataSource.setCurrentSchema(schema);
    sql = JdbcClient.create(dataSource);
  }

  @AfterEach
  void dropIsolatedSchema() {
    if (dataSource != null) {
      dataSource.setCurrentSchema("public");
      JdbcClient.create(dataSource).sql("DROP SCHEMA IF EXISTS " + schema + " CASCADE").update();
    }
  }

  @Test
  void repeatedV1InitializationPreservesPool() {
    initialize();
    sql.sql(
            """
            INSERT INTO pools(pool_id,config_id,state_id,package_id,name,active,settings,created_at,updated_at)
            VALUES('pool','config','state','package','Test pool',true,?::jsonb,?,?)
            """)
        .params(json.writeValueAsString(terms), Timestamp.from(now), Timestamp.from(now))
        .update();

    initialize();
    initialize();

    Detail expected =
        new Detail("pool", "Test pool", terms, "config", "state", "package", now, now);
    Detail restored = store().pool("pool", "package");
    assertThat(restored).isEqualTo(expected);
    assertThat(store().pools("package")).containsExactly(expected);
    assertThat(
            sql.sql("SELECT count(*) FROM pools WHERE pool_id='pool'")
                .query(Integer.class)
                .single())
        .isEqualTo(1);
  }

  private void initialize() {
    new ResourceDatabasePopulator(new ClassPathResource("db/V1__schema.sql")).execute(dataSource);
  }

  private PoolStore store() {
    return new PoolStore(sql, json, new DataSourceTransactionManager(dataSource));
  }
}
