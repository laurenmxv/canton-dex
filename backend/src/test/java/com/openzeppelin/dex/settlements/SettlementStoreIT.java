package com.openzeppelin.dex.settlements;

import static com.openzeppelin.dex.settlements.SettlementModels.*;
import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.liquidity.LiquidityModels;
import com.openzeppelin.dex.liquidity.LiquidityStore;
import com.openzeppelin.dex.operations.OperatorCommandStore;
import com.openzeppelin.dex.operations.OperatorCommandStore.Prepared;
import com.openzeppelin.dex.pools.PoolModels.Instrument;
import com.openzeppelin.dex.swaps.SwapFailure;
import com.openzeppelin.dex.swaps.SwapModels;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import tools.jackson.databind.json.JsonMapper;

@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "swaps|all")
@EnabledIfEnvironmentVariable(named = "DEX_SETTLEMENT_TEST_DATABASE_URL", matches = ".+")
class SettlementStoreIT {
  private final String schema = "settlement_test_" + UUID.randomUUID().toString().replace("-", "");
  private final UUID account = UUID.randomUUID();
  private final JsonMapper json = JsonMapper.builder().build();
  private final Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
  private final Reserves reserves = new Reserves("state", "100", "200", "2", "20000");
  private final Snapshot snapshot =
      new Snapshot("pool", "version-1", reserves, "30", "READY", null, now, 42, "100", "2");
  private PGSimpleDataSource dataSource;
  private JdbcClient sql;
  private SettlementStore store;

  @BeforeEach
  void createIsolatedSchema() {
    dataSource = new PGSimpleDataSource();
    dataSource.setURL(System.getenv("DEX_SETTLEMENT_TEST_DATABASE_URL"));
    JdbcClient.create(dataSource).sql("CREATE SCHEMA " + schema).update();
    dataSource.setCurrentSchema(schema);
    sql = JdbcClient.create(dataSource);
    new ResourceDatabasePopulator(new ClassPathResource("db/V1__schema.sql")).execute(dataSource);
    store = new SettlementStore(sql, json, new DataSourceTransactionManager(dataSource), 10);
    sql.sql(
            "INSERT INTO accounts(id,issuer,subject,display_name,role)"
                + " VALUES(?,'test','trader','Trader','TRADER')")
        .param(account)
        .update();
    sql.sql(
            "INSERT INTO pools(pool_id,config_id,state_id,package_id,name)"
                + " VALUES('pool','config','state','package','Pool')")
        .update();
  }

  @AfterEach
  void dropIsolatedSchema() {
    if (dataSource != null) {
      dataSource.setCurrentSchema("public");
      JdbcClient.create(dataSource).sql("DROP SCHEMA IF EXISTS " + schema + " CASCADE").update();
    }
  }

  @Test
  void concurrentPreparedCommandsReturnTheSameImmutableWinnerAndRejectCrossKindReuse()
      throws Exception {
    var commands = new OperatorCommandStore(sql);
    var payload = new Prepared("payload-a", null);
    for (var contender :
        List.of(new Prepared("payload-b", null), new Prepared(null, "not prepared"))) {
      UUID id = UUID.randomUUID();
      assertThat(commands.find(id, "batch")).isEmpty();
      var results =
          concurrent(
              () -> commands.storeOnce(id, "batch", payload),
              () -> commands.storeOnce(id, "batch", contender));
      var winner = results.getFirst();
      assertThat(winner).isIn(payload, contender);
      assertThat(results).containsExactly(winner, winner);
      assertThat(commands.find(id, "batch")).contains(winner);
      assertThat(commands.storeOnce(id, "batch", new Prepared("later-payload", null)))
          .isEqualTo(winner);
      assertThat(commands.storeOnce(id, "batch", new Prepared(null, "later-failure")))
          .isEqualTo(winner);
      assertThatThrownBy(() -> commands.storeOnce(id, "faucet-grant", payload))
          .isInstanceOf(IllegalStateException.class)
          .hasMessageContaining("another operation kind");
      assertThatThrownBy(() -> commands.find(id, "faucet-grant"))
          .isInstanceOf(IllegalStateException.class)
          .hasMessageContaining("another operation kind");
      assertThat(commands.find(id, "batch")).contains(winner);
    }
  }

  @Test
  void policyCompareAndSwapAllowsOneWriterAndStaleSliderCannotReactivateAutomation()
      throws Exception {
    store.policy("pool");
    var results =
        concurrent(
            () -> update(new UpdatePolicy(true, 2, 0)),
            () -> update(new UpdatePolicy(false, 3, 0)));
    assertThat(results).containsExactlyInAnyOrder(true, false);
    Policy policy = store.policy("pool");
    assertThat(policy.version()).isEqualTo(1);
    store.updatePolicy("pool", new UpdatePolicy(false, 2, policy.version()), now);
    assertThatThrownBy(() -> store.updatePolicy("pool", new UpdatePolicy(true, 4, 1), now))
        .isInstanceOf(SwapFailure.class)
        .hasMessageContaining("changed");
    assertThat(store.policy("pool").automaticEnabled()).isFalse();
  }

  @Test
  void reducedMaximumReportsPolicyMismatchUntilOperatorSavesACompatibleSize() {
    Policy saved = store.updatePolicy("pool", new UpdatePolicy(true, 10, 0), now);
    for (int sequence = 1; sequence <= 5; sequence++)
      insert(sequence, "READY", now.plusSeconds(60));
    var restarted = new SettlementStore(sql, json, new DataSourceTransactionManager(dataSource), 5);
    for (Trigger trigger : Trigger.values())
      assertThatThrownBy(() -> restarted.claim("pool", UUID.randomUUID(), trigger, snapshot, now))
          .isInstanceOfSatisfying(
              SwapFailure.class,
              failure -> {
                assertThat(failure.code()).isEqualTo("POLICY_LIMIT_EXCEEDED");
                assertThat(failure.status()).isEqualTo(409);
                assertThat(failure.getMessage()).contains("10", "5", "Update this pool");
              });
    Monitoring monitoring = restarted.monitoring("pool", snapshot, now);
    assertThat(monitoring.blockedReason()).contains("Saved batch size 10", "current maximum 5");
    assertThat(monitoring.blockedRequest()).isNull();
    assertThat(monitoring.policy().batchSize()).isEqualTo(10);
    assertThat(monitoring.policy().maxBatchSize()).isEqualTo(5);
    assertThat(monitoring.policy().automaticEnabled()).isTrue();
    assertThat(monitoring.policy().version()).isEqualTo(saved.version());
    assertThat(monitoring.readyCount()).isEqualTo(5);
    assertThat(restarted.pending()).isEmpty();
    sql.sql(
            "INSERT INTO pools(pool_id,config_id,state_id,package_id,name)"
                + " VALUES('other-pool','other-config','other-state','package','Other pool')")
        .update();
    assertThat(restarted.policy("other-pool").batchSize()).isEqualTo(5);
    assertThat(restarted.claim("other-pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now))
        .isEmpty();
    Policy corrected =
        restarted.updatePolicy("pool", new UpdatePolicy(true, 5, saved.version()), now);
    assertThat(corrected.version()).isEqualTo(saved.version() + 1);
    assertThat(restarted.monitoring("pool", snapshot, now).blockedReason()).isNull();
    assertThat(
            restarted
                .claim("pool", UUID.randomUUID(), Trigger.AUTOMATIC, snapshot, now)
                .orElseThrow()
                .settlement()
                .requests()
                .stream()
                .map(RequestRef::requestId)
                .toList())
        .hasSize(5);
  }

  @Test
  void reducedMaximumCancelsOnlyAnUnsentPreparationAndPreservesTheSavedPolicy() {
    Policy saved = store.updatePolicy("pool", new UpdatePolicy(true, 10, 0), now);
    for (int sequence = 1; sequence <= 10; sequence++)
      insert(sequence, "READY", now.plusSeconds(60));
    Pending preparing =
        store.claim("pool", UUID.randomUUID(), Trigger.AUTOMATIC, snapshot, now).orElseThrow();
    var restarted = new SettlementStore(sql, json, new DataSourceTransactionManager(dataSource), 5);
    UUID id = preparing.settlement().settlementId();
    assertThat(restarted.authorizeDispatch(id, fills(preparing), snapshot, now)).isEmpty();
    assertThat(restarted.get(id).status()).isEqualTo(Status.CANCELLED);
    assertThat(restarted.get(id).errorCode()).isEqualTo("POLICY_LIMIT_EXCEEDED");
    assertThat(restarted.pending()).isEmpty();
    assertThat(restarted.queue("pool"))
        .extracting(r -> SwapModels.Status.valueOf(r.status()))
        .containsOnly(SwapModels.Status.READY);
    assertThat(restarted.policy("pool").batchSize()).isEqualTo(10);
    assertThat(restarted.policy("pool").version()).isEqualTo(saved.version());
    assertThat(restarted.monitoring("pool", snapshot, now).activeSettlement()).isNull();
  }

  @Test
  void concurrentManualAndAutomaticClaimsFreezeOnlyOneBatch() throws Exception {
    store.updatePolicy("pool", new UpdatePolicy(true, 2, 0), now);
    UUID first = insert(1, "READY", now.plusSeconds(60));
    UUID second = insert(2, "READY", now.plusSeconds(60));
    var results = concurrent(() -> claim(Trigger.MANUAL), () -> claim(Trigger.AUTOMATIC));
    assertThat(results).containsExactlyInAnyOrder(true, false);
    assertThat(store.pending()).hasSize(1);
    Pending pending = store.pending().getFirst();
    assertThat(pending.settlement().requests().stream().map(RequestRef::requestId).toList())
        .containsExactly(first, second);
    assertThat(
            store.claim("pool", pending.settlement().settlementId(), Trigger.MANUAL, snapshot, now))
        .isEmpty();
    assertThat(
            sql.sql("SELECT count(*) FROM swap_requests WHERE status='SETTLING'")
                .query(Integer.class)
                .single())
        .isEqualTo(2);
  }

  @Test
  void disableBeforeDispatchCancelsAutomaticClaimAndReleasesQueue() {
    store.updatePolicy("pool", new UpdatePolicy(true, 1, 0), now);
    UUID swap = insert(1, "READY", now.plusSeconds(60));
    Pending pending =
        store.claim("pool", UUID.randomUUID(), Trigger.AUTOMATIC, snapshot, now).orElseThrow();
    store.updatePolicy("pool", new UpdatePolicy(false, 1, 1), now);
    assertThat(
            store.authorizeDispatch(
                pending.settlement().settlementId(), fills(pending), snapshot, now))
        .isEmpty();
    assertThat(store.get(pending.settlement().settlementId()).status()).isEqualTo(Status.CANCELLED);
    assertThat(status(swap)).isEqualTo("READY");
    assertThat(store.pending()).isEmpty();
  }

  @Test
  void concurrentDispatchAuthorizationCanOnlySendOnce() throws Exception {
    insert(1, "READY", now.plusSeconds(60));
    Pending pending =
        store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now).orElseThrow();
    Callable<Boolean> authorize =
        () ->
            store
                .authorizeDispatch(
                    pending.settlement().settlementId(), fills(pending), snapshot, now)
                .isPresent();
    assertThat(concurrent(authorize, authorize)).containsExactlyInAnyOrder(true, false);
    assertThat(store.get(pending.settlement().settlementId()).status())
        .isEqualTo(Status.SUBMITTING);
  }

  @Test
  void shrinkingManualBatchRestoresSuffixAndStaleWorkerCannotAuthorizeOriginalMembership() {
    UUID first = insert(1, "READY", now.plusSeconds(60));
    UUID blocked = insert(2, "READY", now.plusSeconds(60));
    UUID tail = insert(3, "READY", now.plusSeconds(60));
    Pending original =
        store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now).orElseThrow();
    UUID id = original.settlement().settlementId();
    assertThat(
            store.keepPrefix(
                id,
                List.of(new RequestRef("swap", first)),
                new RequestRef("swap", blocked),
                "MIN_OUT",
                "Minimum output",
                snapshot.version(),
                now))
        .isTrue();
    assertThat(status(first)).isEqualTo("SETTLING");
    assertThat(status(blocked)).isEqualTo("BLOCKED");
    assertThat(status(tail)).isEqualTo("READY");
    assertThat(store.authorizeDispatch(id, fills(original), snapshot, now)).isEmpty();
    Pending reduced = store.pending(id);
    assertThat(reduced.settlement().requests().stream().map(RequestRef::requestId).toList())
        .containsExactly(first);
    assertThat(store.authorizeDispatch(id, fills(reduced), snapshot, now)).isPresent();
  }

  @Test
  void disableAfterDispatchDoesNotPreventConfirmation() {
    store.updatePolicy("pool", new UpdatePolicy(true, 1, 0), now);
    UUID swap = insert(1, "READY", now.plusSeconds(60));
    Pending pending =
        store.claim("pool", UUID.randomUUID(), Trigger.AUTOMATIC, snapshot, now).orElseThrow();
    store
        .authorizeDispatch(pending.settlement().settlementId(), fills(pending), snapshot, now)
        .orElseThrow();
    store.updatePolicy("pool", new UpdatePolicy(false, 1, 1), now);
    store.confirm(pending.settlement().settlementId(), confirmation(pending));
    assertThat(status(swap)).isEqualTo("SETTLED");
    assertThat(store.pending()).isEmpty();
  }

  @Test
  void uncertainSubmissionRetainsPoolClaimAcrossRestartAndDeadline() {
    UUID swap = insert(1, "READY", now.plusSeconds(60));
    Pending pending =
        store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now).orElseThrow();
    store
        .authorizeDispatch(pending.settlement().settlementId(), fills(pending), snapshot, now)
        .orElseThrow();
    store.unresolved(pending.settlement().settlementId(), now);
    var restarted =
        new SettlementStore(sql, json, new DataSourceTransactionManager(dataSource), 10);
    assertThatThrownBy(
            () ->
                restarted.claim(
                    "pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now.plusSeconds(120)))
        .isInstanceOf(SwapFailure.class)
        .hasMessageContaining("in flight");
    assertThat(restarted.pending()).hasSize(1);
    assertThat(restarted.pending().getFirst().commandId()).isEqualTo(pending.commandId());
    assertThat(restarted.pending().getFirst().beginOffset()).isEqualTo(42);
    assertThat(status(swap)).isEqualTo("SETTLING");
  }

  @Test
  void settlementRecoveryFencesLateRejectionAndKeepsThePoolClaimed() {
    UUID swap = insert(1, "READY", now.plusSeconds(60));
    Pending pending =
        store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now).orElseThrow();
    UUID id = pending.settlement().settlementId();
    store.authorizeDispatch(id, fills(pending), snapshot, now).orElseThrow();
    assertThat(store.beginRecovery(id, now.plusSeconds(1))).isTrue();
    store.rejectSubmission(id, "REJECTED", "First submission rejected", now.plusSeconds(2));
    assertThat(store.get(id).status()).isEqualTo(Status.UNRESOLVED);
    assertThat(status(swap)).isEqualTo("SETTLING");
    assertThatThrownBy(
            () ->
                store.claim(
                    "pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now.plusSeconds(3)))
        .isInstanceOf(SwapFailure.class)
        .hasMessageContaining("in flight");
    assertThat(store.beginRecovery(id, now.plusSeconds(4))).isTrue();
    store.confirm(id, confirmation(pending));
    assertThat(store.get(id).status()).isEqualTo(Status.CONFIRMED);
    assertThat(store.beginRecovery(id, now.plusSeconds(5))).isFalse();
  }

  @Test
  void firstSettlementRejectionPreventsRecoveryAndAllowsNewOperation() {
    insert(1, "READY", now.plusSeconds(60));
    Pending pending =
        store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now).orElseThrow();
    UUID id = pending.settlement().settlementId();
    store.authorizeDispatch(id, fills(pending), snapshot, now).orElseThrow();
    store.rejectSubmission(id, "REJECTED", "First submission rejected", now.plusSeconds(1));
    assertThat(store.beginRecovery(id, now.plusSeconds(2))).isFalse();
    assertThat(store.get(id).status()).isEqualTo(Status.REJECTED);
    Pending replacement =
        store
            .claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now.plusSeconds(3))
            .orElseThrow();
    assertThat(replacement.settlement().settlementId()).isNotEqualTo(id);
  }

  @Test
  void excludedUnknownBatchPreservesWithdrawalEvidenceAndReleasesOtherRequests() {
    UUID withdrawn = insert(1, "READY", now.plusSeconds(60));
    UUID expired = insert(2, "READY", now.plusSeconds(10));
    UUID ready = insert(3, "READY", now.plusSeconds(60));
    Pending pending =
        store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now).orElseThrow();
    UUID id = pending.settlement().settlementId();
    store.authorizeDispatch(id, fills(pending), snapshot, now).orElseThrow();
    store.beginRecovery(id, now.plusSeconds(1));
    sql.sql("UPDATE swap_requests SET status='WITHDRAWN' WHERE id=?").param(withdrawn).update();
    sql.sql(
            "UPDATE pool_request_queues SET blocked_version='old-version' WHERE pool_id='pool' AND"
                + " family='swap'")
        .update();

    store.excludeSubmission(
        id, "BATCH_EXCLUDED", "Ledger evidence excludes the batch", now.plusSeconds(20));

    assertThat(store.get(id).status()).isEqualTo(Status.REJECTED);
    assertThat(store.get(id).errorCode()).isEqualTo("BATCH_EXCLUDED");
    assertThat(status(withdrawn)).isEqualTo("WITHDRAWN");
    assertThat(status(expired)).isEqualTo("EXPIRED");
    assertThat(status(ready)).isEqualTo("READY");
    assertThat(
            sql.sql(
                    "SELECT count(*) FROM pool_queues q JOIN pool_request_queues r"
                        + " ON r.pool_id=q.pool_id WHERE q.pool_id='pool' AND r.family='swap'"
                        + " AND q.active_settlement_id IS NULL AND r.blocked_version IS NULL")
                .query(Integer.class)
                .single())
        .isEqualTo(1);
    assertThat(
            sql.sql("SELECT allocation_cids::text FROM swap_requests WHERE id=?")
                .param(expired)
                .query(String.class)
                .single())
        .contains("locked-allocation");

    Pending replacement =
        store
            .claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now.plusSeconds(21))
            .orElseThrow();
    assertThat(replacement.settlement().requests().stream().map(RequestRef::requestId).toList())
        .containsExactly(ready);
    sql.sql(
            "UPDATE pool_request_queues SET blocked_version='new-version' WHERE pool_id='pool' AND"
                + " family='swap'")
        .update();
    store.excludeSubmission(id, "STALE", "Old exclusion delivered again", now.plusSeconds(22));
    assertThat(store.pending())
        .extracting(p -> p.settlement().settlementId())
        .containsExactly(replacement.settlement().settlementId());
    assertThat(
            sql.sql("SELECT active_settlement_id FROM pool_queues WHERE pool_id='pool'")
                .query(UUID.class)
                .single())
        .isEqualTo(replacement.settlement().settlementId());
    assertThat(
            sql.sql(
                    "SELECT blocked_version FROM pool_request_queues WHERE pool_id='pool' AND"
                        + " family='swap'")
                .query(String.class)
                .single())
        .isEqualTo("new-version");
    assertThat(status(ready)).isEqualTo("SETTLING");
    assertThat(store.get(id).errorCode()).isEqualTo("BATCH_EXCLUDED");
  }

  @Test
  void staleExclusionCannotUndoConfirmedSettlement() {
    UUID swap = insert(1, "READY", now.plusSeconds(60));
    Pending pending =
        store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now).orElseThrow();
    UUID id = pending.settlement().settlementId();
    store.authorizeDispatch(id, fills(pending), snapshot, now).orElseThrow();
    store.confirm(id, confirmation(pending));
    Settlement confirmed = store.get(id);

    store.excludeSubmission(id, "STALE", "Stale exclusion", now.plusSeconds(1));

    assertThat(store.get(id)).isEqualTo(confirmed);
    assertThat(status(swap)).isEqualTo("SETTLED");
  }

  @Test
  void expiredUnconfirmedHeadStillBlocksConfirmedFollowers() {
    UUID head = insert(1, "UNRESOLVED", now.minusSeconds(1));
    UUID follower = insert(2, "READY", now.plusSeconds(60));
    assertThat(store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now)).isEmpty();
    assertThat(status(head)).isEqualTo("UNRESOLVED");
    assertThat(status(follower)).isEqualTo("READY");
  }

  @Test
  void confirmedExpiredHeadIsRemovedWithoutDiscardingItsLockedAllocation() {
    UUID head = insert(1, "BLOCKED", now.minusSeconds(1));
    UUID follower = insert(2, "READY", now.plusSeconds(60));
    Pending pending =
        store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now).orElseThrow();
    assertThat(pending.settlement().requests().stream().map(RequestRef::requestId).toList())
        .containsExactly(follower);
    assertThat(status(head)).isEqualTo("EXPIRED");
    assertThat(
            sql.sql("SELECT allocation_cids::text FROM swap_requests WHERE id=?")
                .param(head)
                .query(String.class)
                .single())
        .contains("locked-allocation");
  }

  @Test
  void automaticNeedsExactThresholdButManualCanSettleSmallerPrefix() {
    store.updatePolicy("pool", new UpdatePolicy(true, 2, 0), now);
    UUID swap = insert(1, "READY", now.plusSeconds(60));
    assertThat(store.claim("pool", UUID.randomUUID(), Trigger.AUTOMATIC, snapshot, now)).isEmpty();
    assertThat(
            store
                .claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now)
                .orElseThrow()
                .settlement()
                .requests()
                .stream()
                .map(RequestRef::requestId)
                .toList())
        .containsExactly(swap);
  }

  @Test
  void unchangedSnapshotCannotRepeatedlySubmitDeterministicallyRejectedBatch() {
    store.updatePolicy("pool", new UpdatePolicy(true, 1, 0), now);
    insert(1, "READY", now.plusSeconds(60));
    Pending pending =
        store.claim("pool", UUID.randomUUID(), Trigger.AUTOMATIC, snapshot, now).orElseThrow();
    store
        .authorizeDispatch(pending.settlement().settlementId(), fills(pending), snapshot, now)
        .orElseThrow();
    store.rejectSubmission(pending.settlement().settlementId(), "MIN_OUT", "Output changed", now);
    assertThat(store.claim("pool", UUID.randomUUID(), Trigger.AUTOMATIC, snapshot, now)).isEmpty();
    Snapshot changed =
        new Snapshot("pool", "version-2", reserves, "30", "READY", null, now, 50, "100", "2");
    assertThat(store.claim("pool", UUID.randomUUID(), Trigger.AUTOMATIC, changed, now)).isPresent();
  }

  @Test
  void settlementConfirmationWinsLateWithdrawalAttempt() {
    UUID swap = insert(1, "READY", now.plusSeconds(60));
    Pending pending =
        store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now).orElseThrow();
    store
        .authorizeDispatch(pending.settlement().settlementId(), fills(pending), snapshot, now)
        .orElseThrow();
    store.unresolved(pending.settlement().settlementId(), now);
    sql.sql("UPDATE swap_requests SET status='WITHDRAWAL_UNRESOLVED' WHERE id=?")
        .param(swap)
        .update();
    store.confirm(pending.settlement().settlementId(), confirmation(pending));
    assertThat(status(swap)).isEqualTo("SETTLED");
    store.confirm(pending.settlement().settlementId(), confirmation(pending));
    assertThat(store.get(pending.settlement().settlementId()).status()).isEqualTo(Status.CONFIRMED);
  }

  @Test
  void contradictoryTerminalWithdrawalEvidenceCannotBeOverwritten() {
    UUID swap = insert(1, "READY", now.plusSeconds(60));
    Pending pending =
        store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now).orElseThrow();
    store
        .authorizeDispatch(pending.settlement().settlementId(), fills(pending), snapshot, now)
        .orElseThrow();
    sql.sql("UPDATE swap_requests SET status='WITHDRAWN' WHERE id=?").param(swap).update();
    assertThatThrownBy(
            () -> store.confirm(pending.settlement().settlementId(), confirmation(pending)))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("Conflicting terminal");
    assertThat(status(swap)).isEqualTo("WITHDRAWN");
    assertThat(store.get(pending.settlement().settlementId()).status())
        .isEqualTo(Status.SUBMITTING);
  }

  @Test
  void independentFamiliesKeepTheirOwnSequenceAndShareOnlyTheSettlementLock() {
    store.policy("pool");
    UUID unknownSwap = insert(1, "UNRESOLVED", now.plusSeconds(600));
    var deposit = insertLiquidity(LiquidityModels.Kind.DEPOSIT);
    var laterDeposit = insertLiquidity(LiquidityModels.Kind.DEPOSIT);
    var withdrawal = insertLiquidity(LiquidityModels.Kind.WITHDRAW);
    var laterWithdrawal = insertLiquidity(LiquidityModels.Kind.WITHDRAW);
    assertThat(deposit.arrivalSequence()).isEqualTo(1);
    assertThat(laterDeposit.arrivalSequence()).isEqualTo(2);
    assertThat(withdrawal.arrivalSequence()).isEqualTo(1);
    assertThat(laterWithdrawal.arrivalSequence()).isEqualTo(2);

    Pending first =
        store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now).orElseThrow();
    assertThat(first.settlement().requests())
        .containsExactly(
            new RequestRef("deposit", deposit.requestId()),
            new RequestRef("deposit", laterDeposit.requestId()));
    assertThatThrownBy(() -> store.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now))
        .isInstanceOf(SwapFailure.class)
        .hasMessageContaining("in flight");
    List<Fill> depositFills =
        List.of(
            new DepositFill(deposit.requestId(), "10", "20", "0", "5", "10"),
            new DepositFill(laterDeposit.requestId(), "10", "20", "0", "5", "10"));
    store
        .authorizeDispatch(first.settlement().settlementId(), depositFills, snapshot, now)
        .orElseThrow();
    store.unresolved(first.settlement().settlementId(), now);
    var restarted =
        new SettlementStore(sql, json, new DataSourceTransactionManager(dataSource), 10);
    assertThat(restarted.pending().getFirst().requests())
        .extracting(QueueRequest::reference)
        .containsExactlyElementsOf(first.settlement().requests());
    restarted.confirm(
        first.settlement().settlementId(),
        new Confirmation(depositFills, reserves, reserves, "deposit-update", 44, now));

    Pending second =
        restarted.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now).orElseThrow();
    assertThat(second.settlement().requests())
        .containsExactly(
            new RequestRef("withdraw", withdrawal.requestId()),
            new RequestRef("withdraw", laterWithdrawal.requestId()));
    List<Fill> withdrawalFills =
        List.of(
            new WithdrawalFill(withdrawal.requestId(), "10", "5", "10"),
            new WithdrawalFill(laterWithdrawal.requestId(), "10", "5", "10"));
    restarted
        .authorizeDispatch(second.settlement().settlementId(), withdrawalFills, snapshot, now)
        .orElseThrow();
    restarted.unresolved(second.settlement().settlementId(), now);
    var recovered =
        new SettlementStore(sql, json, new DataSourceTransactionManager(dataSource), 10);
    assertThat(recovered.pending().getFirst().requests())
        .extracting(QueueRequest::reference)
        .containsExactlyElementsOf(second.settlement().requests());
    assertThatThrownBy(
            () -> recovered.claim("pool", UUID.randomUUID(), Trigger.MANUAL, snapshot, now))
        .isInstanceOf(SwapFailure.class)
        .hasMessageContaining("in flight");
    recovered.confirm(
        second.settlement().settlementId(),
        new Confirmation(withdrawalFills, reserves, reserves, "withdrawal-update", 45, now));
    assertThat(status(unknownSwap)).isEqualTo("UNRESOLVED");
    var liquidity = new LiquidityStore(sql, json, new DataSourceTransactionManager(dataSource), 10);
    for (var request : List.of(deposit, laterDeposit)) {
      var saved = liquidity.get(request.requestId());
      assertThat(saved.status()).isEqualTo(LiquidityModels.Status.SETTLED);
      assertThat(saved.result())
          .isEqualTo(new LiquidityModels.DepositResult("10", "20", "0", "5", "10"));
    }
    for (var request : List.of(withdrawal, laterWithdrawal)) {
      var saved = liquidity.get(request.requestId());
      assertThat(saved.status()).isEqualTo(LiquidityModels.Status.SETTLED);
      assertThat(saved.result()).isEqualTo(new LiquidityModels.WithdrawalResult("10", "5", "10"));
    }
  }

  private LiquidityModels.Request insertLiquidity(LiquidityModels.Kind kind) {
    var liquidity = new LiquidityStore(sql, json, new DataSourceTransactionManager(dataSource), 10);
    var caller = new Account(account, "test", "trader", "Trader", Account.Role.TRADER);
    UUID quote = UUID.randomUUID(), request = UUID.randomUUID(), preparation = UUID.randomUUID();
    sql.sql(
            "INSERT INTO liquidity_quotes(id,account_id,kind,payload,expires_at)"
                + " VALUES(?,?,?,'{}',?)")
        .params(quote, account, kind.name(), java.sql.Timestamp.from(now.plusSeconds(600)))
        .update();
    var base = new Instrument("issuer", "A");
    var quoteToken = new Instrument("issuer", "B");
    var lp = new Instrument("dvo", "LP");
    LiquidityModels.Terms terms =
        kind == LiquidityModels.Kind.DEPOSIT
            ? new LiquidityModels.DepositTerms(
                "pool",
                "Pool",
                "trader",
                base,
                quoteToken,
                lp,
                LiquidityModels.Mode.PROPORTIONAL,
                "10",
                "25",
                "10",
                "20",
                "0",
                "5",
                "10",
                "9.9",
                "1.98",
                "2.02",
                null,
                now.plusSeconds(600))
            : new LiquidityModels.WithdrawalTerms(
                "pool",
                "Pool",
                "trader",
                base,
                quoteToken,
                lp,
                "1",
                "1",
                "2",
                "0.99",
                "1.98",
                now.plusSeconds(600));
    var signing =
        new LiquidityModels.SigningPayload(
            "opaque", "hash", 3, "trader", "key", now.plusSeconds(45), List.of());
    liquidity.savePreparation(request, preparation, request, quote, caller, terms, signing);
    assertThat(liquidity.begin(preparation, caller, "signature", 42, now)).isTrue();
    liquidity.confirm(
        preparation,
        new LiquidityModels.Confirmation(
            LiquidityModels.Status.READY,
            List.of("base-" + request, "quote-" + request, "lp-" + request),
            null,
            "request-" + request,
            43,
            now));
    return liquidity.get(request);
  }

  @Test
  void deferredRequestsKeepTheirFundsAndReturnToTheirOwnQueueTail() {
    var first = new RequestRef("swap", insert(1, "READY", now.plusSeconds(600)));
    var second = new RequestRef("swap", insert(2, "READY", now.plusSeconds(600)));
    store.plan("pool", "swap", null, snapshot, now);
    sql.sql("UPDATE pool_request_queues SET next_sequence=2 WHERE pool_id='pool' AND family='swap'")
        .update();
    var references = new ArrayList<RequestRef>();
    references.add(first);
    for (var kind : LiquidityModels.Kind.values()) {
      var request = insertLiquidity(kind);
      references.add(
          new RequestRef(
              kind == LiquidityModels.Kind.DEPOSIT ? "deposit" : "withdraw", request.requestId()));
    }
    for (var reference : references) {
      store.setDeferred("pool", reference, true, now);
      store.setDeferred("pool", reference, true, now);
      var row =
          store.queue("pool").stream()
              .filter(r -> r.reference().equals(reference))
              .findFirst()
              .orElseThrow();
      assertThat(row.deferred()).isTrue();
      assertThat(row.status()).isEqualTo("READY");
      assertThat(store.plan("pool", reference.type(), null, snapshot, now).selection().requests())
          .doesNotContain(reference);
    }
    var restarted =
        new SettlementStore(sql, json, new DataSourceTransactionManager(dataSource), 10);
    assertThat(restarted.queue("pool").stream().filter(QueueRequest::deferred)).hasSize(3);
    assertThat(restarted.plan("pool", "swap", null, snapshot, now).selection().requests())
        .containsExactly(second);
    for (var reference : references) {
      restarted.setDeferred("pool", reference, false, now);
      var returned =
          restarted.queue("pool").stream()
              .filter(r -> r.reference().equals(reference))
              .findFirst()
              .orElseThrow();
      restarted.setDeferred("pool", reference, false, now);
      assertThat(
              restarted.queue("pool").stream()
                  .filter(r -> r.reference().equals(reference))
                  .findFirst()
                  .orElseThrow()
                  .arrivalSequence())
          .isEqualTo(returned.arrivalSequence());
    }
    assertThat(restarted.plan("pool", "swap", null, snapshot, now).selection().requests())
        .containsExactly(second, first);
    restarted.setDeferred("pool", first, true, now);
    restarted.plan("pool", "swap", null, snapshot, now.plusSeconds(601));
    var expired =
        restarted.queue("pool").stream()
            .filter(r -> r.reference().equals(first))
            .findFirst()
            .orElseThrow();
    assertThat(expired.status()).isEqualTo("EXPIRED");
    assertThat(expired.deferred()).isTrue();
    assertThat(((SwapRequest) expired).request().allocationCids())
        .containsExactly("locked-allocation");
    assertThatThrownBy(() -> restarted.setDeferred("pool", first, false, now.plusSeconds(601)))
        .isInstanceOf(SwapFailure.class);
  }

  @Test
  void retriesKeepTheRejectedAttemptAndRequireTheExactCurrentPreview() {
    var first = new RequestRef("swap", insert(1, "READY", now.plusSeconds(600)));
    var blocked = new RequestRef("swap", insert(2, "READY", now.plusSeconds(600)));
    var last = new RequestRef("swap", insert(3, "READY", now.plusSeconds(600)));
    var original = store.plan("pool", "swap", null, snapshot, now);
    UUID oldId = UUID.randomUUID();
    store.claim("pool", oldId, Trigger.MANUAL, snapshot, now, original.selection()).orElseThrow();
    assertThatThrownBy(() -> store.setDeferred("pool", blocked, true, now))
        .isInstanceOf(SwapFailure.class);
    assertThatThrownBy(() -> store.plan("pool", "swap", oldId, snapshot, now))
        .isInstanceOf(SwapFailure.class);
    store.rejectPreparation(oldId, blocked, "MIN_OUT", "Minimum not met", snapshot.version(), now);
    var rejected = store.get(oldId);
    store.setDeferred("pool", blocked, true, now);
    var retry = store.plan("pool", "swap", oldId, snapshot, now);
    assertThat(retry.selection().requests()).containsExactly(first, last);
    assertThat(store.get(oldId)).isEqualTo(rejected);
    UUID newId = UUID.randomUUID();
    var wrongState =
        new Selection(
            "swap",
            oldId,
            "old-state",
            retry.selection().policyVersion(),
            retry.selection().requests());
    assertThatThrownBy(() -> store.claim("pool", newId, Trigger.MANUAL, snapshot, now, wrongState))
        .isInstanceOf(SwapFailure.class);
    store.setDeferred("pool", last, true, now);
    assertThatThrownBy(
            () -> store.claim("pool", newId, Trigger.MANUAL, snapshot, now, retry.selection()))
        .isInstanceOf(SwapFailure.class);
    var refreshed = store.plan("pool", "swap", oldId, snapshot, now);
    var claimed =
        store
            .claim("pool", newId, Trigger.MANUAL, snapshot, now, refreshed.selection())
            .orElseThrow();
    assertThat(claimed.settlement().retryOf()).isEqualTo(oldId);
    assertThat(claimed.settlement().requests()).containsExactly(first);
    assertThat(store.findIntent("pool", newId, refreshed.selection()))
        .contains(claimed.settlement());
    assertThatThrownBy(() -> store.findIntent("pool", newId, retry.selection()))
        .isInstanceOf(SwapFailure.class);
    store.authorizeDispatch(newId, fills(claimed), snapshot, now).orElseThrow();
    store.unresolved(newId, now);
    assertThatThrownBy(() -> store.plan("pool", "swap", newId, snapshot, now))
        .isInstanceOf(SwapFailure.class);
    assertThatThrownBy(() -> store.setDeferred("pool", blocked, false, now))
        .isInstanceOf(SwapFailure.class);
    assertThat(store.get(oldId)).isEqualTo(rejected);
  }

  @Test
  void aRecoveredPreviewCannotDispatchAfterThePoolOrPolicyChanges() {
    insert(1, "READY", now.plusSeconds(600));
    for (boolean changePool : List.of(true, false)) {
      var selection = store.plan("pool", "swap", null, snapshot, now).selection();
      UUID id = UUID.randomUUID();
      var claimed = store.claim("pool", id, Trigger.MANUAL, snapshot, now, selection).orElseThrow();
      Snapshot observed = snapshot;
      if (changePool)
        observed =
            new Snapshot(
                "pool", "changed-state", reserves, "30", "READY", null, now, 43, "100", "2");
      else store.updatePolicy("pool", new UpdatePolicy(false, 2, selection.policyVersion()), now);
      var restarted =
          new SettlementStore(sql, json, new DataSourceTransactionManager(dataSource), 10);
      assertThat(restarted.authorizeDispatch(id, fills(claimed), observed, now)).isEmpty();
      assertThat(restarted.get(id).status()).isEqualTo(Status.CANCELLED);
      assertThat(restarted.get(id).errorCode())
          .isEqualTo(changePool ? "POOL_CHANGED" : "POLICY_CHANGED");
      assertThat(restarted.plan("pool", "swap", null, snapshot, now).selection().requests())
          .hasSize(1);
    }
  }

  @Test
  void malformedPublicReferencesDoNotMutateTheQueue() {
    var withdrawal = insertLiquidity(LiquidityModels.Kind.WITHDRAW);
    for (var ref :
        List.of(
            new RequestRef("swap", UUID.randomUUID()),
            new RequestRef("deposit", withdrawal.requestId())))
      assertThatThrownBy(() -> store.setDeferred("pool", ref, true, now))
          .isInstanceOf(NoSuchElementException.class);
    assertThat(store.queue("pool")).noneMatch(QueueRequest::deferred);
    String invalid =
        Base64.getUrlEncoder()
            .encodeToString(
                ("not-a-date|" + UUID.randomUUID())
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
    assertThatThrownBy(() -> store.history("pool", null, null, invalid, 25))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void historyPagesThroughEveryAttemptWithStableFilters() {
    insert(1, "READY", now.plusSeconds(600));
    for (int n = 0; n < 5; n++) {
      UUID id = UUID.randomUUID();
      store.claim("pool", id, Trigger.MANUAL, snapshot, now).orElseThrow();
      store.cancelPreparation(id, "PREFLIGHT_UNAVAILABLE", "Unavailable", now);
    }
    var seen = new HashSet<UUID>();
    String cursor = null;
    do {
      var page = store.history("pool", "swap", Status.CANCELLED, cursor, 2);
      for (var batch : page.items()) assertThat(seen.add(batch.settlementId())).isTrue();
      cursor = page.nextCursor();
    } while (cursor != null);
    assertThat(seen).hasSize(5);
    assertThat(store.history("pool", "withdraw", null, null, 2).items()).isEmpty();
    assertThat(store.history("another-pool", null, null, null, 2).items()).isEmpty();
    assertThat(store.history("pool", null, Status.CONFIRMED, null, 2).items()).isEmpty();
  }

  private UUID insert(long sequence, String status, Instant deadline) {
    UUID quote = UUID.randomUUID();
    UUID swap = UUID.randomUUID();
    SwapModels.Terms terms =
        new SwapModels.Terms(
            "pool",
            "Pool",
            "trader",
            SwapModels.Direction.BaseToQuote,
            new Instrument("issuer", "A"),
            new Instrument("issuer", "B"),
            "10",
            "18",
            "0.03",
            "15",
            deadline);
    sql.sql(
            "INSERT INTO swap_quotes(id,account_id,payload,expires_at)"
                + " VALUES(?,?,'{}',now()+interval '1 hour')")
        .params(quote, account)
        .update();
    sql.sql(
            """
            INSERT INTO swap_requests(id,account_id,quote_id,terms,status,arrival_sequence,submitted_at,allocation_cids)
            VALUES(?,?,?,?::jsonb,?,?,now(),'["locked-allocation"]')
            """)
        .params(swap, account, quote, json.writeValueAsString(terms), status, sequence)
        .update();
    return swap;
  }

  private String status(UUID id) {
    return sql.sql("SELECT status FROM swap_requests WHERE id=?")
        .param(id)
        .query(String.class)
        .single();
  }

  private List<Fill> fills(Pending pending) {
    return pending.requests().stream()
        .map(
            request ->
                (Fill)
                    new SwapFill(
                        request.reference().requestId(),
                        "18",
                        ((SwapRequest) request).request().outputInstrument()))
        .toList();
  }

  private Confirmation confirmation(Pending pending) {
    return new Confirmation(
        fills(pending),
        reserves,
        new Reserves("after", "110", "182", "1.65", "20020"),
        "update",
        43,
        now);
  }

  private boolean claim(Trigger trigger) {
    try {
      return store.claim("pool", UUID.randomUUID(), trigger, snapshot, now).isPresent();
    } catch (SwapFailure e) {
      assertThat(e.code()).isEqualTo("BATCH_IN_FLIGHT");
      return false;
    }
  }

  private boolean update(UpdatePolicy input) {
    try {
      store.updatePolicy("pool", input, now);
      return true;
    } catch (SwapFailure e) {
      assertThat(e.code()).isEqualTo("POLICY_CHANGED");
      return false;
    }
  }

  private static <T> List<T> concurrent(Callable<T> first, Callable<T> second) throws Exception {
    CountDownLatch start = new CountDownLatch(1);
    try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
      Future<T> a =
          executor.submit(
              () -> {
                start.await();
                return first.call();
              });
      Future<T> b =
          executor.submit(
              () -> {
                start.await();
                return second.call();
              });
      start.countDown();
      return List.of(a.get(5, TimeUnit.SECONDS), b.get(5, TimeUnit.SECONDS));
    }
  }
}
