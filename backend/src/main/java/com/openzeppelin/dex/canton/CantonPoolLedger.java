package com.openzeppelin.dex.canton;

import static com.openzeppelin.dex.pools.PoolModels.*;

import com.daml.ledger.api.v2.EventOuterClass.*;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.DamlRecord;
import com.daml.ledger.javaapi.data.Value;
import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolfactory.*;
import com.openzeppelin.dex.canton.generated.venuedelegation.VenueDelegation;
import com.openzeppelin.dex.pools.PoolLedger;
import com.openzeppelin.dex.pools.PoolUnavailable;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Component;

@Component
public final class CantonPoolLedger implements PoolLedger {
  private final LedgerConnection ledger;
  private final com.openzeppelin.dex.tokens.TokenRegistryStore registries;
  private final CantonTokenRegistry tokenRegistry;

  public CantonPoolLedger(
      LedgerConnection ledger,
      com.openzeppelin.dex.tokens.TokenRegistryStore registries,
      CantonTokenRegistry tokenRegistry) {
    this.ledger = ledger;
    this.registries = registries;
    this.tokenRegistry = tokenRegistry;
  }

  public String operator() {
    return ledger.primaryParty();
  }

  public long offset() {
    return ledger.ledgerEnd();
  }

  public String factory(String dvo) {
    return ledger.activeContracts(operator(), PoolFactory.TEMPLATE_ID).stream()
        .filter(e -> supported(e.getTemplateId(), PoolFactory.TEMPLATE_ID))
        .filter(
            e -> {
              var f =
                  PoolFactory.valueDecoder().decode(DamlRecord.fromProto(e.getCreateArguments()));
              return f.dvo.equals(dvo) && f.venueOperator.equals(operator());
            })
        .map(CreatedEvent::getContractId)
        .sorted()
        .findFirst()
        .orElseThrow(() -> new PoolUnavailable("No compatible pool factory is available"));
  }

  public static String decide(
      LedgerConnection ledger,
      String proposalCid,
      String factoryId,
      ProposalTerms expected,
      UUID id,
      boolean accept,
      java.math.BigDecimal initialRatio,
      CantonTokenRegistry registry) {
    String party = ledger.primaryParty();
    if (!expected.dvo().equals(party))
      throw new IllegalStateException("Pool authority differs from the approver");
    var active =
        ledger.activeContracts(party, PoolProposal.TEMPLATE_ID).stream()
            .filter(e -> e.getContractId().equals(proposalCid))
            .findFirst();
    Transaction transaction;
    if (active.isPresent()) {
      var event = active.get();
      if (!supported(event.getTemplateId(), PoolProposal.TEMPLATE_ID))
        throw new IllegalStateException("Proposal package mismatch");
      var proposal =
          PoolProposal.valueDecoder().decode(DamlRecord.fromProto(event.getCreateArguments()));
      if (proposal.accepted
          || !proposal.settings.poolId.equals(id.toString())
          || !proposal.settings.dvo.equals(party)
          || !proposal.factoryCid.contractId.equals(factoryId)
          || !same(PoolEncoding.from(proposal.settings), expected))
        throw new IllegalStateException("Stored and ledger proposal differ");
      var cid = new PoolProposal.ContractId(proposalCid);
      transaction =
          ledger.submit(
              "pool-" + (accept ? "accept" : "reject") + "-" + id,
              party,
              List.of(),
              accept
                  ? cid.exercisePoolProposal_Accept(initialRatio)
                  : cid.exercisePoolProposal_Reject(),
              accept ? proposalDisclosures(expected, registry) : List.of());
    } else {
      if (!accept)
        throw new IllegalStateException("Proposal is no longer active; wait for reconciliation");
      transaction =
          ledger.transactions(0, party).stream()
              .filter(
                  tx ->
                      tx.getEventsList().stream()
                          .filter(Event::hasExercised)
                          .map(Event::getExercised)
                          .anyMatch(
                              e ->
                                  e.getContractId().equals(proposalCid)
                                      && supported(e.getTemplateId(), PoolProposal.TEMPLATE_ID)
                                      && e.getChoice().equals("PoolProposal_Accept")
                                      && e.getConsuming()
                                      && e.getActingPartiesList().equals(List.of(party))))
              .findFirst()
              .orElseThrow(() -> new IllegalStateException("Proposal acceptance is not confirmed"));
    }
    if (accept) {
      var factoryEvent =
          ledger.activeContracts(party, PoolFactory.TEMPLATE_ID).stream()
              .filter(
                  e ->
                      e.getContractId().equals(factoryId)
                          && supported(e.getTemplateId(), PoolFactory.TEMPLATE_ID))
              .findFirst()
              .orElseThrow(() -> new IllegalStateException("Pool factory is unavailable"));
      var factory =
          PoolFactory.valueDecoder()
              .decode(DamlRecord.fromProto(factoryEvent.getCreateArguments()));
      if (!factory.dvo.equals(party))
        throw new IllegalStateException("Pool factory authority differs");
      var pool = accepted(transaction, id, expected, factoryId, "Pool", factory.venueOperator);
      ensureDelegation(ledger, pool.poolId(), party, factory.venueOperator, id);
    }
    return transaction.getUpdateId();
  }

  private static void ensureDelegation(
      LedgerConnection ledger, String poolId, String dvo, String operator, UUID proposalId) {
    var poolEvent =
        ledger.activeContracts(dvo, Pool.TEMPLATE_ID).stream()
            .filter(
                e ->
                    e.getContractId().equals(poolId)
                        && supported(e.getTemplateId(), Pool.TEMPLATE_ID))
            .findFirst()
            .orElseThrow(() -> new IllegalStateException("Approved pool is not active"));
    var pool = Pool.valueDecoder().decode(DamlRecord.fromProto(poolEvent.getCreateArguments()));
    if (!pool.dvo.equals(dvo) || !pool.venueOperator.equals(operator))
      throw new IllegalStateException("Pool authority differs from its approval");
    var delegations =
        ledger.activeContracts(dvo, VenueDelegation.TEMPLATE_ID).stream()
            .filter(e -> supported(e.getTemplateId(), VenueDelegation.TEMPLATE_ID))
            .map(
                e ->
                    VenueDelegation.valueDecoder()
                        .decode(DamlRecord.fromProto(e.getCreateArguments())))
            .filter(delegation -> delegation.poolCid.contractId.equals(poolId))
            .toList();
    if (delegations.size() > 1
        || delegations.stream()
            .anyMatch(
                delegation ->
                    !delegation.dvo.equals(dvo) || !delegation.venueOperator.equals(operator)))
      throw new IllegalStateException("Approved pool has conflicting settlement delegations");
    if (delegations.isEmpty())
      ledger.submit(
          "pool-delegation-" + proposalId,
          dvo,
          List.of(),
          new VenueDelegation(dvo, operator, new Pool.ContractId(poolId)).create());
  }

  public String packageId() {
    return Pool.PACKAGE_ID;
  }

  public Confirmation propose(Proposal p, UUID command) {
    var tx =
        submit(
            () ->
                ledger.submit(
                    command.toString(),
                    operator(),
                    List.of(),
                    new PoolFactory.ContractId(p.factoryId())
                        .exercisePoolFactory_ProposePool(
                            PoolEncoding.daml(p.settings(), p.proposalId(), registries)),
                    proposalDisclosures(p.settings(), tokenRegistry)));
    String cid =
        proposed(tx, new Pending(p, command, 0))
            .orElseThrow(() -> new IllegalStateException("Proposal not confirmed"));
    return new Confirmation(cid, Status.PENDING, tx.getUpdateId(), null);
  }

  public Confirmation withdraw(Proposal p, UUID command) {
    var tx =
        submit(
            () ->
                ledger.submit(
                    command.toString(),
                    operator(),
                    List.of(),
                    new PoolProposal.ContractId(p.proposalCid()).exercisePoolProposal_Withdraw()));
    return confirmation(tx, p)
        .orElseThrow(() -> new IllegalStateException("Withdrawal not confirmed"));
  }

  static Transaction submit(java.util.function.Supplier<Transaction> command) {
    try {
      return command.get();
    } catch (io.grpc.StatusRuntimeException e) {
      if (definitivelyRejected(e)) throw new PoolLedger.Rejected(e);
      throw e;
    }
  }

  static boolean definitivelyRejected(io.grpc.StatusRuntimeException e) {
    // Fresh command IDs: submission rejection is distinct from a missing result after commit.
    if (Set.of(
            io.grpc.Status.Code.UNAUTHENTICATED,
            io.grpc.Status.Code.PERMISSION_DENIED,
            io.grpc.Status.Code.INVALID_ARGUMENT)
        .contains(e.getStatus().getCode())) return true;
    if (e.getStatus().getCode() == io.grpc.Status.Code.ALREADY_EXISTS) return false;
    var status = io.grpc.protobuf.StatusProto.fromThrowable(e);
    if (status != null)
      for (var detail : status.getDetailsList()) {
        if (detail.is(com.google.rpc.ErrorInfo.class))
          try {
            var info = detail.unpack(com.google.rpc.ErrorInfo.class);
            if ("true".equals(info.getMetadataMap().get("definite_answer"))
                || "CONTRACT_NOT_FOUND".equals(info.getReason())) return true;
          } catch (com.google.protobuf.InvalidProtocolBufferException ignored) {
            return false;
          }
      }
    return false;
  }

  public List<Confirmation> recover(Pending pending) {
    var result = new ArrayList<Confirmation>();
    var p = pending.proposal();
    for (var tx : ledger.transactions(pending.beginOffset(), operator())) {
      if (p.proposalCid() == null) {
        var cid = proposed(tx, pending);
        if (cid.isPresent()) {
          result.add(new Confirmation(cid.get(), Status.PENDING, tx.getUpdateId(), null));
          p =
              new Proposal(
                  p.proposalId(),
                  p.name(),
                  p.settings(),
                  Status.PENDING,
                  p.createdAt(),
                  p.updatedAt(),
                  p.proposedBy(),
                  cid.get(),
                  p.factoryId(),
                  null,
                  tx.getUpdateId(),
                  null);
        }
      } else {
        var confirmed = confirmation(tx, p);
        if (confirmed.isPresent()) {
          result.add(confirmed.get());
          break;
        }
      }
    }
    return result;
  }

  private Optional<Confirmation> confirmation(Transaction tx, Proposal p) {
    var decision = decision(tx, p);
    if (decision.isEmpty()) return Optional.empty();
    var event = decision.get();
    String actor =
        event.getChoice().equals("PoolProposal_Withdraw") ? operator() : p.settings().dvo();
    if (!event.getActingPartiesList().equals(List.of(actor)))
      throw new IllegalStateException("Unexpected pool decision actor");
    var confirmed =
        switch (event.getChoice()) {
          case "PoolProposal_Accept" ->
              new Confirmation(p.proposalCid(), Status.CREATED, tx.getUpdateId(), accepted(tx, p));
          case "PoolProposal_Reject" ->
              new Confirmation(p.proposalCid(), Status.REJECTED, tx.getUpdateId(), null);
          case "PoolProposal_Withdraw" ->
              new Confirmation(p.proposalCid(), Status.WITHDRAWN, tx.getUpdateId(), null);
          default -> throw new IllegalStateException("Unexpected pool decision");
        };
    return Optional.of(confirmed);
  }

  public Optional<String> proposed(Transaction tx, Pending pending) {
    if (!tx.getCommandId().equals(pending.commandId().toString())) return Optional.empty();
    var events =
        tx.getEventsList().stream()
            .filter(Event::hasCreated)
            .map(Event::getCreated)
            .filter(e -> supported(e.getTemplateId(), PoolProposal.TEMPLATE_ID))
            .toList();
    if (events.size() != 1) return Optional.empty();
    var e = events.getFirst();
    if (!supported(e.getTemplateId(), PoolProposal.TEMPLATE_ID)) return Optional.empty();
    var p = PoolProposal.valueDecoder().decode(DamlRecord.fromProto(e.getCreateArguments()));
    var expected = pending.proposal();
    if (p.accepted
        || !p.settings.poolId.equals(expected.proposalId().toString())
        || !p.factoryCid.contractId.equals(expected.factoryId())
        || !p.venueOperator.equals(operator())
        || !same(PoolEncoding.from(p.settings), expected.settings())
        || !e.getSignatoriesList().equals(List.of(operator()))
        || !e.getObserversList().contains(p.settings.dvo))
      throw new IllegalStateException("Proposal confirmation differs from submitted settings");
    return Optional.of(e.getContractId());
  }

  public Optional<ExercisedEvent> decision(Transaction tx, Proposal p) {
    return tx.getEventsList().stream()
        .filter(Event::hasExercised)
        .map(Event::getExercised)
        .filter(
            e ->
                e.getContractId().equals(p.proposalCid())
                    && supported(e.getTemplateId(), PoolProposal.TEMPLATE_ID)
                    && e.getConsuming())
        .filter(
            e ->
                Set.of("PoolProposal_Accept", "PoolProposal_Reject", "PoolProposal_Withdraw")
                    .contains(e.getChoice()))
        .findFirst();
  }

  public Detail accepted(Transaction tx, Proposal p) {
    var result = accepted(tx, p, operator());
    var lp = result.settings().lpTokenInstrumentId();
    registries.registerInstrument(lp.admin(), lp.id(), "LP " + result.name(), 10);
    return result;
  }

  static Detail accepted(Transaction tx, Proposal p, String operator) {
    return accepted(tx, p.proposalId(), p.settings(), p.factoryId(), p.name(), operator);
  }

  private static Detail accepted(
      Transaction tx,
      UUID proposalId,
      ProposalTerms settings,
      String factoryId,
      String name,
      String operator) {
    var events =
        tx.getEventsList().stream().filter(Event::hasCreated).map(Event::getCreated).toList();
    var approvalEvent = exact(events, PoolProposal.TEMPLATE_ID_WITH_PACKAGE_ID);
    var approval =
        PoolProposal.valueDecoder()
            .decode(DamlRecord.fromProto(approvalEvent.getCreateArguments()));
    if (!approval.accepted
        || !approval.settings.poolId.equals(proposalId.toString())
        || !approval.factoryCid.contractId.equals(factoryId)
        || !approval.venueOperator.equals(operator)
        || !same(PoolEncoding.from(approval.settings), settings)
        || !Set.copyOf(approvalEvent.getSignatoriesList()).equals(Set.of(operator, settings.dvo())))
      throw new IllegalStateException("Approved pool proposal differs from submitted settings");
    var pool = exact(events, Pool.TEMPLATE_ID_WITH_PACKAGE_ID);
    var config = exact(events, PoolConfig.TEMPLATE_ID_WITH_PACKAGE_ID);
    var state = exact(events, PoolState.TEMPLATE_ID_WITH_PACKAGE_ID);
    for (var event : List.of(pool, config, state))
      if (!event.getSignatoriesList().equals(List.of(settings.dvo()))
          || !event.getObserversList().contains(operator))
        throw new IllegalStateException("Pool authority differs");
    var result = detail(pool, config, state, name);
    if (!same(result.settings().proposal(), settings))
      throw new IllegalStateException("Created pool settings differ");
    boolean factoryCall =
        tx.getEventsList().stream()
            .filter(Event::hasExercised)
            .map(Event::getExercised)
            .anyMatch(
                e ->
                    e.getContractId().equals(factoryId)
                        && supported(e.getTemplateId(), PoolFactory.TEMPLATE_ID)
                        && e.getChoice().equals("PoolFactory_CreatePool")
                        && !e.getConsuming()
                        && Set.copyOf(e.getActingPartiesList())
                            .equals(Set.of(settings.dvo(), operator))
                        && PoolFactory_CreatePool.valueDecoder()
                            .decode(Value.fromProto(e.getChoiceArgument()))
                            .proposalCid
                            .contractId
                            .equals(approvalEvent.getContractId()));
    if (!factoryCall) throw new IllegalStateException("Matching factory call is missing");
    boolean approvalConsumed =
        tx.getEventsList().stream()
            .filter(Event::hasExercised)
            .map(Event::getExercised)
            .anyMatch(
                e ->
                    e.getContractId().equals(approvalEvent.getContractId())
                        && supported(e.getTemplateId(), PoolProposal.TEMPLATE_ID)
                        && e.getChoice().equals("Archive")
                        && e.getConsuming()
                        && Set.copyOf(e.getActingPartiesList())
                            .equals(Set.of(settings.dvo(), operator)));
    if (!approvalConsumed) throw new IllegalStateException("Pool approval was not consumed");
    return result;
  }

  public List<Detail> pools(Map<String, String> names, String dvo) {
    String op = operator();
    var configs = ledger.activeContracts(op, PoolConfig.TEMPLATE_ID);
    var states = ledger.activeContracts(op, PoolState.TEMPLATE_ID);
    var result = new ArrayList<Detail>();
    for (var e : ledger.activeContracts(op, Pool.TEMPLATE_ID)) {
      if (!supported(e.getTemplateId(), Pool.TEMPLATE_ID)) continue;
      var pool = Pool.valueDecoder().decode(DamlRecord.fromProto(e.getCreateArguments()));
      if (!pool.dvo.equals(dvo) || !pool.venueOperator.equals(op)) continue;
      var cs =
          configs.stream()
              .filter(c -> supported(c.getTemplateId(), PoolConfig.TEMPLATE_ID))
              .filter(
                  c ->
                      PoolConfig.valueDecoder()
                          .decode(DamlRecord.fromProto(c.getCreateArguments()))
                          .poolCid
                          .contractId
                          .equals(e.getContractId()))
              .toList();
      var ss =
          states.stream()
              .filter(s -> supported(s.getTemplateId(), PoolState.TEMPLATE_ID))
              .filter(
                  s ->
                      PoolState.valueDecoder()
                          .decode(DamlRecord.fromProto(s.getCreateArguments()))
                          .poolCid
                          .contractId
                          .equals(e.getContractId()))
              .toList();
      if (cs.size() != 1 || ss.size() != 1)
        throw new IllegalStateException("Pool does not have one current config and state");
      result.add(
          detail(
              e,
              cs.getFirst(),
              ss.getFirst(),
              names.getOrDefault(
                  e.getContractId(),
                  pool.baseToken.instrument.id + " / " + pool.quoteToken.instrument.id)));
    }
    for (var detail : result) {
      var lp = detail.settings().lpTokenInstrumentId();
      registries.registerInstrument(lp.admin(), lp.id(), "LP " + detail.name(), 10);
    }
    return result;
  }

  static boolean supported(
      com.daml.ledger.api.v2.ValueOuterClass.Identifier actual,
      com.daml.ledger.javaapi.data.Identifier expected) {
    return actual.getModuleName().equals(expected.getModuleName())
        && actual.getEntityName().equals(expected.getEntityName())
        && Pool.PACKAGE_ID.equals(actual.getPackageId());
  }

  private static CreatedEvent exact(
      List<CreatedEvent> events, com.daml.ledger.javaapi.data.Identifier template) {
    var found = events.stream().filter(e -> supported(e.getTemplateId(), template)).toList();
    if (found.size() != 1) throw new IllegalStateException("Unexpected pool transaction templates");
    return found.getFirst();
  }

  static Detail detail(CreatedEvent pe, CreatedEvent ce, CreatedEvent se, String name) {
    var p = Pool.valueDecoder().decode(DamlRecord.fromProto(pe.getCreateArguments()));
    var c = PoolConfig.valueDecoder().decode(DamlRecord.fromProto(ce.getCreateArguments()));
    var s = PoolState.valueDecoder().decode(DamlRecord.fromProto(se.getCreateArguments()));
    if (!c.poolCid.contractId.equals(pe.getContractId())
        || !s.poolCid.contractId.equals(pe.getContractId()))
      throw new IllegalStateException("Pool component references differ");
    return new Detail(
        pe.getContractId(),
        name,
        PoolEncoding.terms(p, c, s),
        ce.getContractId(),
        se.getContractId(),
        pe.getTemplateId().getPackageId(),
        Instant.ofEpochSecond(pe.getCreatedAt().getSeconds(), pe.getCreatedAt().getNanos()),
        Instant.now());
  }

  private static List<com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract>
      proposalDisclosures(ProposalTerms terms, CantonTokenRegistry tokenRegistry) {
    var disclosures = new ArrayList<com.daml.ledger.api.v2.CommandsOuterClass.DisclosedContract>();
    for (String issuer :
        new LinkedHashSet<>(
            List.of(
                terms.baseInstrumentId().admin(),
                terms.quoteInstrumentId().admin(),
                terms.dvo()))) {
      disclosures.addAll(tokenRegistry.inlineAllocation(issuer).disclosures());
      disclosures.addAll(tokenRegistry.inlineSettlement(issuer).disclosures());
    }
    return CantonPools.mergeDisclosures(disclosures);
  }

  public static boolean same(ProposalTerms a, ProposalTerms b) {
    return a.dvo().equals(b.dvo())
        && a.baseInstrumentId().equals(b.baseInstrumentId())
        && a.quoteInstrumentId().equals(b.quoteInstrumentId())
        && new java.math.BigDecimal(a.feeBps()).compareTo(new java.math.BigDecimal(b.feeBps()))
            == 0;
  }
}
