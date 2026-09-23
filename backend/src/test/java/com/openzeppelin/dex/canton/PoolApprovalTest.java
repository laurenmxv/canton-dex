package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.EventOuterClass.*;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.Identifier;
import com.daml.ledger.javaapi.data.Template;
import com.openzeppelin.dex.canton.generated.lib.tokens.Token;
import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.poolfactory.*;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationinstructionv2.AllocationFactory;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.SettlementFactory;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.InstrumentId;
import com.openzeppelin.dex.pools.PoolModels.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;

class PoolApprovalTest {
  private static final Proposal PROPOSAL =
      new Proposal(
          UUID.randomUUID(),
          "BASE / QUOTE",
          new ProposalTerms(
              "dvo",
              new Instrument("base-admin", "BASE"),
              new Instrument("quote-admin", "QUOTE"),
              "30"),
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
    assertThat(CantonPoolLedger.same(result.settings().proposal(), PROPOSAL.settings())).isTrue();
  }

  @Test
  void rejectsMissingApprovalAndUnconsumedOrUnrelatedApproval() {
    var original = events();
    for (int missing : List.of(0, 4, 5)) {
      var events = new ArrayList<>(original);
      events.remove(missing);
      assertRejected(events);
    }
    for (int exercise : List.of(4, 5)) {
      for (String actor : List.of("dvo", "operator")) {
        var events = new ArrayList<>(original);
        events.set(
            exercise,
            Event.newBuilder()
                .setExercised(
                    original.get(exercise).getExercised().toBuilder()
                        .clearActingParties()
                        .addActingParties(actor))
                .build());
        assertRejected(events);
      }
    }
    var consumption = original.get(5).getExercised();
    for (var invalid :
        List.of(
            consumption.toBuilder().setConsuming(false).build(),
            consumption.toBuilder().setContractId("other-approval").build())) {
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
    var settings = settings();
    for (var approval :
        List.of(
            new PoolProposal(
                new PoolFactory.ContractId("other-factory"),
                "operator",
                settings,
                true,
                Optional.of(BigDecimal.ONE)),
            new PoolProposal(
                new PoolFactory.ContractId("factory"),
                "other-operator",
                settings,
                true,
                Optional.of(BigDecimal.ONE)),
            new PoolProposal(
                new PoolFactory.ContractId("factory"),
                "operator",
                settings,
                false,
                Optional.empty()))) {
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
            settings.poolId,
            settings.baseToken,
            settings.quoteToken,
            settings.lpAllocationFactory,
            settings.lpSettlementFactory,
            new BigDecimal("100"));
    events.set(
        0,
        created(
            "approval",
            PoolProposal.TEMPLATE_ID_WITH_PACKAGE_ID,
            new PoolProposal(
                new PoolFactory.ContractId("factory"),
                "operator",
                different,
                true,
                Optional.of(BigDecimal.ONE)),
            List.of("operator", "dvo"),
            List.of()));
    assertRejected(events);
  }

  private static void assertRejected(List<Event> events) {
    assertThatThrownBy(() -> CantonPoolLedger.accepted(transaction(events), PROPOSAL, "operator"))
        .isInstanceOf(IllegalStateException.class);
  }

  private static List<Event> events() {
    var s = settings();
    return List.of(
        created(
            "approval",
            PoolProposal.TEMPLATE_ID_WITH_PACKAGE_ID,
            new PoolProposal(
                new PoolFactory.ContractId("factory"),
                "operator",
                s,
                true,
                Optional.of(BigDecimal.ONE)),
            List.of("operator", "dvo"),
            List.of()),
        created(
            "pool",
            Pool.TEMPLATE_ID_WITH_PACKAGE_ID,
            new Pool(
                "dvo",
                "operator",
                s.baseToken,
                s.quoteToken,
                token("dvo", "lp:" + s.poolId),
                new Account(Optional.of("dvo"), Optional.of("operator"), "base:" + s.poolId),
                new Account(Optional.of("dvo"), Optional.of("operator"), "quote:" + s.poolId)),
            List.of("dvo"),
            List.of("operator")),
        created(
            "config",
            PoolConfig.TEMPLATE_ID_WITH_PACKAGE_ID,
            new PoolConfig(
                new Pool.ContractId("pool"), "dvo", "operator", s.feeBps, BigDecimal.ONE),
            List.of("dvo"),
            List.of("operator")),
        created(
            "state",
            PoolState.TEMPLATE_ID_WITH_PACKAGE_ID,
            new PoolState(
                new Pool.ContractId("pool"),
                "dvo",
                "operator",
                BigDecimal.ZERO,
                BigDecimal.ZERO,
                BigDecimal.ZERO,
                List.of(),
                List.of()),
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
                    .addActingParties("operator")
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
                    .setChoice("Archive")
                    .setConsuming(true)
                    .addActingParties("dvo")
                    .addActingParties("operator"))
            .build());
  }

  private static PoolSettings settings() {
    return new PoolSettings(
        "dvo",
        PROPOSAL.proposalId().toString(),
        token("base-admin", "BASE"),
        token("quote-admin", "QUOTE"),
        new AllocationFactory.ContractId("lp-rules"),
        new SettlementFactory.ContractId("lp-rules"),
        new BigDecimal("30"));
  }

  private static Token token(String issuer, String id) {
    return new Token(
        new InstrumentId(issuer, id),
        new AllocationFactory.ContractId(issuer + "-rules"),
        new SettlementFactory.ContractId(issuer + "-rules"),
        10L);
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
