package com.openzeppelin.dex.bootstrap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.openzeppelin.dex.iam.AccountDirectory;
import java.util.UUID;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;

@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "schema|all")
class DatabaseSchemaIT {
  @Test
  void v1CreatesTheCurrentSchemaAndPreservesDataOnRepeatedInitialization() throws Exception {
    String schema = "dex_schema_test_" + UUID.randomUUID().toString().replace("-", "");
    try (var connection = DevelopmentFixtures.dataSource().getConnection()) {
      var dataSource = new SingleConnectionDataSource(connection, true);
      var sql = JdbcClient.create(dataSource);
      sql.sql("CREATE SCHEMA " + schema).update();
      try {
        connection.setSchema(schema);
        var initializer = new ResourceDatabasePopulator(new ClassPathResource("db/V1__schema.sql"));
        initializer.execute(dataSource);
        assertThat(
                sql.sql("SELECT table_name FROM information_schema.tables WHERE table_schema=?")
                    .param(schema)
                    .query(String.class)
                    .list())
            .containsExactlyInAnyOrder(
                "accounts",
                "fixture_parties",
                "pools",
                "onboardings",
                "onboarding_steps",
                "venue_configuration",
                "pool_proposals",
                "pool_pair_claims");

        var accounts = new AccountDirectory(sql);
        var david = accounts.authenticate("test-issuer", "david", "David");
        var other = accounts.authenticate("test-issuer", "other", "Other");
        assertThat(accounts.profile(david).partyId()).isNull();
        assertThatThrownBy(
                () ->
                    sql.sql("UPDATE accounts SET role='ADMIN' WHERE id=?")
                        .param(david.id())
                        .update())
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(
                () ->
                    sql.sql("UPDATE accounts SET subject='david' WHERE id=?")
                        .param(other.id())
                        .update())
            .isInstanceOf(DataIntegrityViolationException.class);

        var onboarding = UUID.randomUUID();
        sql.sql(
                "INSERT INTO onboardings(id,account_id,application,party_mode,prepared_party_id) VALUES(?,?,'{}','external','david-party')")
            .params(onboarding, david.id())
            .update();
        assertThatThrownBy(
                () ->
                    sql.sql(
                            "INSERT INTO onboardings(id,account_id,application,party_mode,prepared_party_id) VALUES(?,?,'{}','external','david-party')")
                        .params(UUID.randomUUID(), other.id())
                        .update())
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(
                () ->
                    sql.sql("INSERT INTO onboardings(id,account_id,application) VALUES(?,?,'{}')")
                        .params(UUID.randomUUID(), david.id())
                        .update())
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(
                () ->
                    sql.sql("INSERT INTO onboardings(id,account_id,application) VALUES(?,?,'{}')")
                        .params(UUID.randomUUID(), UUID.randomUUID())
                        .update())
            .isInstanceOf(DataIntegrityViolationException.class);

        sql.sql(
                "INSERT INTO onboarding_steps(onboarding_id,step_key,command_id,status,contract_id,begin_offset,update_id,issuer) VALUES(?,'attestation',?,'CONFIRMED','attestation-cid',7,'ledger-update','operator')")
            .params(onboarding, UUID.randomUUID())
            .update();
        assertThatThrownBy(
                () ->
                    sql.sql(
                            "INSERT INTO onboarding_steps(onboarding_id,step_key,command_id,status) VALUES(?,'permission',?,'CONFIRMED')")
                        .params(onboarding, UUID.randomUUID())
                        .update())
            .isInstanceOf(DataIntegrityViolationException.class);

        sql.sql(
                "INSERT INTO pools(pool_id,config_id,state_id,package_id,name) VALUES('pool-a','config-a','state-a','package','Shared label'),('pool-b','config-b','state-b','package','Shared label')")
            .update();
        var proposal = UUID.randomUUID();
        sql.sql(
                "INSERT INTO pool_proposals(id,name,settings,factory_id,proposed_by,status,command_id,begin_offset) VALUES(?,'Proposal','{}','factory',?,'FAILED',?,0)")
            .params(proposal, david.id(), UUID.randomUUID())
            .update();
        assertThatThrownBy(
                () ->
                    sql.sql("UPDATE pool_proposals SET status='INVALID' WHERE id=?")
                        .param(proposal)
                        .update())
            .isInstanceOf(DataIntegrityViolationException.class);
        sql.sql("INSERT INTO pool_pair_claims(pair_key,pool_id) VALUES('A/B','pool-a')").update();
        assertThatThrownBy(
                () ->
                    sql.sql("INSERT INTO pool_pair_claims(pair_key,pool_id) VALUES('A/B','pool-b')")
                        .update())
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(
                () -> sql.sql("INSERT INTO pool_pair_claims(pair_key) VALUES('C/D')").update())
            .isInstanceOf(DataIntegrityViolationException.class);

        initializer.execute(dataSource);
        assertThat(accounts.authenticate("test-issuer", "david", "David").id())
            .isEqualTo(david.id());
        assertThat(
                sql.sql("SELECT approved_pools::text FROM onboardings WHERE id=?")
                    .param(onboarding)
                    .query(String.class)
                    .single())
            .isEqualTo("[]");
        assertThat(
                sql.sql("SELECT contract_id FROM onboarding_steps WHERE onboarding_id=?")
                    .param(onboarding)
                    .query(String.class)
                    .single())
            .isEqualTo("attestation-cid");
        assertThat(
                sql.sql(
                        "SELECT count(*) FROM pools WHERE name='Shared label' AND NOT active AND updated_at IS NOT NULL")
                    .query(Integer.class)
                    .single())
            .isEqualTo(2);
        assertThat(
                sql.sql("SELECT status FROM pool_proposals WHERE id=?")
                    .param(proposal)
                    .query(String.class)
                    .single())
            .isEqualTo("FAILED");
        assertThat(
                sql.sql("SELECT pool_id FROM pool_pair_claims WHERE pair_key='A/B'")
                    .query(String.class)
                    .single())
            .isEqualTo("pool-a");
      } finally {
        connection.setSchema("public");
        sql.sql("DROP SCHEMA " + schema + " CASCADE").update();
      }
    }
  }
}
