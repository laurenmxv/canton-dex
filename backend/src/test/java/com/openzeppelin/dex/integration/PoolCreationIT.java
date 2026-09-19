package com.openzeppelin.dex.integration;

import static org.assertj.core.api.Assertions.*;
import static org.awaitility.Awaitility.await;

import com.openzeppelin.dex.bootstrap.*;
import com.openzeppelin.dex.canton.*;
import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolfactory.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import tools.jackson.databind.JsonNode;

@Tag("integration")
@EnabledIfSystemProperty(named = "scenario", matches = "pools|all")
class PoolCreationIT {
  private static final String ROOT = "/v1/admin/pool-proposals";

  private Map<String, Object> input(JsonNode options, String suffix) {
    var admins = options.path("instrumentAdmins");
    return new LinkedHashMap<>(
        Map.ofEntries(
            Map.entry("name", "Pool " + suffix),
            Map.entry(
                "baseInstrumentId",
                Map.of("admin", admins.get(0).path("partyId").asString(), "id", "BASE-" + suffix)),
            Map.entry(
                "quoteInstrumentId",
                Map.of("admin", admins.get(1).path("partyId").asString(), "id", "QUOTE-" + suffix)),
            Map.entry("feeBps", "30"),
            Map.entry("baseReserve", "1000"),
            Map.entry("quoteReserve", "2000"),
            Map.entry("lpTokenSupply", "1000"),
            Map.entry("baseAccountId", "base-" + suffix),
            Map.entry("quoteAccountId", "quote-" + suffix),
            Map.entry("lpTokenId", "LP-" + suffix)));
  }

  private JsonNode status(BackendFixture f, String token, String id, String expected) {
    var result = new java.util.concurrent.atomic.AtomicReference<JsonNode>();
    await()
        .atMost(Duration.ofSeconds(45))
        .pollInterval(Duration.ofMillis(500))
        .until(
            () -> {
              result.set(f.request("GET", ROOT + "/" + id, token, null, 200));
              return result.get().path("status").asString().equals(expected);
            });
    return result.get();
  }

  @Test
  void realProposalAcceptanceRecoveryAndAuthority() throws Exception {
    try (var f = new BackendFixture();
        var operator = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
      String token = f.token("operator");
      String trader = f.token(f.trader("pool-forbidden"));
      f.request("GET", ROOT, trader, null, 403);
      var options = f.request("GET", ROOT + "/options", token, null, 200);
      var data = input(options, UUID.randomUUID().toString().substring(0, 8));
      f.request("POST", ROOT, trader, data, 403);
      var created = f.request("POST", ROOT, token, data, 202);
      String id = created.path("proposalId").asString();
      var pending = status(f, token, id, "PENDING");
      String cid = pending.path("proposalCid").asString();
      var reversed = new LinkedHashMap<>(data);
      reversed.put("baseInstrumentId", data.get("quoteInstrumentId"));
      reversed.put("quoteInstrumentId", data.get("baseInstrumentId"));
      f.request("POST", ROOT, token, reversed, 409);
      assertThatThrownBy(
              () ->
                  operator.submit(
                      "forbidden-" + UUID.randomUUID(),
                      operator.primaryParty(),
                      List.of(),
                      new PoolProposal.ContractId(cid).exercisePoolProposal_Accept()))
          .isInstanceOf(RuntimeException.class);
      // Simulate a lost proposal response; only this test's record is changed.
      f.fixtures
          .sql()
          .sql(
              "UPDATE pool_proposals SET proposal_cid=NULL,status='UNRESOLVED',update_id=NULL WHERE id=?")
          .param(UUID.fromString(id))
          .update();
      assertThat(status(f, token, id, "PENDING").path("proposalCid").asString()).isEqualTo(cid);
      PoolDecisionMain.main(new String[] {"accept", id});
      var result = status(f, token, id, "CREATED");
      String poolId = result.path("poolId").asString();
      var detail = f.request("GET", "/v1/pools/" + poolId, token, null, 200);
      f.request("GET", "/v1/pools/" + poolId, trader, null, 200);
      assertThat(detail.path("settings").path("baseReserve").asString())
          .isEqualTo("1000.0000000000");
      var row =
          f.fixtures
              .sql()
              .sql("SELECT * FROM pools WHERE pool_id=?")
              .param(poolId)
              .query()
              .singleRow();
      assertThat(row.get("config_id")).isEqualTo(detail.path("configId").asString());
      assertThat(row.get("state_id")).isEqualTo(detail.path("stateId").asString());
      assertThat(operator.activeContracts(operator.primaryParty(), PoolProposal.TEMPLATE_ID))
          .noneMatch(e -> e.getContractId().equals(cid));
      assertThat(operator.activeContracts(operator.primaryParty(), Pool.TEMPLATE_ID))
          .anyMatch(e -> e.getContractId().equals(poolId));
      var tx =
          operator.transactions(0, operator.primaryParty()).stream()
              .filter(t -> t.getUpdateId().equals(result.path("updateId").asString()))
              .findFirst()
              .orElseThrow();
      assertThat(tx.getEventsList().stream().filter(e -> e.hasCreated()).count()).isEqualTo(3);
      var poolEvent = LedgerConnection.created(tx, Pool.TEMPLATE_ID);
      assertThat(java.time.Instant.parse(detail.path("createdAt").asString()))
          .isEqualTo(
              java.time.Instant.ofEpochSecond(
                  poolEvent.getCreatedAt().getSeconds(), poolEvent.getCreatedAt().getNanos()));
      assertThat(operator.activeContracts(operator.primaryParty(), PoolFactory.TEMPLATE_ID))
          .anyMatch(e -> e.getContractId().equals(options.path("factoryId").asString()));
      var before = operator.ledgerEnd();
      PoolDecisionMain.main(new String[] {"accept", id});
      assertThat(operator.ledgerEnd()).isEqualTo(before);
      // Replay evidence after a lost final DB confirmation, never another ledger write.
      f.fixtures
          .sql()
          .sql("UPDATE pool_proposals SET status='UNRESOLVED',pool_id=NULL WHERE id=?")
          .param(UUID.fromString(id))
          .update();
      assertThat(status(f, token, id, "CREATED").path("poolId").asString()).isEqualTo(poolId);
      f.request("POST", ROOT, token, data, 409);
      f.request("POST", ROOT + "/" + id + "/withdraw", token, Map.of(), 409);
      assertThat(f.request("GET", "/v1/pools", token, null, 200).toString()).contains(poolId);
      System.out.println(
          "PASS pool acceptance: API/Postgres/Canton CIDs match; exact three creates; operator forbidden; uncertainty reconciled; replay creates nothing.");
    }
  }

  @Test
  void definitiveFailureReleasesDatabaseReservationAndWithdrawalRemainsRetryable()
      throws Exception {
    try (var f = new BackendFixture();
        var connection = DevelopmentFixtures.connection(DevelopmentFixtures.operatorIdentity())) {
      String token = f.token("operator");
      var options = f.request("GET", ROOT + "/options", token, null, 200);
      var body = input(options, UUID.randomUUID().toString().substring(0, 8));
      var data =
          f.json.readValue(
              f.json.writeValueAsString(body), com.openzeppelin.dex.pools.PoolModels.Create.class);
      var ds = DevelopmentFixtures.dataSource();
      var store =
          new com.openzeppelin.dex.pools.PoolStore(
              org.springframework.jdbc.core.simple.JdbcClient.create(ds),
              f.json,
              new org.springframework.jdbc.datasource.DataSourceTransactionManager(ds));
      var rejected = new java.util.concurrent.atomic.AtomicBoolean(true);
      var delegate = new CantonPoolLedger(connection);
      var ledger =
          new com.openzeppelin.dex.pools.PoolLedger() {
            public String operator() {
              return delegate.operator();
            }

            public String packageId() {
              return delegate.packageId();
            }

            public long offset() {
              return delegate.offset();
            }

            public String factory(String dvv) {
              return delegate.factory(dvv);
            }

            public List<com.openzeppelin.dex.pools.PoolModels.Detail> pools(
                Map<String, String> names, String dvv) {
              return delegate.pools(names, dvv);
            }

            public Confirmation propose(
                com.openzeppelin.dex.pools.PoolModels.Proposal p, UUID command) {
              if (rejected.get())
                throw new Rejected(new IllegalStateException("Injected definitive rejection"));
              return delegate.propose(p, command);
            }

            public Confirmation withdraw(
                com.openzeppelin.dex.pools.PoolModels.Proposal p, UUID command) {
              if (rejected.get())
                throw new Rejected(new IllegalStateException("Injected definitive rejection"));
              return delegate.withdraw(p, command);
            }

            public List<Confirmation> recover(com.openzeppelin.dex.pools.PoolModels.Pending p) {
              return delegate.recover(p);
            }
          };
      var workflow = new com.openzeppelin.dex.pools.PoolWorkflow(store, ledger);
      UUID accountId =
          f.fixtures
              .sql()
              .sql("SELECT id FROM accounts WHERE role='OPERATOR' LIMIT 1")
              .query(UUID.class)
              .single();
      var actor =
          new com.openzeppelin.dex.iam.Account(
              accountId,
              "issuer",
              "operator",
              "Operator",
              com.openzeppelin.dex.iam.Account.Role.OPERATOR);
      var failed = workflow.create(data, actor);
      assertThat(failed.status()).isEqualTo(com.openzeppelin.dex.pools.PoolModels.Status.FAILED);
      assertThat(
              f.fixtures
                  .sql()
                  .sql("SELECT count(*) FROM pool_pair_claims WHERE proposal_id=?")
                  .param(failed.proposalId())
                  .query(Integer.class)
                  .single())
          .isZero();
      rejected.set(false);
      var pending = workflow.create(data, actor);
      assertThat(pending.status()).isEqualTo(com.openzeppelin.dex.pools.PoolModels.Status.PENDING);
      rejected.set(true);
      var retryable = workflow.withdraw(pending.proposalId(), actor);
      assertThat(retryable.status())
          .isEqualTo(com.openzeppelin.dex.pools.PoolModels.Status.PENDING);
      assertThat(retryable.error()).isNotBlank();
      rejected.set(false);
      assertThat(workflow.withdraw(pending.proposalId(), actor).status())
          .isEqualTo(com.openzeppelin.dex.pools.PoolModels.Status.WITHDRAWN);
    }
  }

  @Test
  void rejectionWithdrawalAndConcurrentPairReservation() throws Exception {
    try (var f = new BackendFixture()) {
      String token = f.token("operator");
      var options = f.request("GET", ROOT + "/options", token, null, 200);
      var data = input(options, UUID.randomUUID().toString().substring(0, 8));
      var proposal = f.request("POST", ROOT, token, data, 202);
      String id = proposal.path("proposalId").asString();
      status(f, token, id, "PENDING");
      PoolDecisionMain.main(new String[] {"reject", id});
      assertThat(status(f, token, id, "REJECTED").path("poolId").isNull()).isTrue();
      var next = f.request("POST", ROOT, token, data, 202);
      String nextId = next.path("proposalId").asString();
      status(f, token, nextId, "PENDING");
      f.request("POST", ROOT + "/" + nextId + "/withdraw", token, Map.of(), 202);
      status(f, token, nextId, "WITHDRAWN");
      f.request("POST", ROOT + "/" + nextId + "/withdraw", token, Map.of(), 202);
      try (var executor = Executors.newFixedThreadPool(2)) {
        var barrier = new CyclicBarrier(2);
        Callable<Integer> call =
            () -> {
              barrier.await();
              return f.send("POST", ROOT, token, data).statusCode();
            };
        var a = executor.submit(call);
        var b = executor.submit(call);
        assertThat(List.of(a.get(), b.get())).containsExactlyInAnyOrder(202, 409);
      }
      var bad = new LinkedHashMap<>(input(options, UUID.randomUUID().toString()));
      bad.put("feeBps", "10000");
      f.request("POST", ROOT, token, bad, 400);
      bad.put("feeBps", "30");
      bad.put("baseReserve", "0");
      f.request("POST", ROOT, token, bad, 400);
      System.out.println(
          "PASS reject/withdraw: no pools, pair released; concurrent duplicate guarded; invalid quantities rejected.");
    }
  }
}
