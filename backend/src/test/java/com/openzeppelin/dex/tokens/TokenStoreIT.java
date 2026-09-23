package com.openzeppelin.dex.tokens;

import static com.openzeppelin.dex.tokens.TokenModels.*;
import static org.assertj.core.api.Assertions.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;

@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "swaps|all")
@EnabledIfEnvironmentVariable(named = "DEX_TOKEN_TEST_DATABASE_URL", matches = ".+")
class TokenStoreIT {
  private final String schema = "token_test_" + UUID.randomUUID().toString().replace("-", "");
  private final UUID accountId = UUID.randomUUID();
  private final String partyId = "test-party-" + UUID.randomUUID();
  private PGSimpleDataSource dataSource;
  private JdbcClient sql;
  private TokenStore store;

  @BeforeEach
  void createIsolatedSchema() {
    dataSource = new PGSimpleDataSource();
    dataSource.setURL(System.getenv("DEX_TOKEN_TEST_DATABASE_URL"));
    JdbcClient.create(dataSource).sql("CREATE SCHEMA " + schema).update();
    dataSource.setCurrentSchema(schema);
    sql = JdbcClient.create(dataSource);
    new ResourceDatabasePopulator(new ClassPathResource("db/V1__schema.sql")).execute(dataSource);
    store = new TokenStore(sql);
    insertAccount(accountId);
  }

  @AfterEach
  void dropIsolatedSchema() {
    if (dataSource != null) {
      dataSource.setCurrentSchema("public");
      JdbcClient.create(dataSource).sql("DROP SCHEMA IF EXISTS " + schema + " CASCADE").update();
    }
  }

  @Test
  void concurrentInitializationCreatesOneDurableGrantIdentity() throws Exception {
    var results =
        concurrent(
            () -> store.initialize(accountId, partyId), () -> store.initialize(accountId, partyId));
    assertThat(results.getFirst()).isEqualTo(results.getLast());
    assertThat(sql.sql("SELECT count(*) FROM dev_faucet_claims").query(Integer.class).single())
        .isEqualTo(1);
    var restarted = new TokenStore(JdbcClient.create(dataSource));
    assertThat(restarted.initialize(accountId, partyId)).isEqualTo(results.getFirst());
  }

  @Test
  void anotherAccountCannotCreateAnotherGrantForTheSameParty() {
    Claim original = store.initialize(accountId, partyId);
    UUID anotherAccount = UUID.randomUUID();
    insertAccount(anotherAccount);
    assertThatThrownBy(() -> store.initialize(anotherAccount, partyId))
        .isInstanceOf(TokenConflict.class)
        .hasMessageContaining("already has a test token request");
    assertThat(store.get(anotherAccount)).isEmpty();
    assertThat(store.get(accountId)).contains(original);
    assertThat(sql.sql("SELECT count(*) FROM dev_faucet_claims").query(Integer.class).single())
        .isEqualTo(1);
  }

  @Test
  void concurrentGrantDispatchHasOneWriterAndPreservesItsAttemptAcrossRestart() throws Exception {
    Claim original = store.initialize(accountId, partyId);
    assertThat(
            concurrent(
                () -> store.claimGrant(accountId, 101), () -> store.claimGrant(accountId, 102)))
        .containsExactlyInAnyOrder(true, false);
    Claim reserved = store.get(accountId).orElseThrow();
    assertThat(reserved.grantStatus()).isEqualTo(GrantStatus.SUBMITTING);
    assertThat(reserved.grantBeginOffset()).isIn(101L, 102L);
    assertThat(reserved.grantId()).isEqualTo(original.grantId());
    assertThat(reserved.grantCommandId()).isNotEqualTo(original.grantCommandId());
    var restarted = new TokenStore(JdbcClient.create(dataSource));
    assertThat(restarted.get(accountId)).contains(reserved);
    assertThat(restarted.claimGrant(accountId, 200)).isFalse();
    store.unresolvedGrant(accountId, reserved.grantCommandId());
    Claim unresolved = restarted.get(accountId).orElseThrow();
    assertThat(unresolved.grantStatus()).isEqualTo(GrantStatus.UNRESOLVED);
    assertThat(unresolved.grantCommandId()).isEqualTo(reserved.grantCommandId());
    assertThat(unresolved.grantBeginOffset()).isEqualTo(reserved.grantBeginOffset());
    assertThat(restarted.claimGrant(accountId, 300)).isFalse();
  }

  @Test
  void concurrentPreparationsCannotReplaceTheWinningFreshPreparation() throws Exception {
    confirmGrant();
    UUID firstId = UUID.randomUUID();
    UUID secondId = UUID.randomUUID();
    Prepared first = preparation("first");
    Prepared second = preparation("second");
    assertThat(
            concurrent(
                () -> store.savePreparation(accountId, firstId, first),
                () -> store.savePreparation(accountId, secondId, second)))
        .containsExactlyInAnyOrder(true, false);
    Claim winner = store.get(accountId).orElseThrow();
    assertThat(winner.status()).isEqualTo(Status.PREPARED);
    assertThat(winner.preparationId()).isIn(firstId, secondId);
    assertThat(winner.prepared())
        .isEqualTo(winner.preparationId().equals(firstId) ? first : second);
    assertThat(store.savePreparation(accountId, UUID.randomUUID(), preparation("replacement")))
        .isFalse();
    assertThat(store.get(accountId)).contains(winner);
  }

  @Test
  void expiredPreparationCanRefreshButItsOldIdCannotSubmit() {
    confirmGrant();
    UUID expiredId = UUID.randomUUID();
    assertThat(store.savePreparation(accountId, expiredId, preparation("expired"))).isTrue();
    sql.sql("UPDATE dev_faucet_claims SET expires_at=now()-interval '1 second' WHERE account_id=?")
        .param(accountId)
        .update();
    assertThat(store.claimSubmission(accountId, expiredId, 100)).isFalse();
    UUID refreshedId = UUID.randomUUID();
    Prepared refreshed = preparation("refreshed");
    assertThat(store.savePreparation(accountId, refreshedId, refreshed)).isTrue();
    assertThat(store.claimSubmission(accountId, expiredId, 100)).isFalse();
    Claim saved = store.get(accountId).orElseThrow();
    assertThat(saved.preparationId()).isEqualTo(refreshedId);
    assertThat(saved.prepared()).isEqualTo(refreshed);
    assertThat(saved.claimBeginOffset()).isNull();
  }

  @Test
  void concurrentClaimDispatchHasOneWriter() throws Exception {
    UUID preparationId = prepareClaim();
    assertThat(store.claimSubmission(accountId, UUID.randomUUID(), 999)).isFalse();
    assertThat(
            concurrent(
                () -> store.claimSubmission(accountId, preparationId, 201),
                () -> store.claimSubmission(accountId, preparationId, 202)))
        .containsExactlyInAnyOrder(true, false);
    Claim reserved = store.get(accountId).orElseThrow();
    assertThat(reserved.status()).isEqualTo(Status.SUBMITTING);
    assertThat(reserved.claimBeginOffset()).isIn(201L, 202L);
    assertThat(reserved.preparationId()).isEqualTo(preparationId);
    assertThat(store.savePreparation(accountId, UUID.randomUUID(), preparation("late"))).isFalse();
  }

  @Test
  void restartPreservesUncertainClaimWithoutCreatingAnotherGrantOrPreparation() {
    UUID preparationId = prepareClaim();
    assertThat(store.claimSubmission(accountId, preparationId, 300)).isTrue();
    store.unresolved(accountId, preparationId);
    Claim saved = store.get(accountId).orElseThrow();
    var restarted = new TokenStore(JdbcClient.create(dataSource));
    assertThat(restarted.initialize(accountId, partyId)).isEqualTo(saved);
    assertThat(restarted.get(accountId)).contains(saved);
    assertThat(restarted.claimGrant(accountId, 400)).isFalse();
    assertThat(restarted.claimSubmission(accountId, preparationId, 400)).isFalse();
    assertThat(restarted.savePreparation(accountId, UUID.randomUUID(), preparation("restart")))
        .isFalse();
  }

  @Test
  void completedClaimCannotBeReopenedByLateWorkersOrRestart() {
    UUID preparationId = prepareClaim();
    assertThat(store.claimSubmission(accountId, preparationId, 500)).isTrue();
    store.complete(accountId, preparationId, new Confirmation("receipt", "committed-update"));
    Claim completed = store.get(accountId).orElseThrow();
    store.unresolved(accountId, preparationId);
    store.rejected(accountId, preparationId);
    store.unresolvedGrant(accountId, completed.grantCommandId());
    store.rejectedGrant(accountId, completed.grantCommandId());
    store.confirmGrant(
        accountId, completed.grantCommandId(), new Confirmation("wrong-grant", "wrong-update"));
    store.complete(accountId, preparationId, new Confirmation("wrong-receipt", "wrong-update"));
    assertThat(store.claimSubmission(accountId, preparationId, 600)).isFalse();
    assertThat(store.savePreparation(accountId, UUID.randomUUID(), preparation("late"))).isFalse();
    var restarted = new TokenStore(JdbcClient.create(dataSource));
    assertThat(restarted.initialize(accountId, partyId)).isEqualTo(completed);
    assertThat(restarted.get(accountId)).contains(completed);
  }

  @Test
  void staleGrantRecoveryCannotResetOrConfirmANewerDispatch() {
    store.initialize(accountId, partyId);
    assertThat(store.claimGrant(accountId, 100)).isTrue();
    UUID oldCommandId = store.get(accountId).orElseThrow().grantCommandId();
    store.rejectedGrant(accountId, oldCommandId);
    assertThat(store.claimGrant(accountId, 200)).isTrue();
    Claim current = store.get(accountId).orElseThrow();
    assertThat(current.grantCommandId()).isNotEqualTo(oldCommandId);
    store.rejectedGrant(accountId, oldCommandId);
    store.unresolvedGrant(accountId, oldCommandId);
    store.confirmGrant(accountId, oldCommandId, new Confirmation("stale-grant", "stale-update"));
    assertThat(store.get(accountId)).contains(current);
    assertThat(store.claimGrant(accountId, 300)).isFalse();
  }

  @Test
  void startingGrantRecoveryPreventsLateInitialRejectionFromReopeningIssuance() {
    store.initialize(accountId, partyId);
    assertThat(store.claimGrant(accountId, 100)).isTrue();
    UUID commandId = store.get(accountId).orElseThrow().grantCommandId();
    assertThat(store.beginGrantRecovery(accountId, commandId)).isTrue();
    Claim recovering = store.get(accountId).orElseThrow();
    assertThat(recovering.grantStatus()).isEqualTo(GrantStatus.UNRESOLVED);
    store.rejectedGrant(accountId, commandId);
    assertThat(store.get(accountId)).contains(recovering);
    assertThat(store.claimGrant(accountId, 200)).isFalse();
    assertThat(store.beginGrantRecovery(accountId, commandId)).isTrue();
    assertThat(store.get(accountId).orElseThrow().grantCommandId()).isEqualTo(commandId);
    store.excludeGrant(accountId, commandId);
    assertThat(store.get(accountId).orElseThrow().grantStatus()).isEqualTo(GrantStatus.PENDING);
    assertThat(store.claimGrant(accountId, 200)).isTrue();
    Claim replacement = store.get(accountId).orElseThrow();
    store.excludeGrant(accountId, commandId);
    assertThat(store.get(accountId)).contains(replacement);
  }

  @Test
  void initialGrantRejectionPreventsAStaleRecoveryFromDispatching() {
    store.initialize(accountId, partyId);
    assertThat(store.claimGrant(accountId, 100)).isTrue();
    UUID commandId = store.get(accountId).orElseThrow().grantCommandId();
    store.rejectedGrant(accountId, commandId);
    Claim rejected = store.get(accountId).orElseThrow();
    assertThat(rejected.grantStatus()).isEqualTo(GrantStatus.PENDING);
    assertThat(store.beginGrantRecovery(accountId, commandId)).isFalse();
    assertThat(store.get(accountId)).contains(rejected);
  }

  @Test
  void staleClaimRecoveryCannotResetOrCompleteANewerPreparation() {
    UUID oldPreparationId = prepareClaim();
    assertThat(store.claimSubmission(accountId, oldPreparationId, 100)).isTrue();
    store.rejected(accountId, oldPreparationId);
    UUID currentPreparationId = UUID.randomUUID();
    assertThat(store.savePreparation(accountId, currentPreparationId, preparation("new-attempt")))
        .isTrue();
    assertThat(store.claimSubmission(accountId, currentPreparationId, 200)).isTrue();
    Claim current = store.get(accountId).orElseThrow();
    store.rejected(accountId, oldPreparationId);
    store.unresolved(accountId, oldPreparationId);
    store.complete(accountId, oldPreparationId, new Confirmation("stale-receipt", "stale-update"));
    assertThat(store.get(accountId)).contains(current);
    assertThat(store.savePreparation(accountId, UUID.randomUUID(), preparation("unexpected")))
        .isFalse();
  }

  private void insertAccount(UUID id) {
    sql.sql(
            "INSERT INTO accounts(id,issuer,subject,display_name,role)"
                + " VALUES(?,'test',?,'Trader','TRADER')")
        .params(id, id.toString())
        .update();
  }

  private void confirmGrant() {
    store.initialize(accountId, partyId);
    assertThat(store.claimGrant(accountId, 10)).isTrue();
    store.confirmGrant(
        accountId,
        store.get(accountId).orElseThrow().grantCommandId(),
        new Confirmation("grant", "grant-update"));
  }

  private UUID prepareClaim() {
    confirmGrant();
    UUID preparationId = UUID.randomUUID();
    assertThat(store.savePreparation(accountId, preparationId, preparation("claim"))).isTrue();
    return preparationId;
  }

  private static Prepared preparation(String value) {
    return new Prepared(
        "transaction-" + value,
        "hash-" + value,
        3,
        Instant.now().plusSeconds(300).truncatedTo(ChronoUnit.MILLIS));
  }

  private static <T> List<T> concurrent(Callable<T> first, Callable<T> second) throws Exception {
    CountDownLatch start = new CountDownLatch(1);
    try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
      var a =
          executor.submit(
              () -> {
                start.await();
                return first.call();
              });
      var b =
          executor.submit(
              () -> {
                start.await();
                return second.call();
              });
      start.countDown();
      return List.of(a.get(10, TimeUnit.SECONDS), b.get(10, TimeUnit.SECONDS));
    }
  }
}
