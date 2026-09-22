package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.EventOuterClass.*;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.Identifier;
import com.daml.ledger.javaapi.data.Template;
import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolfactory.*;
import com.openzeppelin.dex.pools.PoolModels.*;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;

class PoolApprovalTest {
  private static final Proposal PROPOSAL =
      new Proposal(
          UUID.randomUUID(),
          "BASE / QUOTE",
          new Terms(
              "dvo",
              new Instrument("base-admin", "BASE"),
              new Instrument("quote-admin", "QUOTE"),
              new ReserveAccount("dvo", null, "base"),
              new ReserveAccount("dvo", null, "quote"),
              new Instrument("dvo", "LP"),
              "30",
              "997",
              "1000",
              "1000"),
          Status.PENDING,
          Instant.EPOCH,
          Instant.EPOCH,
          "operator-user",
          "proposal",
          "factory",
          null,
          null,
          null);

  @Test
  void confirmsThePoolAlongsideItsCreatedAndConsumedApproval() {
    var result = CantonPoolLedger.accepted(transaction(events()), PROPOSAL, "operator");
    assertThat(result.poolId()).isEqualTo("pool");
    assertThat(result.configId()).isEqualTo("config");
    assertThat(result.stateId()).isEqualTo("state");
    assertThat(CantonPoolLedger.same(result.settings(), PROPOSAL.settings())).isTrue();
  }

  @Test
  void rejectsMissingApprovalAndUnconsumedOrUnrelatedApproval() {
    var original = events();
    for (int missing : List.of(0, 4, 5)) {
      var events = new ArrayList<>(original);
      events.remove(missing);
      assertRejected(events);
    }
    var consumption = original.get(5).getExercised();
    for (var invalid :
        List.of(
            consumption.toBuilder().setConsuming(false).build(),
            consumption.toBuilder().setContractId("other-approval").build(),
            consumption.toBuilder().clearActingParties().addActingParties("operator").build())) {
      var events = new ArrayList<>(original);
      events.set(5, Event.newBuilder().setExercised(invalid).build());
      assertRejected(events);
    }
    var events = new ArrayList<>(original);
    events.set(
        4,
        Event.newBuilder()
            .setExercised(
                original.get(4).getExercised().toBuilder()
                    .setChoiceArgument(
                        new PoolFactory_CreatePool(new PoolProposal.ContractId("other-approval"))
                            .toValue()
                            .toProto()))
            .build());
    assertRejected(events);
  }

  @Test
  void rejectsApprovalWithDifferentFactoryOrSettingsOrMissingConsent() {
    var original = events();
    var settings = PoolEncoding.daml(PROPOSAL.settings());
    for (var approval :
        List.of(
            new PoolProposal(
                new PoolFactory.ContractId("other-factory"), "operator", settings, true),
            new PoolProposal(
                new PoolFactory.ContractId("factory"), "other-operator", settings, true),
            new PoolProposal(new PoolFactory.ContractId("factory"), "operator", settings, false))) {
      var events = new ArrayList<>(original);
      events.set(
          0,
          created(
              "approval",
              PoolProposal.TEMPLATE_ID_WITH_PACKAGE_ID,
              approval,
              List.of("operator", "dvo"),
              List.of()));
      assertRejected(events);
    }
    var approval = original.getFirst().getCreated();
    for (var signatories : List.of(List.of("dvo"), List.of("operator"))) {
      var events = new ArrayList<>(original);
      events.set(
          0,
          Event.newBuilder()
              .setCreated(approval.toBuilder().clearSignatories().addAllSignatories(signatories))
              .build());
      assertRejected(events);
    }
    var events = new ArrayList<>(original);
    var different =
        new PoolSettings(
            settings.dvo,
            settings.baseInstrumentId,
            settings.quoteInstrumentId,
            settings.baseAccount,
            settings.quoteAccount,
            settings.lpTokenInstrumentId,
            new java.math.BigDecimal("100"),
            settings.baseReserve,
            settings.quoteReserve,
            settings.lpTokenSupply);
    events.set(
        0,
        created(
            "approval",
            PoolProposal.TEMPLATE_ID_WITH_PACKAGE_ID,
            new PoolProposal(new PoolFactory.ContractId("factory"), "operator", different, true),
            List.of("operator", "dvo"),
            List.of()));
    assertRejected(events);
  }

  private static void assertRejected(List<Event> events) {
    assertThatThrownBy(() -> CantonPoolLedger.accepted(transaction(events), PROPOSAL, "operator"))
        .isInstanceOf(IllegalStateException.class);
  }

  private static List<Event> events() {
    var s = PoolEncoding.daml(PROPOSAL.settings());
    return List.of(
        created(
            "approval",
            PoolProposal.TEMPLATE_ID_WITH_PACKAGE_ID,
            new PoolProposal(new PoolFactory.ContractId("factory"), "operator", s, true),
            List.of("operator", "dvo"),
            List.of()),
        created(
            "pool",
            Pool.TEMPLATE_ID_WITH_PACKAGE_ID,
            new Pool(
                "dvo",
                "operator",
                s.baseInstrumentId,
                s.quoteInstrumentId,
                s.baseAccount,
                s.quoteAccount,
                s.lpTokenInstrumentId),
            List.of("dvo"),
            List.of("operator")),
        created(
            "config",
            PoolConfig.TEMPLATE_ID_WITH_PACKAGE_ID,
            new PoolConfig(new Pool.ContractId("pool"), "dvo", "operator", s.feeBps),
            List.of("dvo"),
            List.of("operator")),
        created(
            "state",
            PoolState.TEMPLATE_ID_WITH_PACKAGE_ID,
            new PoolState(
                new Pool.ContractId("pool"),
                "dvo",
                "operator",
                s.baseReserve,
                s.quoteReserve,
                s.lpTokenSupply,
                Optional.empty()),
            List.of("dvo"),
            List.of("operator")),
        Event.newBuilder()
            .setExercised(
                ExercisedEvent.newBuilder()
                    .setContractId("factory")
                    .setTemplateId(PoolFactory.TEMPLATE_ID_WITH_PACKAGE_ID.toProto())
                    .setChoice("PoolFactory_CreatePool")
                    .setConsuming(false)
                    .addActingParties("dvo")
                    .setChoiceArgument(
                        new PoolFactory_CreatePool(new PoolProposal.ContractId("approval"))
                            .toValue()
                            .toProto()))
            .build(),
        Event.newBuilder()
            .setExercised(
                ExercisedEvent.newBuilder()
                    .setContractId("approval")
                    .setTemplateId(PoolProposal.TEMPLATE_ID_WITH_PACKAGE_ID.toProto())
                    .setChoice("PoolProposal_Consume")
                    .setConsuming(true)
                    .addActingParties("dvo"))
            .build());
  }

  private static Event created(
      String id,
      Identifier template,
      Template value,
      List<String> signatories,
      List<String> observers) {
    return Event.newBuilder()
        .setCreated(
            CreatedEvent.newBuilder()
                .setContractId(id)
                .setTemplateId(template.toProto())
                .setCreateArguments(value.toValue().toProtoRecord())
                .addAllSignatories(signatories)
                .addAllObservers(observers))
        .build();
  }

  private static Transaction transaction(List<Event> events) {
    return Transaction.newBuilder().setUpdateId("accepted").addAllEvents(events).build();
  }
}
