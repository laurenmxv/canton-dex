package com.openzeppelin.dex.canton;

import static org.assertj.core.api.Assertions.assertThat;

import com.daml.ledger.api.v2.EventOuterClass.Event;
import com.daml.ledger.api.v2.EventOuterClass.ExercisedEvent;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.Identifier;
import com.daml.ledger.javaapi.data.Unit;
import com.google.protobuf.Timestamp;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.Allocation;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.AllocationResult;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.allocationresult_output.AllocationResult_Pending;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.allocationresult_output.AllocationResult_Withdrawn;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.Metadata;
import com.openzeppelin.dex.pools.PoolModels.Instrument;
import com.openzeppelin.dex.swaps.SwapModels.*;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class CantonSwapWithdrawalTest {
  @Test
  void joinsPartialWithdrawalsAndReturnsTheTransactionThatReleasesTheSecondAllocation() {
    var history =
        List.of(
            transaction(10, withdrawal("input")),
            transaction(20, withdrawal("unrelated")),
            transaction(
                30,
                withdrawal("output").toBuilder()
                    .setTemplateId(
                        new Identifier("another-token-package", "AnotherIssuer", "PendingTransfer")
                            .toProto())
                    .build()));
    var result = CantonSwapLedger.withdrawalConfirmation(history, swap(), 30).orElseThrow();
    assertThat(result.status()).isEqualTo(Status.WITHDRAWN);
    assertThat(result.updateId()).isEqualTo("update-30");
    assertThat(result.offset()).isEqualTo(30);
    assertThat(result.allocationCids()).containsExactly("input", "output");
  }

  @Test
  void doesNotUseAWithdrawalAfterTheConfirmedTransactionOffsetOrCountDuplicatesTwice() {
    var history =
        List.of(
            transaction(10, withdrawal("input")),
            transaction(20, withdrawal("input")),
            transaction(30, withdrawal("output")));
    assertThat(CantonSwapLedger.withdrawalConfirmation(history, swap(), 20)).isEmpty();
  }

  @Test
  void requiresStandardInterfaceCompletedWithdrawalAndOriginalTraderAndAllocation() {
    var output = withdrawal("output");
    var wrongPackage =
        output.toBuilder()
            .setInterfaceId(
                output.getInterfaceId().toBuilder().setPackageId("other-interface-package"))
            .build();
    var consuming = output.toBuilder().setConsuming(true).build();
    var wrongActor =
        output.toBuilder().clearActingParties().addActingParties("other-trader").build();
    var cancelled = output.toBuilder().setChoice("Allocation_Cancel").build();
    var unrelated = output.toBuilder().setContractId("other-output").build();
    var pending =
        output.toBuilder()
            .setExerciseResult(
                new AllocationResult(
                        new AllocationResult_Pending(new Allocation.ContractId("pending-output")),
                        Map.of(),
                        new Metadata(Map.of()))
                    .toValue()
                    .toProto())
            .build();
    var history =
        List.of(
            transaction(10, withdrawal("input")),
            transaction(18, output.toBuilder().clearExerciseResult().build()),
            transaction(19, output.toBuilder().clearInterfaceId().build()),
            transaction(20, wrongPackage),
            transaction(21, consuming),
            transaction(22, wrongActor),
            transaction(23, cancelled),
            transaction(24, unrelated),
            transaction(25, pending));
    assertThat(CantonSwapLedger.withdrawalConfirmation(history, swap(), 25)).isEmpty();
  }

  private static ExercisedEvent withdrawal(String allocation) {
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
        .setConsuming(false)
        .setChoice("Allocation_Withdraw")
        .addActingParties("trader")
        .build();
  }

  private static Transaction transaction(long offset, ExercisedEvent exercise) {
    return Transaction.newBuilder()
        .setOffset(offset)
        .setUpdateId("update-" + offset)
        .setEffectiveAt(Timestamp.newBuilder().setSeconds(offset))
        .addEvents(Event.newBuilder().setExercised(exercise))
        .build();
  }

  private static Swap swap() {
    var now = Instant.parse("2026-09-19T00:00:00Z");
    return new Swap(
        UUID.randomUUID(),
        UUID.randomUUID(),
        "pool",
        "Pool",
        "trader",
        Direction.BaseToQuote,
        new Instrument("issuer", "BTC"),
        new Instrument("issuer", "USDC"),
        "1",
        "10",
        "0.01",
        "9",
        now,
        Status.WITHDRAWING,
        1L,
        now,
        now,
        now,
        null,
        null,
        List.of("input", "output"),
        "submission",
        null,
        null,
        false);
  }
}
