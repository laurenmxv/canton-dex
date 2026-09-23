package com.openzeppelin.dex.canton;

import com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract;
import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.Identifier;
import com.openzeppelin.dex.canton.generated.kycattestation.KycAttestation;
import com.openzeppelin.dex.canton.generated.lib.swap.*;
import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolaccess.PoolAccess;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Holding;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.HoldingView;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.InstrumentId;
import com.openzeppelin.dex.canton.generated.venuedelegation.VenueDelegation;
import com.openzeppelin.dex.pools.PoolStore;
import com.openzeppelin.dex.settlements.SettlementModels.Reserves;
import com.openzeppelin.dex.swaps.SwapFailure;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Component;

/** A coherent ledger snapshot, using the operator's read-only view of reserve accounts. */
@Component
final class CantonPools {
  private final LedgerConnection ledger;
  private final PoolStore pools;
  private final CantonTokenRegistry registries;

  CantonPools(LedgerConnection ledger, PoolStore pools, CantonTokenRegistry registries) {
    this.ledger = ledger;
    this.pools = pools;
    this.registries = registries;
  }

  record Snapshot(
      String poolId,
      String name,
      long offset,
      Instant observedAt,
      CreatedEvent poolEvent,
      Pool pool,
      CreatedEvent configEvent,
      PoolConfig config,
      CreatedEvent stateEvent,
      PoolState state,
      CreatedEvent delegationEvent,
      String health,
      String reason) {
    SwapRoute<Pool> route() {
      return new SwapRoute<>(
          new Pool.ContractId(poolId),
          pool.dvo,
          pool.venueOperator,
          pool.baseToken,
          pool.quoteToken,
          pool.baseAccount,
          pool.quoteAccount);
    }

    String version() {
      return stateEvent.getContractId() + ":" + configEvent.getContractId();
    }

    Reserves reserves() {
      return new Reserves(
          stateEvent.getContractId(),
          SwapMath.text(state.baseReserve),
          SwapMath.text(state.quoteReserve),
          state.baseReserve.signum() == 0
              ? null
              : SwapMath.text(
                  state.quoteReserve.divide(state.baseReserve, 10, RoundingMode.HALF_UP)),
          SwapMath.text(state.baseReserve.multiply(state.quoteReserve)));
    }

    void requireLiquidityReady() {
      if (!health.equals("READY") && !health.equals("EMPTY"))
        throw SwapFailure.conflict(health, reason);
    }

    void requireReady() {
      if (!health.equals("READY")) throw SwapFailure.conflict(health, reason);
    }
  }

  Snapshot read(String poolId) {
    return read(poolId, ledger.ledgerEnd());
  }

  Snapshot read(String poolId, long offset) {
    var catalog = pools.pool(poolId, Pool.PACKAGE_ID);
    String operator = ledger.primaryParty();
    var poolEvent =
        single(
            contracts(operator, Pool.TEMPLATE_ID, offset).stream()
                .filter(e -> e.getContractId().equals(poolId))
                .toList(),
            "Pool");
    var pool = Pool.valueDecoder().decode(DamlRecord.fromProto(poolEvent.getCreateArguments()));
    if (!pool.venueOperator.equals(operator) || !pool.dvo.equals(pools.dvo()))
      throw new IllegalStateException("Pool authority differs from the configured venue");
    var configEvent =
        single(
            contracts(operator, PoolConfig.TEMPLATE_ID, offset).stream()
                .filter(
                    e ->
                        PoolConfig.valueDecoder()
                            .decode(DamlRecord.fromProto(e.getCreateArguments()))
                            .poolCid
                            .contractId
                            .equals(poolId))
                .toList(),
            "Pool configuration");
    var stateEvent =
        single(
            contracts(operator, PoolState.TEMPLATE_ID, offset).stream()
                .filter(
                    e ->
                        PoolState.valueDecoder()
                            .decode(DamlRecord.fromProto(e.getCreateArguments()))
                            .poolCid
                            .contractId
                            .equals(poolId))
                .toList(),
            "Pool state");
    var config =
        PoolConfig.valueDecoder().decode(DamlRecord.fromProto(configEvent.getCreateArguments()));
    var state =
        PoolState.valueDecoder().decode(DamlRecord.fromProto(stateEvent.getCreateArguments()));
    PoolEncoding.validateComponents(pool, config, state);
    var delegation =
        contracts(operator, VenueDelegation.TEMPLATE_ID, offset).stream()
            .filter(
                e -> {
                  var value =
                      VenueDelegation.valueDecoder()
                          .decode(DamlRecord.fromProto(e.getCreateArguments()));
                  return value.poolCid.contractId.equals(poolId)
                      && value.dvo.equals(pool.dvo)
                      && value.venueOperator.equals(operator);
                })
            .toList();
    if (delegation.size() > 1)
      throw new IllegalStateException("Multiple settlement delegations for pool");
    String health = state.lpTokenSupply.signum() == 0 ? "EMPTY" : "READY", reason = null;
    var holdings = ledger.activeInterfaceContracts(pool.dvo, Holding.INTERFACE_ID, offset);
    boolean backed =
        backed(
                holdings,
                state.baseHoldingCids,
                pool.baseAccount,
                pool.baseToken.instrument,
                state.baseReserve)
            && backed(
                holdings,
                state.quoteHoldingCids,
                pool.quoteAccount,
                pool.quoteToken.instrument,
                state.quoteReserve);
    if (!backed) {
      health = "BACKING_MISMATCH";
      reason = "Pool holdings do not match reserves";
    } else if (delegation.isEmpty()) {
      health = "DELEGATION_MISSING";
      reason = "Settlement authority is unavailable";
    }
    if (health.equals("READY") || health.equals("EMPTY")) {
      try {
        requireFactories(pool.baseToken);
        requireFactories(pool.quoteToken);
        requireFactories(pool.lpToken);
      } catch (SwapFailure failure) {
        health = failure.code();
        reason = failure.getMessage();
      }
    }
    return new Snapshot(
        poolId,
        catalog.name(),
        offset,
        Instant.now(),
        poolEvent,
        pool,
        configEvent,
        config,
        stateEvent,
        state,
        delegation.isEmpty() ? null : delegation.getFirst(),
        health,
        reason);
  }

  CreatedEvent access(String trader, Snapshot snapshot) {
    return access(trader, snapshot.poolEvent, snapshot.offset);
  }

  CreatedEvent access(String trader, CreatedEvent poolEvent, long offset) {
    var pool = Pool.valueDecoder().decode(DamlRecord.fromProto(poolEvent.getCreateArguments()));
    String operator = pool.venueOperator;
    var candidates =
        contracts(operator, PoolAccess.TEMPLATE_ID, offset).stream()
            .filter(
                e -> {
                  var access =
                      PoolAccess.valueDecoder()
                          .decode(DamlRecord.fromProto(e.getCreateArguments()));
                  return access.trader.equals(trader)
                      && access.poolCid.contractId.equals(poolEvent.getContractId())
                      && access.venueOperator.equals(operator);
                })
            .toList();
    var attestations = contracts(operator, KycAttestation.TEMPLATE_ID, offset);
    return candidates.stream()
        .filter(
            e -> {
              var access =
                  PoolAccess.valueDecoder().decode(DamlRecord.fromProto(e.getCreateArguments()));
              return attestations.stream()
                  .anyMatch(
                      a -> {
                        if (!a.getContractId().equals(access.attestationCid.contractId))
                          return false;
                        var attestation =
                            KycAttestation.valueDecoder()
                                .decode(DamlRecord.fromProto(a.getCreateArguments()));
                        return attestation.trader.equals(trader)
                            && attestation.venueOperator.equals(operator)
                            && attestation.pools.contains(
                                new Pool.ContractId(poolEvent.getContractId()));
                      });
            })
        .findFirst()
        .orElseThrow(
            () ->
                SwapFailure.conflict(
                    "POOL_ACCESS_REQUIRED", "Current KYC and access to this pool are required"));
  }

  List<Holding.ContractId> inputs(
      String trader, InstrumentId instrument, BigDecimal amount, long offset, String accessToken) {
    var candidates =
        ledger.activeInterfaceContracts(trader, Holding.INTERFACE_ID, offset, accessToken);
    return selectInputs(candidates, trader, instrument, amount);
  }

  static List<Holding.ContractId> selectInputs(
      List<CreatedEvent> candidates, String trader, InstrumentId instrument, BigDecimal amount) {
    record Input(String id, BigDecimal amount, boolean locked) {}
    var available = new ArrayList<Input>();
    var account = new Account(Optional.of(trader), Optional.empty(), "");
    for (var event : candidates) {
      var holding =
          HoldingView.valueDecoder()
              .decode(InterfaceViews.view(event, Holding.INTERFACE_ID_WITH_PACKAGE_ID));
      if (holding.instrumentId.equals(instrument) && holding.account.equals(account))
        available.add(new Input(event.getContractId(), holding.amount, holding.lock.isPresent()));
    }
    available.sort(
        Comparator.comparing(Input::locked)
            .thenComparing(Input::amount, Comparator.reverseOrder())
            .thenComparing(Input::id));
    BigDecimal total = BigDecimal.ZERO;
    var selected = new ArrayList<Holding.ContractId>();
    for (var input : available) {
      total = total.add(input.amount());
      selected.add(new Holding.ContractId(input.id()));
      if (selected.size() > 16)
        throw SwapFailure.conflict(
            "TOO_MANY_HOLDINGS",
            "This input needs more than sixteen holdings; consolidate the wallet holdings first");
      if (total.compareTo(amount) >= 0) return List.copyOf(selected);
    }
    throw SwapFailure.conflict("INSUFFICIENT_BALANCE", "Available token balance is too small");
  }

  List<CreatedEvent> contracts(String party, Identifier template, long offset) {
    return ledger.activeContracts(party, template, offset).stream()
        .filter(e -> Pool.PACKAGE_ID.equals(e.getTemplateId().getPackageId()))
        .toList();
  }

  static boolean isAppTemplate(CreatedEvent event, Identifier template) {
    return Pool.PACKAGE_ID.equals(event.getTemplateId().getPackageId())
        && event.getTemplateId().getModuleName().equals(template.getModuleName())
        && event.getTemplateId().getEntityName().equals(template.getEntityName());
  }

  CreatedEvent pool(String poolId, long offset) {
    return single(
        contracts(ledger.primaryParty(), Pool.TEMPLATE_ID, offset).stream()
            .filter(event -> event.getContractId().equals(poolId))
            .toList(),
        "Pool");
  }

  List<DisclosedContract> poolDisclosure(
      CreatedEvent pool, List<DisclosedContract> tokenDisclosures) {
    var disclosures = new ArrayList<>(tokenDisclosures);
    disclosures.add(disclosure(pool, ledger.singleSynchronizer()));
    return mergeDisclosures(disclosures);
  }

  void requireFactories(com.openzeppelin.dex.canton.generated.lib.tokens.Token token) {
    requireFactory(
        token.allocationFactory.contractId, registries.inlineAllocation(token.instrument.admin));
    requireFactory(
        token.settlementFactory.contractId, registries.inlineSettlement(token.instrument.admin));
  }

  static CantonTokenRegistry.Operation requireFactory(
      String expected, CantonTokenRegistry.Operation operation) {
    if (!expected.equals(operation.factoryCid()))
      throw SwapFailure.conflict(
          "TOKEN_FACTORY_CHANGED",
          "Token registry factory differs from the factory approved by the pool");
    return operation;
  }

  List<DisclosedContract> settlementDisclosures(
      Snapshot pool, List<DisclosedContract> tokenDisclosures) {
    var disclosures = new ArrayList<>(tokenDisclosures);
    String synchronizer = ledger.singleSynchronizer();
    var holdings = new HashSet<String>();
    pool.state.baseHoldingCids.forEach(cid -> holdings.add(cid.contractId));
    pool.state.quoteHoldingCids.forEach(cid -> holdings.add(cid.contractId));
    for (var event :
        ledger.activeInterfaceContracts(pool.pool.dvo, Holding.INTERFACE_ID, pool.offset)) {
      if (holdings.contains(event.getContractId()))
        disclosures.add(disclosure(event, synchronizer));
    }
    return mergeDisclosures(disclosures);
  }

  static List<DisclosedContract> mergeDisclosures(List<DisclosedContract> disclosures) {
    var unique = new LinkedHashMap<String, DisclosedContract>();
    for (var disclosure : disclosures) {
      var existing = unique.putIfAbsent(disclosure.getContractId(), disclosure);
      if (existing != null && !existing.equals(disclosure))
        throw new IllegalStateException("Conflicting disclosures for the same contract");
    }
    return List.copyOf(unique.values());
  }

  private static DisclosedContract disclosure(CreatedEvent event, String synchronizer) {
    return DisclosedContract.newBuilder()
        .setTemplateId(event.getTemplateId())
        .setContractId(event.getContractId())
        .setCreatedEventBlob(event.getCreatedEventBlob())
        .setSynchronizerId(synchronizer)
        .build();
  }

  private static boolean backed(
      List<CreatedEvent> events,
      List<Holding.ContractId> ids,
      Account account,
      InstrumentId instrument,
      BigDecimal reserve) {
    var expected = ids.stream().map(id -> id.contractId).toList();
    if (new HashSet<>(expected).size() != expected.size()) return false;
    BigDecimal total = BigDecimal.ZERO;
    int count = 0;
    for (var event : events) {
      if (!expected.contains(event.getContractId())) continue;
      var holding =
          HoldingView.valueDecoder()
              .decode(InterfaceViews.view(event, Holding.INTERFACE_ID_WITH_PACKAGE_ID));
      if (!holding.account.equals(account) || !holding.instrumentId.equals(instrument))
        return false;
      total = total.add(holding.amount);
      count++;
    }
    return count == expected.size() && total.compareTo(reserve) == 0;
  }

  private static CreatedEvent single(List<CreatedEvent> events, String name) {
    if (events.size() != 1)
      throw SwapFailure.conflict("POOL_UNAVAILABLE", name + " is missing or ambiguous");
    return events.getFirst();
  }
}
