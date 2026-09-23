package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.EventOuterClass.Event;
import com.daml.ledger.api.v2.EventOuterClass.ExercisedEvent;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.Identifier;
import com.daml.ledger.javaapi.data.Unit;
import com.openzeppelin.dex.canton.generated.pool.PoolState;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.Allocation;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.AllocationResult;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.allocationresult_output.AllocationResult_Withdrawn;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.Metadata;
import com.openzeppelin.dex.operations.OperatorCommandStore;
import com.openzeppelin.dex.pools.PoolModels.Instrument;
import com.openzeppelin.dex.settlements.SettlementModels.*;
import com.openzeppelin.dex.swaps.SwapFailure;
import com.openzeppelin.dex.swaps.SwapModels;
import com.openzeppelin.dex.swaps.SwapModels.Swap;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class CantonSettlementRecoveryTest {
  private static final Instant NOW = Instant.parse("2026-09-19T00:00:00Z");

  @Test
  void constructionFailureIsDurableAndCannotBeRebuiltAfterRestart() {
    var store = new CommandsStore();
    UUID id = UUID.randomUUID();
    assertThatThrownBy(
            () ->
                new CantonOperatorCommands(null, store)
                    .submit(
                        id,
                        "batch",
                        () -> {
                          throw SwapFailure.conflict("ACCESS_REQUIRED", "Pool access was revoked");
                        }))
        .isInstanceOf(CantonOperatorCommands.PreparationFailed.class);
    assertThat(store.find(id, "batch").orElseThrow().payload()).isNull();
    assertThatThrownBy(
            () ->
                new CantonOperatorCommands(null, store)
                    .submit(
                        id,
                        "batch",
                        () -> {
                          throw new AssertionError("A failed durable command cannot be rebuilt");
                        }))
        .isInstanceOf(CantonOperatorCommands.PreparationFailed.class);

    var pending = pending();
    var commands = new CantonOperatorCommands(null, store);
    var settlement = new CantonSettlementLedger(null, null, commands, null, null);
    assertThatThrownBy(() -> settlement.submit(pending))
        .isInstanceOfSatisfying(
            com.openzeppelin.dex.settlements.SettlementLedger.Excluded.class,
            excluded -> assertThat(excluded.code()).isEqualTo("COMMAND_NOT_PREPARED"));
  }

  @Test
  void persistenceFailureDoesNotProveThatACommandCannotBeSubmitted() {
    var store = new CommandsStore();
    store.saveFailure = new IllegalStateException("database unavailable");
    assertThatThrownBy(
            () ->
                new CantonOperatorCommands(null, store)
                    .submit(
                        UUID.randomUUID(),
                        "batch",
                        () -> {
                          throw SwapFailure.conflict("ACCESS_REQUIRED", "Pool access was revoked");
                        }))
        .isSameAs(store.saveFailure);
    assertThat(store.prepared).isEmpty();
  }

  @Test
  void consumptionOfTheFrozenStateExcludesTheBatch() {
    assertThat(
            CantonSettlementLedger.inputsConsumed(
                List.of(transaction(stateConsumption())), pending()))
        .isTrue();
  }

  @Test
  void unrelatedStateOrNonconsumingAndWrongTemplateEventsDoNotExcludeTheBatch() {
    var state = stateConsumption();
    var template = state.getTemplateId();
    var invalid =
        List.of(
            state.toBuilder().setContractId("another-state").build(),
            state.toBuilder().setConsuming(false).build(),
            state.toBuilder()
                .setTemplateId(template.toBuilder().setPackageId("other-package"))
                .build(),
            state.toBuilder()
                .setTemplateId(template.toBuilder().setModuleName("OtherPool"))
                .build(),
            state.toBuilder()
                .setTemplateId(template.toBuilder().setEntityName("PoolConfig"))
                .build());
    for (var exercise : invalid) {
      assertThat(CantonSettlementLedger.inputsConsumed(List.of(transaction(exercise)), pending()))
          .as("Invalid state exclusion evidence: %s", exercise)
          .isFalse();
    }
  }

  @Test
  void withdrawalOfEvenOneRequiredAllocationExcludesTheEntireAtomicBatch() {
    for (String allocation :
        List.of("first-input", "first-output", "second-input", "second-output")) {
      String trader = allocation.startsWith("first") ? "first-trader" : "second-trader";
      assertThat(
              CantonSettlementLedger.inputsConsumed(
                  List.of(transaction(withdrawal(allocation, trader))), pending()))
          .as("Consumption of required allocation %s", allocation)
          .isTrue();
    }
  }

  @Test
  void allocationEvidenceMustMatchItsOwnTraderInterfaceChoiceAndResult() {
    var allocation = withdrawal("first-input", "first-trader");
    var template = allocation.getInterfaceId();
    var invalid =
        List.of(
            allocation.toBuilder().setContractId("unrelated-input").build(),
            allocation.toBuilder().setConsuming(true).build(),
            allocation.toBuilder().setChoice("Allocation_Cancel").build(),
            allocation.toBuilder().clearActingParties().build(),
            allocation.toBuilder().clearActingParties().addActingParties("other-trader").build(),
            allocation.toBuilder().clearActingParties().addActingParties("second-trader").build(),
            allocation.toBuilder()
                .setInterfaceId(template.toBuilder().setPackageId("other-package"))
                .build(),
            allocation.toBuilder()
                .setInterfaceId(template.toBuilder().setModuleName("OtherAllocation"))
                .build(),
            allocation.toBuilder()
                .setInterfaceId(template.toBuilder().setEntityName("OtherAllocation"))
                .build());
    for (var exercise : invalid) {
      assertThat(CantonSettlementLedger.inputsConsumed(List.of(transaction(exercise)), pending()))
          .as("Invalid allocation exclusion evidence: %s", exercise)
          .isFalse();
    }
  }

  @Test
  void emptyHistoryAndEventsWithoutAnExerciseAreNotExclusionEvidence() {
    assertThat(CantonSettlementLedger.inputsConsumed(List.of(), pending())).isFalse();
    var transaction =
        Transaction.newBuilder().setOffset(43).addEvents(Event.getDefaultInstance()).build();
    assertThat(CantonSettlementLedger.inputsConsumed(List.of(transaction), pending())).isFalse();
  }

  private static final class CommandsStore extends OperatorCommandStore {
    final Map<UUID, Prepared> prepared = new HashMap<>();
    RuntimeException saveFailure;

    CommandsStore() {
      super(null);
    }

    @Override
    public Optional<Prepared> find(UUID id, String kind) {
      return Optional.ofNullable(prepared.get(id));
    }

    @Override
    public Prepared storeOnce(UUID id, String kind, Prepared command) {
      if (saveFailure != null) throw saveFailure;
      return prepared.computeIfAbsent(id, ignored -> command);
    }
  }

  private static ExercisedEvent stateConsumption() {
    return ExercisedEvent.newBuilder()
        .setContractId("frozen-state")
        .setTemplateId(PoolState.TEMPLATE_ID_WITH_PACKAGE_ID.toProto())
        .setChoice("Archive")
        .setConsuming(true)
        .addActingParties("dvo")
        .build();
  }

  private static ExercisedEvent withdrawal(String allocation, String trader) {
    return ExercisedEvent.newBuilder()
        .setContractId(allocation)
        .setTemplateId(new Identifier("issuer-package", "Issuer", "Allocation").toProto())
        .setInterfaceId(Allocation.INTERFACE_ID_WITH_PACKAGE_ID.toProto())
        .setExerciseResult(
            new AllocationResult(
                    new AllocationResult_Withdrawn(Unit.getInstance()),
                    Map.of(),
                    new Metadata(Map.of()))
                .toValue()
                .toProto())
        .setChoice("Allocation_Withdraw")
        .setConsuming(false)
        .addActingParties(trader)
        .build();
  }

  private static Transaction transaction(ExercisedEvent exercise) {
    return Transaction.newBuilder()
        .setOffset(43)
        .setCommandId("another-command")
        .addEvents(Event.newBuilder().setExercised(exercise))
        .build();
  }

  private static Pending pending() {
    UUID id = UUID.randomUUID();
    List<Swap> swaps = List.of(swap("first", 1), swap("second", 2));
    var settlement =
        new Settlement(
            id,
            "pool",
            Trigger.MANUAL,
            Status.UNRESOLVED,
            swaps.stream().map(swap -> new RequestRef("swap", swap.swapId())).toList(),
            List.of(),
            new Reserves("frozen-state", "100", "200", "2", "20000"),
            null,
            0,
            NOW,
            NOW,
            null,
            null,
            null,
            null);
    return new Pending(
        settlement,
        swaps.stream().map(swap -> (QueueRequest) new SwapRequest(swap)).toList(),
        id,
        42,
        "frozen-state:config");
  }

  private static Swap swap(String name, long sequence) {
    return new Swap(
        UUID.randomUUID(),
        UUID.randomUUID(),
        "pool",
        "Pool",
        name + "-trader",
        SwapModels.Direction.BaseToQuote,
        new Instrument("issuer", "BTC"),
        new Instrument("issuer", "USDC"),
        "1",
        "10",
        "0.01",
        "9",
        NOW,
        SwapModels.Status.SETTLING,
        sequence,
        NOW,
        NOW,
        NOW,
        null,
        null,
        List.of(name + "-input", name + "-output"),
        "submission",
        null,
        null,
        true);
  }
}
