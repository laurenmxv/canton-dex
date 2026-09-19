package com.openzeppelin.dex.bootstrap;

import com.openzeppelin.dex.canton.*;
import java.nio.file.Path;
import java.util.*;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;

public final class BootstrapMain {
  private BootstrapMain() {}

  public static void main(String[] args) throws Exception {
    new ResourceDatabasePopulator(new ClassPathResource("db/V1__schema.sql"))
        .execute(DevelopmentFixtures.dataSource());
    try (var fixtures = new DevelopmentFixtures()) {
      fixtures.admin().uploadAndVet(Path.of("../contracts/.daml/dist/oz-dex-ri-dvv-0.0.1.dar"));
      fixtures.keycloak().enableRegistration();
      fixtures
          .admin()
          .ensureBrowserOperator(
              DevelopmentFixtures.env("DEX_REGISTRATION_IDENTITY_PROVIDER_ID"),
              DevelopmentFixtures.env("DEX_IAM_ISSUER"),
              DevelopmentFixtures.env("DEX_IAM_JWK_SET_URI"),
              "00000000-0000-0000-0000-000000000003");
      var dvv = fixtures.actor("dvv");
      var base = fixtures.actor("base-admin");
      var quote = fixtures.actor("quote-admin");
      var operator = fixtures.actor("operator", DevelopmentFixtures.operatorIdentity(), List.of());
      fixtures.account("operator", "00000000-0000-0000-0000-000000000003", "OPERATOR");
      try (var authority = DevelopmentFixtures.connection(dvv.identity());
          var op = DevelopmentFixtures.connection(operator.identity());
          var baseAdmin = DevelopmentFixtures.connection(base.identity());
          var quoteAdmin = DevelopmentFixtures.connection(quote.identity())) {
        fixtures
            .sql()
            .sql(
                "INSERT INTO venue_configuration(id,synchronizer_id,participant_id) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET synchronizer_id=EXCLUDED.synchronizer_id,participant_id=EXCLUDED.participant_id")
            .params(op.singleSynchronizer(), fixtures.admin().participantId())
            .update();
        fixtures.sql().sql("UPDATE pools SET active=false WHERE active").update();
        boolean reused = false;
        for (var row :
            fixtures
                .sql()
                .sql("SELECT * FROM pools WHERE package_id=?")
                .param(PoolFixture.packageId())
                .query()
                .listOfRows()) {
          var ids =
              new PoolFixture.Contracts(
                  (String) row.get("pool_id"),
                  (String) row.get("config_id"),
                  (String) row.get("state_id"),
                  (String) row.get("package_id"));
          if (PoolFixture.compatible(op, dvv.party(), operator.party(), ids)) {
            fixtures
                .sql()
                .sql("UPDATE pools SET active=true WHERE pool_id=?")
                .param(row.get("pool_id"))
                .update();
            reused = true;
          }
        }
        if (!reused) {
          var pool = PoolFixture.create(authority, op, baseAdmin, quoteAdmin);
          fixtures
              .sql()
              .sql(
                  "INSERT INTO pools(pool_id,config_id,state_id,package_id,name,active) VALUES(?,?,?,?,?,true)")
              .params(
                  pool.poolId(),
                  pool.configId(),
                  pool.stateId(),
                  pool.packageId(),
                  "BASE/QUOTE fixture "
                      + PoolFixture.packageId().substring(0, 8)
                      + " "
                      + UUID.randomUUID().toString().substring(0, 8))
              .update();
        }
      }
      System.out.println(
          "Bootstrap complete: current-package dvv pool and self-registration ready.");
    }
  }
}
