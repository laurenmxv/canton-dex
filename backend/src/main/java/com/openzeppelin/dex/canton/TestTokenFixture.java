package com.openzeppelin.dex.canton;

import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.Identifier;
import com.daml.ledger.javaapi.data.codegen.ValueDecoder;
import com.openzeppelin.dex.canton.generated.da.time.types.RelTime;
import com.openzeppelin.dex.canton.generated.kycattestation.KycAttestation;
import com.openzeppelin.dex.canton.generated.lib.liquidity.*;
import com.openzeppelin.dex.canton.generated.lib.tokens.Token;
import com.openzeppelin.dex.canton.generated.openzeppelin.tokencip112v1.holding.TokenHolding;
import com.openzeppelin.dex.canton.generated.openzeppelin.tokencip112v1.registry.TokenRules;
import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolaccess.PoolAccess;
import com.openzeppelin.dex.canton.generated.poolfactory.*;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationinstructionv2.AllocationFactory;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.Allocation;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.AllocationView;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.SettlementFactory;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.*;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.ChoiceContext;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.ExtraArgs;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.Metadata;
import com.openzeppelin.dex.canton.generated.testtokenfaucet.*;
import com.openzeppelin.dex.canton.generated.venuedelegation.DepositSettlementRequest;
import com.openzeppelin.dex.canton.generated.venuedelegation.VenueDelegation;
import com.openzeppelin.dex.pools.PoolModels;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
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
  private CreatedEvent lpRules;
  private DisclosedContract lpRulesDisclosure;
  private static final ExtraArgs EMPTY =
      new ExtraArgs(new ChoiceContext(Map.of()), new Metadata(Map.of()));

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
    lpRegistry();
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

  private void lpRegistry() {
    var matches =
        find(
            authority,
            dvo,
            TokenRules.TEMPLATE_ID,
            TokenRules.valueDecoder(),
            r -> r.admin.equals(dvo));
    if (matches.isEmpty()) {
      authority.submit(
          command("lp-rules", dvo),
          dvo,
          List.of(),
          new TokenRules(dvo, new RelTime(3_600_000_000L), new RelTime(300_000_000L)).create());
      matches =
          find(
              authority,
              dvo,
              TokenRules.TEMPLATE_ID,
              TokenRules.valueDecoder(),
              r -> r.admin.equals(dvo));
    }
    lpRules = single(matches, "LP token rules");
    lpRulesDisclosure = disclosure(lpRules);
    sql.sql(
            "INSERT INTO token_registries(admin,allocation_factory_id,settlement_factory_id)"
                + " VALUES(?,?,?) ON CONFLICT(admin) DO NOTHING")
        .params(dvo, lpRules.getContractId(), lpRules.getContractId())
        .update();
    var template = lpRules.getTemplateId();
    sql.sql(
            "INSERT INTO token_registry_contracts(admin,contract_id,template_id,created_event_blob,synchronizer_id)"
                + " VALUES(?,?,?,?,?) ON CONFLICT(admin,contract_id) DO NOTHING")
        .params(
            dvo,
            lpRules.getContractId(),
            template.getPackageId()
                + ":"
                + template.getModuleName()
                + ":"
                + template.getEntityName(),
            Base64.getEncoder().encodeToString(lpRules.getCreatedEventBlob().toByteArray()),
            authority.singleSynchronizer())
        .update();
  }

  private void pool(String base, long decimals, String baseReserve, String quoteReserve) {
    String pair = base + "/USDC";
    String fixtureId = command("fixture-pool", pair);
    var settings =
        new PoolSettings(
            dvo,
            fixtureId,
            token(base, decimals),
            token("USDC", 6L),
            new AllocationFactory.ContractId(lpRules.getContractId()),
            new SettlementFactory.ContractId(lpRules.getContractId()),
            new BigDecimal("30"));
    var matches =
        find(
            authority,
            dvo,
            Pool.TEMPLATE_ID,
            Pool.valueDecoder(),
            p ->
                p.dvo.equals(dvo)
                    && p.venueOperator.equals(operator)
                    && p.lpToken.instrument.id.equals("lp:" + fixtureId));
    CreatedEvent pool;
    if (matches.isEmpty()) {
      var factory = factory();
      var proposals =
          find(
              authority,
              dvo,
              PoolProposal.TEMPLATE_ID,
              PoolProposal.valueDecoder(),
              p ->
                  !p.accepted
                      && p.factoryCid.contractId.equals(factory.getContractId())
                      && p.settings.poolId.equals(fixtureId));
      if (proposals.isEmpty()) {
        var proposed =
            operatorLedger.submit(
                command("propose", fixtureId),
                operator,
                List.of(),
                new PoolFactory.ContractId(factory.getContractId())
                    .exercisePoolFactory_ProposePool(settings));
        proposals = List.of(LedgerConnection.created(proposed, PoolProposal.TEMPLATE_ID));
      }
      var accepted =
          authority.submit(
              command("accept", fixtureId),
              dvo,
              List.of(),
              new PoolProposal.ContractId(single(proposals, "fixture proposal").getContractId())
                  .exercisePoolProposal_Accept(
                      new BigDecimal(quoteReserve)
                          .divide(new BigDecimal(baseReserve), 10, RoundingMode.FLOOR)),
              List.of(rulesDisclosure, lpRulesDisclosure));
      String createdPoolId = LedgerConnection.created(accepted, Pool.TEMPLATE_ID).getContractId();
      pool =
          single(
              find(
                  authority,
                  dvo,
                  Pool.TEMPLATE_ID,
                  Pool.valueDecoder(),
                  p -> p.lpToken.instrument.id.equals("lp:" + fixtureId)),
              "created fixture pool");
      if (!pool.getContractId().equals(createdPoolId))
        throw new IllegalStateException("Fixture pool identity differs");
    } else pool = single(matches, "fixture pool " + pair);
    String poolId = pool.getContractId();
    var poolValue = decode(pool, Pool.valueDecoder());
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
    storePool(pool, config, state, pair);
    sql.sql("INSERT INTO test_token_pools(pair,pool_id) VALUES(?,?) ON CONFLICT(pair) DO NOTHING")
        .params(pair, poolId)
        .update();
    String delegationId = delegation(poolId);
    if (decode(state, PoolState.valueDecoder()).lpTokenSupply.signum() == 0) {
      seed(
          pool,
          config,
          state,
          delegationId,
          new BigDecimal(baseReserve),
          new BigDecimal(quoteReserve));
      state = state(poolId);
    }
    var terms = storePool(pool, config, state, pair);
    sql.sql(
            "INSERT INTO pool_pair_claims(pair_key,pool_id) VALUES(?,?) ON CONFLICT(pair_key) DO NOTHING")
        .params(terms.pairKey(), poolId)
        .update();
    sql.sql(
            "INSERT INTO token_instruments(admin,instrument_id,symbol,decimals) VALUES(?,?,?,?)"
                + " ON CONFLICT(admin,instrument_id) DO NOTHING")
        .params(dvo, poolValue.lpToken.instrument.id, "LP-" + base + "-USDC", 10)
        .update();
  }

  private PoolModels.Terms storePool(
      CreatedEvent pool, CreatedEvent config, CreatedEvent state, String pair) {
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
            pool.getContractId(),
            config.getContractId(),
            state.getContractId(),
            pool.getTemplateId().getPackageId(),
            pair + " test pool",
            JsonMapper.builder().build().writeValueAsString(terms))
        .update();
    return terms;
  }

  private void seed(
      CreatedEvent poolEvent,
      CreatedEvent configEvent,
      CreatedEvent stateEvent,
      String delegationId,
      BigDecimal baseAmount,
      BigDecimal quoteAmount) {
    String poolId = poolEvent.getContractId();
    var pool = decode(poolEvent, Pool.valueDecoder());
    var config = decode(configEvent, PoolConfig.valueDecoder());
    var access = seedAccess(poolId);
    String requestId = command("initial-liquidity", poolId);
    var allocations =
        issuerLedger
            .activeInterfaceContracts(issuer, Allocation.INTERFACE_ID, issuerLedger.ledgerEnd())
            .stream()
            .filter(e -> allocation(e).settlement.id.startsWith("deposit:" + requestId + ":"))
            .toList();
    Instant deadline;
    if (allocations.isEmpty()) {
      var account = new Account(Optional.of(issuer), Optional.empty(), "");
      claim(
          "pool:" + poolId + ":base",
          account,
          List.of(new TestTokenAmount(pool.baseToken.instrument.id, baseAmount)));
      claim(
          "pool:" + poolId + ":quote",
          account,
          List.of(new TestTokenAmount(pool.quoteToken.instrument.id, quoteAmount)));
      deadline = Instant.now().plusSeconds(1800).truncatedTo(ChronoUnit.MICROS);
      var terms = seedTerms(requestId, baseAmount, quoteAmount, config.initialRatio, deadline);
      issuerLedger.submit(
          command("deposit", requestId),
          issuer,
          List.of(),
          new PoolAccess.ContractId(access.getContractId())
              .exercisePoolAccess_RequestLiquidityDeposit(
                  terms,
                  Instant.now().minusSeconds(1).truncatedTo(ChronoUnit.MICROS),
                  seedHoldings(pool.baseToken.instrument, baseAmount),
                  seedHoldings(pool.quoteToken.instrument, quoteAmount),
                  EMPTY,
                  EMPTY,
                  EMPTY),
          List.of(rulesDisclosure, lpRulesDisclosure, disclosure(poolEvent)));
      allocations =
          issuerLedger
              .activeInterfaceContracts(issuer, Allocation.INTERFACE_ID, issuerLedger.ledgerEnd())
              .stream()
              .filter(e -> allocation(e).settlement.id.startsWith("deposit:" + requestId + ":"))
              .toList();
    } else
      deadline = allocation(allocations.getFirst()).allocation.settlementDeadline.orElseThrow();
    if (allocations.size() != 3 || !Instant.now().isBefore(deadline))
      throw new IllegalStateException(
          "Initial liquidity requires three live allocations: " + poolId);
    var request =
        new DepositRequest<Pool>(
            new Pool.ContractId(poolId),
            issuer,
            seedTerms(requestId, baseAmount, quoteAmount, config.initialRatio, deadline),
            seedAllocation(allocations, pool.baseToken.instrument),
            seedAllocation(allocations, pool.quoteToken.instrument),
            new Allocation.ContractId(
                single(
                        allocations.stream()
                            .filter(e -> allocation(e).allocation.admin.equals(dvo))
                            .toList(),
                        "LP receipt allocation")
                    .getContractId()));
    operatorLedger.submit(
        command("settle-initial-liquidity", requestId),
        operator,
        List.of(),
        new VenueDelegation.ContractId(delegationId)
            .exerciseVenueDelegation_AddLiquidity(
                new PoolConfig.ContractId(configEvent.getContractId()),
                new PoolState.ContractId(stateEvent.getContractId()),
                List.of(
                    new DepositSettlementRequest(
                        new PoolAccess.ContractId(access.getContractId()),
                        new DepositBatchRequest<>(
                            request,
                            new LiquidityTokenArgs(EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY))))),
        List.of(rulesDisclosure, lpRulesDisclosure));
  }

  private CreatedEvent seedAccess(String poolId) {
    var attestations =
        find(
            operatorLedger,
            operator,
            KycAttestation.TEMPLATE_ID,
            KycAttestation.valueDecoder(),
            a ->
                a.venueOperator.equals(operator)
                    && a.trader.equals(issuer)
                    && a.pools.equals(List.of(new Pool.ContractId(poolId))));
    if (attestations.isEmpty()) {
      var created =
          operatorLedger.submit(
              command("seed-kyc", poolId),
              operator,
              List.of(),
              new KycAttestation(operator, issuer, List.of(new Pool.ContractId(poolId))).create());
      attestations = List.of(LedgerConnection.created(created, KycAttestation.TEMPLATE_ID));
    }
    var attestationId =
        new KycAttestation.ContractId(
            single(attestations, "initial LP attestation").getContractId());
    var accesses =
        find(
            operatorLedger,
            operator,
            PoolAccess.TEMPLATE_ID,
            PoolAccess.valueDecoder(),
            a ->
                a.venueOperator.equals(operator)
                    && a.trader.equals(issuer)
                    && a.poolCid.contractId.equals(poolId)
                    && a.attestationCid.equals(attestationId));
    if (accesses.isEmpty()) {
      var created =
          operatorLedger.submit(
              command("seed-access", poolId),
              operator,
              List.of(),
              new PoolAccess(operator, issuer, new Pool.ContractId(poolId), attestationId)
                  .create());
      return LedgerConnection.created(created, PoolAccess.TEMPLATE_ID);
    }
    return single(accesses, "initial LP access");
  }

  private List<Holding.ContractId> seedHoldings(InstrumentId instrument, BigDecimal amount) {
    var holdings =
        find(
            issuerLedger,
            issuer,
            TokenHolding.TEMPLATE_ID,
            TokenHolding.valueDecoder(),
            h ->
                h.holding.instrumentId.equals(instrument)
                    && h.holding.account.equals(
                        new Account(Optional.of(issuer), Optional.empty(), ""))
                    && h.holding.lock.isEmpty());
    var selected = new ArrayList<Holding.ContractId>();
    BigDecimal total = BigDecimal.ZERO;
    for (var event : holdings) {
      selected.add(new Holding.ContractId(event.getContractId()));
      total = total.add(decode(event, TokenHolding.valueDecoder()).holding.amount);
      if (total.compareTo(amount) >= 0) return selected;
      if (selected.size() == 16) break;
    }
    throw new IllegalStateException(
        "Initial LP has insufficient available holdings for " + instrument.id);
  }

  private static DepositTerms seedTerms(
      String requestId, BigDecimal base, BigDecimal quote, BigDecimal ratio, Instant deadline) {
    return new DepositTerms(
        requestId,
        DepositMode.INITIALIZEONLY,
        base,
        quote,
        BigDecimal.ZERO,
        ratio,
        ratio,
        deadline);
  }

  private static AllocationView allocation(CreatedEvent event) {
    return AllocationView.valueDecoder()
        .decode(InterfaceViews.view(event, Allocation.INTERFACE_ID_WITH_PACKAGE_ID));
  }

  private static Allocation.ContractId seedAllocation(
      List<CreatedEvent> allocations, InstrumentId instrument) {
    return new Allocation.ContractId(
        single(
                allocations.stream()
                    .filter(
                        e ->
                            allocation(e).allocation.admin.equals(instrument.admin)
                                && allocation(e)
                                    .allocation
                                    .nextIterationFunding
                                    .map(funding -> funding.containsKey(instrument.id))
                                    .orElse(false))
                    .toList(),
                instrument.id + " funding allocation")
            .getContractId());
  }

  private DisclosedContract disclosure(CreatedEvent event) {
    if (event.getCreatedEventBlob().isEmpty())
      throw new IllegalStateException("Fixture disclosure is missing");
    return DisclosedContract.newBuilder()
        .setContractId(event.getContractId())
        .setTemplateId(event.getTemplateId())
        .setCreatedEventBlob(event.getCreatedEventBlob())
        .setSynchronizerId(authority.singleSynchronizer())
        .build();
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

  private void claim(String grantId, Account account, List<TestTokenAmount> amounts) {
    var receipts =
        find(
            issuerLedger,
            issuer,
            TestTokenReceipt.TEMPLATE_ID,
            TestTokenReceipt.valueDecoder(),
            r -> r.grantId.equals(grantId));
    if (!receipts.isEmpty()) {
      var receipt = decode(single(receipts, "funding receipt"), TestTokenReceipt.valueDecoder());
      if (!receipt.issuer.equals(issuer)
          || !receipt.recipient.equals(issuer)
          || !receipt.account.equals(account)
          || !receipt.rulesCid.contractId.equals(rules.getContractId())
          || !sameAmounts(receipt.amounts, amounts))
        throw new IllegalStateException("Pool funding receipt differs");
      return;
    }
    var grants =
        find(
            issuerLedger,
            issuer,
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
                      issuer,
                      account,
                      amounts)
                  .create());
      grants = List.of(LedgerConnection.created(created, TestTokenGrant.TEMPLATE_ID));
    }
    var grant = single(grants, "pool funding grant");
    var value = decode(grant, TestTokenGrant.valueDecoder());
    if (!value.issuer.equals(issuer)
        || !value.recipient.equals(issuer)
        || !value.account.equals(account)
        || !value.rulesCid.contractId.equals(rules.getContractId())
        || !sameAmounts(value.amounts, amounts))
      throw new IllegalStateException("Pool funding grant differs");
    var claimed =
        issuerLedger.submit(
            command("claim", grantId),
            issuer,
            List.of(),
            new TestTokenGrant.ContractId(grant.getContractId()).exerciseTestTokenGrant_Claim(),
            List.of(rulesDisclosure));
    LedgerConnection.created(claimed, TestTokenReceipt.TEMPLATE_ID);
  }

  private String delegation(String poolId) {
    var row =
        sql.sql("SELECT delegation_id FROM test_token_pools WHERE pool_id=?")
            .param(poolId)
            .query()
            .singleRow();
    if (row.get("delegation_id") != null) return row.get("delegation_id").toString();
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
    return single(delegates, "venue delegation").getContractId();
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
