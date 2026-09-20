package com.openzeppelin.dex.canton;

import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.Identifier;
import com.daml.ledger.javaapi.data.codegen.ValueDecoder;
import com.openzeppelin.dex.canton.generated.da.time.types.RelTime;
import com.openzeppelin.dex.canton.generated.lib.tokens.Token;
import com.openzeppelin.dex.canton.generated.openzeppelin.tokencip112v1.registry.TokenRules;
import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolfactory.*;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationinstructionv2.AllocationFactory;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.SettlementFactory;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.*;
import com.openzeppelin.dex.canton.generated.testtokenfaucet.*;
import com.openzeppelin.dex.canton.generated.venuedelegation.VenueDelegation;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.Predicate;
import org.springframework.jdbc.core.simple.JdbcClient;
import tools.jackson.databind.json.JsonMapper;

/** Local test instruments and one-time pool funding. Restarting never replenishes reserves. */
public final class TestTokenFixture {
  private static final List<TestTokenAmount> CLAIM_AMOUNTS =
      List.of(amount("USDC", "10000"), amount("BTC", "0.1"), amount("ETH", "2"));
  private final JdbcClient sql;
  private final LedgerConnection issuerLedger;
  private final LedgerConnection authority;
  private final LedgerConnection operatorLedger;
  private final String issuer;
  private final String dvo;
  private final String operator;
  private CreatedEvent rules;
  private DisclosedContract rulesDisclosure;

  public TestTokenFixture(
      JdbcClient sql,
      LedgerConnection issuerLedger,
      LedgerConnection authority,
      LedgerConnection operatorLedger) {
    this.sql = sql;
    this.issuerLedger = issuerLedger;
    this.authority = authority;
    this.operatorLedger = operatorLedger;
    issuer = issuerLedger.primaryParty();
    dvo = authority.primaryParty();
    operator = operatorLedger.primaryParty();
  }

  public void initialize() {
    registry();
    pool("BTC", 8L, "5", "300000");
    pool("ETH", 10L, "100", "300000");
  }

  private void registry() {
    var saved =
        sql.sql("SELECT * FROM test_token_configuration WHERE id=1").query().listOfRows().stream()
            .findFirst();
    var candidates =
        find(
            issuerLedger,
            issuer,
            TokenRules.TEMPLATE_ID,
            TokenRules.valueDecoder(),
            value -> value.admin.equals(issuer));
    if (saved.isPresent()) {
      var row = saved.get();
      if (!issuer.equals(row.get("issuer_party_id"))
          || !TokenRules.PACKAGE_ID.equals(row.get("package_id")))
        throw new IllegalStateException(
            "Test-token registry identity changed; recreate the local participant and application databases");
      rules =
          candidates.stream()
              .filter(e -> e.getContractId().equals(row.get("rules_id")))
              .findFirst()
              .orElseThrow(
                  () -> new IllegalStateException("Configured test-token rules are inactive"));
    } else if (candidates.isEmpty()) {
      issuerLedger.submit(
          command("rules", issuer),
          issuer,
          List.of(),
          new TokenRules(issuer, new RelTime(3_600_000_000L), new RelTime(300_000_000L)).create());
      rules =
          single(
              find(
                  issuerLedger,
                  issuer,
                  TokenRules.TEMPLATE_ID,
                  TokenRules.valueDecoder(),
                  value -> value.admin.equals(issuer)),
              "test-token rules");
    } else rules = single(candidates, "test-token rules");
    if (rules.getCreatedEventBlob().isEmpty())
      throw new IllegalStateException("Registry disclosure is missing");
    String synchronizer = issuerLedger.singleSynchronizer();
    rulesDisclosure =
        DisclosedContract.newBuilder()
            .setContractId(rules.getContractId())
            .setTemplateId(rules.getTemplateId())
            .setCreatedEventBlob(rules.getCreatedEventBlob())
            .setSynchronizerId(synchronizer)
            .build();
    var faucets =
        find(
            issuerLedger,
            issuer,
            TestTokenFaucet.TEMPLATE_ID,
            TestTokenFaucet.valueDecoder(),
            f ->
                f.issuer.equals(issuer)
                    && f.operator.equals(operator)
                    && f.rulesCid.contractId.equals(rules.getContractId())
                    && sameAmounts(f.amounts, CLAIM_AMOUNTS));
    CreatedEvent faucet;
    if (saved.isPresent()) {
      faucet =
          faucets.stream()
              .filter(e -> e.getContractId().equals(saved.get().get("faucet_factory_id")))
              .findFirst()
              .orElseThrow(
                  () -> new IllegalStateException("Configured test-token faucet is inactive"));
    } else {
      if (faucets.isEmpty()) {
        issuerLedger.submit(
            command("faucet", rules.getContractId()),
            issuer,
            List.of(),
            new TestTokenFaucet(
                    issuer,
                    operator,
                    new TokenRules.ContractId(rules.getContractId()),
                    CLAIM_AMOUNTS)
                .create());
        faucets =
            find(
                issuerLedger,
                issuer,
                TestTokenFaucet.TEMPLATE_ID,
                TestTokenFaucet.valueDecoder(),
                f ->
                    f.issuer.equals(issuer)
                        && f.operator.equals(operator)
                        && f.rulesCid.contractId.equals(rules.getContractId())
                        && sameAmounts(f.amounts, CLAIM_AMOUNTS));
      }
      faucet = single(faucets, "test-token faucet");
    }
    sql.sql(
            "INSERT INTO"
                + " test_token_configuration(id,issuer_party_id,rules_id,package_id,allocation_factory_id,settlement_factory_id,faucet_factory_id,synchronizer_id,rules_created_event_blob)"
                + " VALUES(1,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
        .params(
            issuer,
            rules.getContractId(),
            TokenRules.PACKAGE_ID,
            rules.getContractId(),
            rules.getContractId(),
            faucet.getContractId(),
            synchronizer,
            Base64.getEncoder().encodeToString(rules.getCreatedEventBlob().toByteArray()))
        .update();
    sql.sql(
            "INSERT INTO token_registries(admin,allocation_factory_id,settlement_factory_id)"
                + " VALUES(?,?,?) ON CONFLICT(admin) DO NOTHING")
        .params(issuer, rules.getContractId(), rules.getContractId())
        .update();
    var template = rules.getTemplateId();
    sql.sql(
            "INSERT INTO token_registry_contracts"
                + " (admin,contract_id,template_id,created_event_blob,synchronizer_id)"
                + " VALUES(?,?,?,?,?) ON CONFLICT(admin,contract_id) DO NOTHING")
        .params(
            issuer,
            rules.getContractId(),
            template.getPackageId()
                + ":"
                + template.getModuleName()
                + ":"
                + template.getEntityName(),
            Base64.getEncoder().encodeToString(rules.getCreatedEventBlob().toByteArray()),
            synchronizer)
        .update();
    for (var token : CLAIM_AMOUNTS) {
      int decimals =
          switch (token.instrumentId) {
            case "USDC" -> 6;
            case "BTC" -> 8;
            default -> 10;
          };
      sql.sql(
              "INSERT INTO token_instruments(admin,instrument_id,symbol,decimals)"
                  + " VALUES(?,?,?,?) ON CONFLICT(admin,instrument_id) DO NOTHING")
          .params(issuer, token.instrumentId, token.instrumentId, decimals)
          .update();
      sql.sql(
              "INSERT INTO"
                  + " test_token_instruments(symbol,instrument_id,decimals,initial_claim_amount)"
                  + " VALUES(?,?,?,?) ON CONFLICT(symbol) DO NOTHING")
          .params(token.instrumentId, token.instrumentId, decimals, token.amount)
          .update();
    }
  }

  private void pool(String base, long decimals, String baseReserve, String quoteReserve) {
    String pair = base + "/USDC";
    String accountPrefix = "mvp-" + base.toLowerCase(Locale.ROOT) + "-usdc-";
    var settings =
        new PoolSettings(
            dvo,
            new InstrumentId(issuer, base),
            new InstrumentId(issuer, "USDC"),
            account(accountPrefix + "base"),
            account(accountPrefix + "quote"),
            new InstrumentId(dvo, "LP-" + base + "-USDC"),
            new BigDecimal("30"),
            new BigDecimal(baseReserve),
            new BigDecimal(quoteReserve),
            new BigDecimal("1000"));
    var mapped =
        sql
            .sql("SELECT * FROM test_token_pools WHERE pair=?")
            .param(pair)
            .query()
            .listOfRows()
            .stream()
            .findFirst();
    var matches =
        find(
            authority,
            dvo,
            Pool.TEMPLATE_ID,
            Pool.valueDecoder(),
            p ->
                p.dvo.equals(dvo)
                    && p.venueOperator.equals(operator)
                    && p.baseInstrumentId.equals(settings.baseInstrumentId)
                    && p.quoteInstrumentId.equals(settings.quoteInstrumentId)
                    && p.baseAccount.equals(settings.baseAccount)
                    && p.quoteAccount.equals(settings.quoteAccount));
    CreatedEvent pool;
    if (mapped.isPresent()) {
      pool =
          matches.stream()
              .filter(e -> e.getContractId().equals(mapped.get().get("pool_id")))
              .findFirst()
              .orElseThrow(
                  () -> new IllegalStateException("Configured fixture pool is inactive: " + pair));
    } else {
      if (matches.isEmpty()) {
        var factory = factory();
        var proposals =
            find(
                authority,
                dvo,
                PoolProposal.TEMPLATE_ID,
                PoolProposal.valueDecoder(),
                p ->
                    p.factoryCid.contractId.equals(factory.getContractId())
                        && CantonPoolLedger.same(
                            PoolEncoding.from(p.settings), PoolEncoding.from(settings)));
        if (proposals.isEmpty()) {
          var proposed =
              operatorLedger.submit(
                  command("propose", accountPrefix),
                  operator,
                  List.of(),
                  new PoolFactory.ContractId(factory.getContractId())
                      .exercisePoolFactory_ProposePool(settings));
          proposals = List.of(LedgerConnection.created(proposed, PoolProposal.TEMPLATE_ID));
        }
        var accepted =
            authority.submit(
                command("accept", accountPrefix),
                dvo,
                List.of(),
                new PoolProposal.ContractId(single(proposals, "fixture proposal").getContractId())
                    .exercisePoolProposal_Accept());
        matches = List.of(LedgerConnection.created(accepted, Pool.TEMPLATE_ID));
      }
      pool = single(matches, "fixture pool " + pair);
    }
    String poolId = pool.getContractId();
    var config =
        single(
            find(
                authority,
                dvo,
                PoolConfig.TEMPLATE_ID,
                PoolConfig.valueDecoder(),
                c -> c.poolCid.contractId.equals(poolId)),
            "pool configuration");
    var state = state(poolId);
    var terms =
        PoolEncoding.terms(
            decode(pool, Pool.valueDecoder()),
            decode(config, PoolConfig.valueDecoder()),
            decode(state, PoolState.valueDecoder()));
    sql.sql(
            "INSERT INTO pools(pool_id,config_id,state_id,package_id,name,active,settings)"
                + " VALUES(?,?,?,?,?,true,CAST(? AS jsonb)) ON CONFLICT(pool_id) DO UPDATE SET"
                + " config_id=EXCLUDED.config_id,state_id=EXCLUDED.state_id,active=true,settings=EXCLUDED.settings")
        .params(
            poolId,
            config.getContractId(),
            state.getContractId(),
            pool.getTemplateId().getPackageId(),
            pair + " test pool",
            JsonMapper.builder().build().writeValueAsString(terms))
        .update();
    sql.sql("INSERT INTO test_token_pools(pair,pool_id) VALUES(?,?) ON CONFLICT(pair) DO NOTHING")
        .params(pair, poolId)
        .update();
    sql.sql(
            "INSERT INTO pool_pair_claims(pair_key,pool_id) VALUES(?,?) ON CONFLICT(pair_key) DO"
                + " NOTHING")
        .params(terms.pairKey(), poolId)
        .update();
    if (decode(state, PoolState.valueDecoder()).funding.isEmpty()) {
      var baseHoldings =
          claim(
              "pool:" + poolId + ":base", settings.baseAccount, List.of(amount(base, baseReserve)));
      var quoteHoldings =
          claim(
              "pool:" + poolId + ":quote",
              settings.quoteAccount,
              List.of(amount("USDC", quoteReserve)));
      var funded =
          authority.submit(
              command("fund", poolId),
              dvo,
              List.of(),
              new Pool.ContractId(poolId)
                  .exercisePool_Fund(
                      new PoolConfig.ContractId(config.getContractId()),
                      new PoolState.ContractId(state.getContractId()),
                      new PoolFunding(
                          token(base, decimals), token("USDC", 6L), baseHoldings, quoteHoldings)),
              List.of(rulesDisclosure));
      state = LedgerConnection.created(funded, PoolState.TEMPLATE_ID);
      sql.sql("UPDATE pools SET state_id=? WHERE pool_id=?")
          .params(state.getContractId(), poolId)
          .update();
    }
    delegation(poolId);
  }

  private CreatedEvent factory() {
    var factories =
        find(
            authority,
            dvo,
            PoolFactory.TEMPLATE_ID,
            PoolFactory.valueDecoder(),
            f -> f.dvo.equals(dvo) && f.venueOperator.equals(operator));
    if (factories.isEmpty())
      return LedgerConnection.created(
          authority.submit(
              command("factory", dvo), dvo, List.of(), new PoolFactory(dvo, operator).create()),
          PoolFactory.TEMPLATE_ID);
    return factories.stream().min(Comparator.comparing(CreatedEvent::getContractId)).orElseThrow();
  }

  private CreatedEvent state(String poolId) {
    return single(
        find(
            authority,
            dvo,
            PoolState.TEMPLATE_ID,
            PoolState.valueDecoder(),
            s -> s.poolCid.contractId.equals(poolId)),
        "pool state");
  }

  private List<Holding.ContractId> claim(
      String grantId, Account account, List<TestTokenAmount> amounts) {
    var receipts =
        find(
            authority,
            dvo,
            TestTokenReceipt.TEMPLATE_ID,
            TestTokenReceipt.valueDecoder(),
            r -> r.grantId.equals(grantId));
    if (!receipts.isEmpty()) {
      var receipt = decode(single(receipts, "funding receipt"), TestTokenReceipt.valueDecoder());
      if (!receipt.issuer.equals(issuer)
          || !receipt.recipient.equals(dvo)
          || !receipt.account.equals(account)
          || !receipt.rulesCid.contractId.equals(rules.getContractId())
          || !sameAmounts(receipt.amounts, amounts))
        throw new IllegalStateException("Pool funding receipt differs");
      return receipt.holdingCids;
    }
    var grants =
        find(
            authority,
            dvo,
            TestTokenGrant.TEMPLATE_ID,
            TestTokenGrant.valueDecoder(),
            g -> g.grantId.equals(grantId));
    if (grants.isEmpty()) {
      var created =
          issuerLedger.submit(
              command("grant", grantId),
              issuer,
              List.of(),
              new TestTokenGrant(
                      issuer,
                      operator,
                      grantId,
                      new TokenRules.ContractId(rules.getContractId()),
                      dvo,
                      account,
                      amounts)
                  .create());
      grants = List.of(LedgerConnection.created(created, TestTokenGrant.TEMPLATE_ID));
    }
    var grant = single(grants, "pool funding grant");
    var value = decode(grant, TestTokenGrant.valueDecoder());
    if (!value.issuer.equals(issuer)
        || !value.recipient.equals(dvo)
        || !value.account.equals(account)
        || !value.rulesCid.contractId.equals(rules.getContractId())
        || !sameAmounts(value.amounts, amounts))
      throw new IllegalStateException("Pool funding grant differs");
    var claimed =
        authority.submit(
            command("claim", grantId),
            dvo,
            List.of(),
            new TestTokenGrant.ContractId(grant.getContractId()).exerciseTestTokenGrant_Claim(),
            List.of(rulesDisclosure));
    return decode(
            LedgerConnection.created(claimed, TestTokenReceipt.TEMPLATE_ID),
            TestTokenReceipt.valueDecoder())
        .holdingCids;
  }

  private void delegation(String poolId) {
    var row =
        sql.sql("SELECT delegation_id FROM test_token_pools WHERE pool_id=?")
            .param(poolId)
            .query()
            .singleRow();
    if (row.get("delegation_id") != null) return;
    var delegates =
        find(
            authority,
            dvo,
            VenueDelegation.TEMPLATE_ID,
            VenueDelegation.valueDecoder(),
            d ->
                d.poolCid.contractId.equals(poolId)
                    && d.dvo.equals(dvo)
                    && d.venueOperator.equals(operator));
    if (delegates.isEmpty()) {
      var created =
          authority.submit(
              command("delegate", poolId),
              dvo,
              List.of(),
              new VenueDelegation(dvo, operator, new Pool.ContractId(poolId)).create());
      delegates = List.of(LedgerConnection.created(created, VenueDelegation.TEMPLATE_ID));
    }
    sql.sql("UPDATE test_token_pools SET delegation_id=? WHERE pool_id=? AND delegation_id IS NULL")
        .params(single(delegates, "venue delegation").getContractId(), poolId)
        .update();
  }

  private Account account(String id) {
    return new Account(Optional.of(dvo), Optional.empty(), id);
  }

  private Token token(String id, long decimals) {
    return new Token(
        new InstrumentId(issuer, id),
        new AllocationFactory.ContractId(rules.getContractId()),
        new SettlementFactory.ContractId(rules.getContractId()),
        decimals);
  }

  private static boolean sameAmounts(List<TestTokenAmount> left, List<TestTokenAmount> right) {
    if (left.size() != right.size()) return false;
    for (int i = 0; i < left.size(); i++)
      if (!left.get(i).instrumentId.equals(right.get(i).instrumentId)
          || left.get(i).amount.compareTo(right.get(i).amount) != 0) return false;
    return true;
  }

  private static TestTokenAmount amount(String id, String amount) {
    return new TestTokenAmount(id, new BigDecimal(amount));
  }

  private static String command(String action, String key) {
    return UUID.nameUUIDFromBytes(
            ("canton-dex:" + Pool.PACKAGE_ID + ":" + action + ":" + key)
                .getBytes(StandardCharsets.UTF_8))
        .toString();
  }

  private static <T> T decode(CreatedEvent event, ValueDecoder<T> decoder) {
    return decoder.decode(DamlRecord.fromProto(event.getCreateArguments()));
  }

  private static <T> List<CreatedEvent> find(
      LedgerConnection ledger,
      String party,
      Identifier template,
      ValueDecoder<T> decoder,
      Predicate<T> predicate) {
    return ledger.activeContracts(party, template).stream()
        .filter(
            e ->
                e.getTemplateId().getPackageId().equals(TokenRules.PACKAGE_ID)
                    || Pool.PACKAGE_ID.equals(e.getTemplateId().getPackageId())
                    || TestTokenFaucet.PACKAGE_ID.equals(e.getTemplateId().getPackageId()))
        .filter(e -> predicate.test(decode(e, decoder)))
        .toList();
  }

  private static CreatedEvent single(List<CreatedEvent> events, String label) {
    if (events.size() != 1)
      throw new IllegalStateException("Expected one " + label + ", found " + events.size());
    return events.getFirst();
  }
}
