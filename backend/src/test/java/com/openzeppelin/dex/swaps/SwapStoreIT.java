package com.openzeppelin.dex.swaps;

import static com.openzeppelin.dex.swaps.SwapModels.*;
import static org.assertj.core.api.Assertions.*;

import com.openzeppelin.dex.iam.Account;
import com.openzeppelin.dex.pools.PoolModels.Instrument;
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
class SwapStoreIT {
  private final String schema = "swap_test_" + UUID.randomUUID().toString().replace("-", "");
  private final Account trader =
      new Account(UUID.randomUUID(), "test", "trader", "Trader", Account.Role.TRADER);
  private final JsonMapper json = JsonMapper.builder().build();
  private final Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
  private PGSimpleDataSource dataSource;
  private JdbcClient sql;
  private SwapStore store;

  @BeforeEach
  void createIsolatedSchema() {
    dataSource = new PGSimpleDataSource();
    dataSource.setURL(System.getenv("DEX_SETTLEMENT_TEST_DATABASE_URL"));
    JdbcClient.create(dataSource).sql("CREATE SCHEMA " + schema).update();
    dataSource.setCurrentSchema(schema);
    sql = JdbcClient.create(dataSource);
    new ResourceDatabasePopulator(new ClassPathResource("db/V1__schema.sql")).execute(dataSource);
    store = new SwapStore(sql, json, new DataSourceTransactionManager(dataSource), 10);
    sql.sql(
            "INSERT INTO accounts(id,issuer,subject,display_name,role)"
                + " VALUES(?,'test','trader','Trader','TRADER')")
        .param(trader.id())
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
  void persistedQuoteAndPreparationRoundTripWithoutLosingWalletIdentityOrDecimalTerms() {
    Quote quote = quote(now.plusSeconds(300));
    assertThat(store.quote(quote.quoteId(), trader)).isEqualTo(quote);
    Pending preparation = save(quote);
    var restarted = new SwapStore(sql, json, new DataSourceTransactionManager(dataSource), 10);
    Pending loaded = restarted.pendingOwned(preparation.preparationId(), trader);
    assertThat(loaded).isEqualTo(preparation);
    assertThat(loaded.signing()).isEqualTo(signing());
    assertThat(loaded.accountId()).isEqualTo(trader.id());
    assertThat(loaded.swap().amountIn()).isEqualTo("0.00000001");
    assertThat(loaded.swap().minOut()).isEqualTo("0.00009");
    assertThat(loaded.swap().settlementDeadline()).isEqualTo(quote.settlementDeadline());
    assertThat(restarted.preparedQuote(quote.quoteId(), trader)).contains(loaded);
    var other = new Account(UUID.randomUUID(), "test", "other", "Other", Account.Role.TRADER);
    assertThatThrownBy(() -> restarted.pendingOwned(preparation.preparationId(), other))
        .isInstanceOf(NoSuchElementException.class);
  }

  @Test
  void racingPreparationsForOneQuoteReturnTheSameDurableTransaction() throws Exception {
    Quote quote = quote(now.plusSeconds(300));
    List<Pending> results = concurrent(() -> save(quote), () -> save(quote));
    assertThat(results.get(0).preparationId()).isEqualTo(results.get(1).preparationId());
    assertThat(results.get(0).swap().swapId()).isEqualTo(results.get(1).swap().swapId());
    assertThat(results.get(0).commandId()).isEqualTo(results.get(1).commandId());
    assertThat(count("swap_requests")).isEqualTo(1);
    assertThat(count("swap_preparations")).isEqualTo(1);
  }

  @Test
  void concurrentSubmissionClaimsAllocateExactlyOneQueueSequence() throws Exception {
    Pending preparation = save(quote(now.plusSeconds(300)));
    Callable<Boolean> begin =
        () -> store.begin(preparation.preparationId(), trader, "signature", 42, now);
    assertThat(concurrent(begin, begin)).containsExactlyInAnyOrder(true, false);
    Pending submitted = store.pendingOwned(preparation.preparationId(), trader);
    assertThat(submitted.signature()).isEqualTo("signature");
    assertThat(submitted.beginOffset()).isEqualTo(42);
    assertThat(submitted.swap().arrivalSequence()).isEqualTo(1);
    assertThat(submitted.swap().status()).isEqualTo(Status.SUBMITTING);
    assertThat(
            sql.sql("SELECT next_sequence FROM pool_swap_queues WHERE pool_id='pool'")
                .query(Long.class)
                .single())
        .isEqualTo(1);
  }

  @Test
  void changedSignatureCannotReplaceAnUncertainSubmission() {
    Pending preparation = save(quote(now.plusSeconds(300)));
    store.begin(preparation.preparationId(), trader, "original", 42, now);
    store.uncertain(preparation.preparationId());
    assertThatThrownBy(
            () -> store.begin(preparation.preparationId(), trader, "replacement", 50, now))
        .isInstanceOfSatisfying(
            SwapFailure.class,
            failure -> assertThat(failure.code()).isEqualTo("IDEMPOTENCY_CONFLICT"));
    Pending pending = store.pendingOwned(preparation.preparationId(), trader);
    assertThat(pending.signature()).isEqualTo("original");
    assertThat(pending.beginOffset()).isEqualTo(42);
    assertThat(pending.swap().arrivalSequence()).isEqualTo(1);
    assertThat(pending.swap().status()).isEqualTo(Status.UNRESOLVED);
  }

  @Test
  void racingLostResponseAndLedgerConfirmationAlwaysLeaveConfirmedReadyState() throws Exception {
    for (int attempt = 0; attempt < 8; attempt++) {
      Pending preparation = save(quote(now.plusSeconds(300)));
      store.begin(preparation.preparationId(), trader, "signature", 42, now);
      concurrent(
          () -> {
            store.uncertain(preparation.preparationId());
            return true;
          },
          () -> {
            store.confirm(preparation.preparationId(), evidence(preparation, Status.READY));
            return true;
          });
      assertThat(store.get(preparation.swap().swapId()).status()).isEqualTo(Status.READY);
      assertThat(
              sql.sql("SELECT status FROM swap_preparations WHERE id=?")
                  .param(preparation.preparationId())
                  .query(String.class)
                  .single())
          .isEqualTo("CONFIRMED");
    }
    assertThat(store.unresolved()).isEmpty();
  }

  @Test
  void confirmingALaterArrivalDoesNotRetryTheUnchangedBlockedHead() {
    Pending head = save(quote(now.plusSeconds(300)));
    store.begin(head.preparationId(), trader, "head-signature", 42, now);
    store.confirm(head.preparationId(), evidence(head, Status.READY));
    sql.sql("UPDATE swap_requests SET status='BLOCKED',error_code='MIN_OUT' WHERE id=?")
        .param(head.swap().swapId())
        .update();
    sql.sql("UPDATE pool_swap_queues SET blocked_version='same-pool-state' WHERE pool_id='pool'")
        .update();
    Pending follower = save(quote(now.plusSeconds(300)));
    store.begin(follower.preparationId(), trader, "follower-signature", 50, now);
    store.confirm(follower.preparationId(), evidence(follower, Status.READY));
    assertThat(
            sql.sql("SELECT blocked_version FROM pool_swap_queues WHERE pool_id='pool'")
                .query(String.class)
                .single())
        .isEqualTo("same-pool-state");
    assertThat(store.get(head.swap().swapId()).status()).isEqualTo(Status.BLOCKED);
    assertThat(store.get(follower.swap().swapId()).status()).isEqualTo(Status.READY);
  }

  @Test
  void firstTraderSubmissionRespectsConfiguredMaximumBatchSize() {
    store = new SwapStore(sql, json, new DataSourceTransactionManager(dataSource), 2);
    Pending preparation = save(quote(now.plusSeconds(300)));
    store.begin(preparation.preparationId(), trader, "signature", 42, now);
    assertThat(
            sql.sql("SELECT batch_size FROM pool_swap_queues WHERE pool_id='pool'")
                .query(Integer.class)
                .single())
        .isEqualTo(2);
  }

  @Test
  void definitivelyRejectedWithdrawalAllowsANewPreparationWithoutReplayingTheOldOne() {
    Pending preparation = save(quote(now.minusSeconds(1)));
    store.begin(preparation.preparationId(), trader, "signature", 42, now.minusSeconds(60));
    store.confirm(preparation.preparationId(), evidence(preparation, Status.READY));
    UUID swapId = preparation.swap().swapId();
    Pending withdrawal =
        store.saveWithdrawal(swapId, UUID.randomUUID(), UUID.randomUUID(), trader, signing(), now);
    assertThat(store.begin(withdrawal.preparationId(), trader, "withdraw-signature", 50, now))
        .isTrue();
    assertThat(store.pending(withdrawal.preparationId()).beginOffset()).isEqualTo(42);
    store.rejected(withdrawal.preparationId(), new LedgerRejected("INVALID_SIGNATURE", "Rejected"));
    assertThat(store.get(swapId).status()).isEqualTo(Status.EXPIRED);
    assertThat(store.get(swapId).canWithdraw()).isTrue();
    assertThat(store.latestWithdrawal(swapId, trader)).isEmpty();
    assertThat(store.begin(withdrawal.preparationId(), trader, "withdraw-signature", 50, now))
        .isFalse();

    Pending retry =
        store.saveWithdrawal(swapId, UUID.randomUUID(), UUID.randomUUID(), trader, signing(), now);
    assertThat(retry.preparationId()).isNotEqualTo(withdrawal.preparationId());
    assertThat(store.begin(retry.preparationId(), trader, "retry-signature", 55, now)).isTrue();
    assertThat(store.pending(retry.preparationId()).beginOffset()).isEqualTo(42);
    store.confirm(retry.preparationId(), evidence(preparation, Status.WITHDRAWN));
    assertThat(store.get(swapId).status()).isEqualTo(Status.WITHDRAWN);
    assertThat(store.get(swapId).canWithdraw()).isFalse();
  }

  @Test
  void lateInitialConfirmationCannotRegressEitherTerminalOutcome() {
    for (Status terminal : List.of(Status.SETTLED, Status.WITHDRAWN)) {
      Pending preparation = save(quote(now.plusSeconds(300)));
      store.begin(preparation.preparationId(), trader, "signature", 42, now);
      store.confirm(preparation.preparationId(), evidence(preparation, Status.READY));
      store.confirm(preparation.preparationId(), evidence(preparation, terminal));
      store.confirm(preparation.preparationId(), evidence(preparation, Status.READY));
      Swap swap = store.get(preparation.swap().swapId());
      assertThat(swap.status()).isEqualTo(terminal);
      assertThat(swap.updateId()).isEqualTo("update-" + terminal);
      assertThat(swap.canWithdraw()).isFalse();
      assertThat(
              sql.sql("SELECT status FROM swap_preparations WHERE id=?")
                  .param(preparation.preparationId())
                  .query(String.class)
                  .single())
          .isEqualTo("CONFIRMED");
    }
  }

  private Quote quote(Instant deadline) {
    var quote =
        new Quote(
            UUID.randomUUID(),
            "pool",
            "BTC/USDC",
            "trader::namespace",
            Direction.BaseToQuote,
            new Instrument("issuer", "BTC"),
            new Instrument("issuer", "USDC"),
            "0.00000001",
            "0.000099",
            "0",
            "0.00009",
            100,
            "state",
            now.plusSeconds(30),
            deadline);
    store.saveQuote(quote, trader);
    return quote;
  }

  private Pending save(Quote quote) {
    UUID swapId = UUID.randomUUID();
    var terms =
        new Terms(
            quote.poolId(),
            quote.poolName(),
            quote.trader(),
            quote.direction(),
            quote.inputInstrument(),
            quote.outputInstrument(),
            quote.amountIn(),
            quote.expectedOut(),
            quote.feeAmount(),
            quote.minOut(),
            quote.settlementDeadline());
    return store.savePreparation(
        swapId, UUID.randomUUID(), swapId, quote.quoteId(), trader, terms, signing());
  }

  private SigningPayload signing() {
    return new SigningPayload(
        "opaque-transaction",
        Base64.getEncoder().encodeToString(new byte[32]),
        2,
        "trader::namespace",
        "wallet-key-fingerprint",
        now.plusSeconds(120));
  }

  private Confirmation evidence(Pending pending, Status status) {
    String id = pending.swap().swapId().toString();
    return new Confirmation(
        status,
        List.of("input-" + id, "output-" + id),
        status == Status.SETTLED ? "0.000099" : null,
        "update-" + status,
        43,
        now);
  }

  private int count(String table) {
    return sql.sql("SELECT count(*) FROM " + table).query(Integer.class).single();
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
