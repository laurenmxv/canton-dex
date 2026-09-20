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
      if (fixtures
              .sql()
              .sql("SELECT count(*) FROM pools WHERE package_id<>?")
              .param(PoolFixture.packageId())
              .query(Long.class)
              .single()
          != 0L) {
        throw new IllegalStateException(
            "This contract generation needs fresh local participant and application databases");
      }
      fixtures.admin().uploadAndVet(Path.of("../contracts/.daml/dist/canton-dex-ri-0.1.0.dar"));
      fixtures
          .admin()
          .uploadAndVet(
              Path.of("../contracts/test-faucet/.daml/dist/canton-dex-test-faucet-0.1.0.dar"));
      fixtures.keycloak().enableRegistration();
      fixtures
          .admin()
          .ensureBrowserOperator(
              DevelopmentFixtures.env("DEX_REGISTRATION_IDENTITY_PROVIDER_ID"),
              DevelopmentFixtures.env("DEX_IAM_ISSUER"),
              DevelopmentFixtures.env("DEX_IAM_JWK_SET_URI"),
              "00000000-0000-0000-0000-000000000003");
      var dvo = fixtures.actor("dvo");
      fixtures.actor("base-admin");
      fixtures.actor("quote-admin");
      var issuer = fixtures.actor("test-token-issuer-cip112");
      var operator =
          fixtures.actor("operator", DevelopmentFixtures.operatorIdentity(), List.of(dvo.party()));
      fixtures.account("operator", "00000000-0000-0000-0000-000000000003", "OPERATOR");
      try (var authority = DevelopmentFixtures.connection(dvo.identity());
          var op = DevelopmentFixtures.connection(operator.identity());
          var tokenIssuer = DevelopmentFixtures.connection(issuer.identity())) {
        fixtures
            .sql()
            .sql(
                "INSERT INTO venue_configuration(id,synchronizer_id,participant_id) VALUES(1,?,?)"
                    + " ON CONFLICT(id) DO UPDATE SET"
                    + " synchronizer_id=EXCLUDED.synchronizer_id,participant_id=EXCLUDED.participant_id")
            .params(op.singleSynchronizer(), fixtures.admin().participantId())
            .update();
        new TestTokenFixture(fixtures.sql(), tokenIssuer, authority, op).initialize();
      }
      System.out.println(
          "Bootstrap complete: funded BTC/USDC and ETH/USDC test pools and self-registration"
              + " ready.");
    }
  }
}
