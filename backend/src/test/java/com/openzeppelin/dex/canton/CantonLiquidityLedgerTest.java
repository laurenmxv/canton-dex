package com.openzeppelin.dex.canton;

import static com.openzeppelin.dex.liquidity.LiquidityModels.*;
import static org.assertj.core.api.Assertions.*;

import com.daml.ledger.api.v2.EventOuterClass.CreatedEvent;
import com.daml.ledger.api.v2.EventOuterClass.Event;
import com.daml.ledger.api.v2.EventOuterClass.ExercisedEvent;
import com.daml.ledger.api.v2.EventOuterClass.InterfaceView;
import com.daml.ledger.api.v2.TransactionOuterClass.Transaction;
import com.daml.ledger.javaapi.data.Identifier;
import com.daml.ledger.javaapi.data.Value;
import com.openzeppelin.dex.canton.generated.lib.liquidity.DepositBatchRequest;
import com.openzeppelin.dex.canton.generated.lib.liquidity.DepositMode;
import com.openzeppelin.dex.canton.generated.lib.liquidity.DepositOutcome;
import com.openzeppelin.dex.canton.generated.lib.liquidity.DepositRequest;
import com.openzeppelin.dex.canton.generated.lib.liquidity.LiquidityTokenArgs;
import com.openzeppelin.dex.canton.generated.lib.liquidity.WithdrawalBatchRequest;
import com.openzeppelin.dex.canton.generated.lib.liquidity.WithdrawalOutcome;
import com.openzeppelin.dex.canton.generated.lib.liquidity.WithdrawalRequest;
import com.openzeppelin.dex.canton.generated.lib.liquidity.liquidityoutcome.LiquidityDeposited;
import com.openzeppelin.dex.canton.generated.lib.liquidity.liquidityoutcome.LiquidityWithdrawn;
import com.openzeppelin.dex.canton.generated.lib.tokens.Token;
import com.openzeppelin.dex.canton.generated.pool.*;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationinstructionv2.AllocationFactory;
import com.openzeppelin.dex.canton.generated.splice.api.token.allocationv2.*;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.Account;
import com.openzeppelin.dex.canton.generated.splice.api.token.holdingv2.InstrumentId;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.AnyContract;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.ChoiceContext;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.ExtraArgs;
import com.openzeppelin.dex.canton.generated.splice.api.token.metadatav1.Metadata;
import com.openzeppelin.dex.pools.PoolModels.Instrument;
import com.openzeppelin.dex.settlements.SettlementModels;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;

class CantonLiquidityLedgerTest {
  private static final String FIRST_RECEIPT = "first-receipt";
  private static final String SECOND_RECEIPT = "second-receipt";
  private static final String RECEIPT_MISMATCH =
      "Liquidity receipt differs from the settled request";
  private static final Instant NOW = Instant.parse("2026-09-22T12:00:00Z");
  private static final Instant DEADLINE = NOW.plusSeconds(600);
  private static final Pool.ContractId POOL = new Pool.ContractId("pool");
  private static final ExtraArgs EMPTY =
      new ExtraArgs(new ChoiceContext(Map.of()), new Metadata(Map.of()));
  private static final LiquidityTokenArgs TOKEN_ARGS =
      new LiquidityTokenArgs(EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY);

  private static final Pool POOL_VALUE =
      new Pool(
          "dvo",
          "operator",
          token("issuer", "BASE"),
          token("issuer", "QUOTE"),
          token("dvo", "LP"),
          new Account(Optional.of("dvo"), Optional.of("operator"), "base"),
          new Account(Optional.of("dvo"), Optional.of("operator"), "quote"));

  @Test
  void validatesIteratedFundingAndMinimumMetadataIncludingZero() {
    for (var kind : Kind.values()) {
      for (boolean zero : List.of(false, true)) {
        var request = request(kind, zero);
        for (int index = 0; index < 3; index++) {
          var spec = specification(request, index);
          CantonLiquidityLedger.validateAllocation(
              allocation(request, index, spec), request, POOL_VALUE, index);
        }
      }
    }
  }

  @Test
  void rejectsMissingChangedNonCanonicalAndUnexpectedMetadata() {
    for (var kind : Kind.values()) {
      var request = request(kind, true);
      for (int index = 0; index < 3; index++) {
        var spec = specification(request, index);
        var invalid = new ArrayList<Map<String, String>>();
        invalid.add(Map.of("unexpected", "value"));
        if (!spec.meta.values.isEmpty()) {
          String key = spec.meta.values.keySet().iterator().next();
          invalid.add(Map.of());
          invalid.add(Map.of(key, "1"));
          invalid.add(Map.of(key, "0.0"));
        }
        for (var metadata : invalid) {
          var changed =
              new AllocationSpecification(
                  spec.admin,
                  spec.authorizer,
                  spec.transferLegSides,
                  spec.settlementDeadline,
                  spec.nextIterationFunding,
                  spec.committed,
                  new Metadata(metadata));
          int side = index;
          assertThatThrownBy(
                  () ->
                      CantonLiquidityLedger.validateAllocation(
                          allocation(request, side, changed), request, POOL_VALUE, side))
              .isInstanceOf(IllegalStateException.class);
        }
      }
    }
  }

  @Test
  void rejectsChangedFundingAndAdditionalInitialLegs() {
    for (var kind : Kind.values()) {
      var request = request(kind);
      for (int index = 0; index < 3; index++) {
        var spec = specification(request, index);
        var changed =
            new AllocationSpecification(
                spec.admin,
                spec.authorizer,
                spec.transferLegSides,
                spec.settlementDeadline,
                Optional.of(Map.of("WRONG", decimal("1"))),
                spec.committed,
                spec.meta);
        int side = index;
        assertThatThrownBy(
                () ->
                    CantonLiquidityLedger.validateAllocation(
                        allocation(request, side, changed), request, POOL_VALUE, side))
            .isInstanceOf(IllegalStateException.class);
        var legs = new ArrayList<>(spec.transferLegSides);
        legs.add(
            new TransferLegSide(
                "extra",
                TransferSide.RECEIVERSIDE,
                spec.authorizer,
                decimal("1"),
                "BASE",
                new Metadata(Map.of())));
        var extraLeg =
            new AllocationSpecification(
                spec.admin,
                spec.authorizer,
                legs,
                spec.settlementDeadline,
                spec.nextIterationFunding,
                spec.committed,
                spec.meta);
        assertThatThrownBy(
                () ->
                    CantonLiquidityLedger.validateAllocation(
                        allocation(request, side, extraLeg), request, POOL_VALUE, side))
            .isInstanceOf(IllegalStateException.class);
      }
    }
  }

  @Test
  void confirmsDepositAndWithdrawalWithNumericallyEqualLedgerScale() {
    for (var kind : Kind.values()) {
      var request = request(kind);
      var transaction =
          transaction(
              exercise(request, request.allocationCids(), false, "receipt"),
              receipt(request, "receipt"));
      assertThat(CantonLiquidityLedger.settlementResult(transaction, request))
          .contains(
              kind == Kind.DEPOSIT
                  ? new DepositResult("10", "20", "0", "0", "14")
                  : new WithdrawalResult("2", "1", "2"));
    }
  }

  @Test
  void correlatesEveryDepositToItsReturnedReceiptInsideOneBatch() {
    var first = request(Kind.DEPOSIT);
    var second = request(Kind.DEPOSIT);
    var firstEvent = exercise(first, first.allocationCids(), false, FIRST_RECEIPT).getExercised();
    var secondEvent =
        exercise(second, second.allocationCids(), false, SECOND_RECEIPT).getExercised();
    var firstArgs =
        Pool_AddLiquidity.valueDecoder().decode(Value.fromProto(firstEvent.getChoiceArgument()));
    var secondArgs =
        Pool_AddLiquidity.valueDecoder().decode(Value.fromProto(secondEvent.getChoiceArgument()));
    var firstResult =
        AddLiquidityBatchResult.valueDecoder()
            .decode(Value.fromProto(firstEvent.getExerciseResult()));
    var secondResult =
        AddLiquidityBatchResult.valueDecoder()
            .decode(Value.fromProto(secondEvent.getExerciseResult()));
    var batch =
        firstEvent.toBuilder()
            .setChoiceArgument(
                new Pool_AddLiquidity(
                        firstArgs.configCid,
                        firstArgs.stateCid,
                        List.of(firstArgs.requests.getFirst(), secondArgs.requests.getFirst()))
                    .toValue()
                    .toProto())
            .setExerciseResult(
                new AddLiquidityBatchResult(
                        firstResult.stateCid,
                        List.of(
                            firstResult.receiptCids.getFirst(),
                            secondResult.receiptCids.getFirst()),
                        List.of(firstResult.outcomes.getFirst(), secondResult.outcomes.getFirst()))
                    .toValue()
                    .toProto());
    var transaction =
        transaction(
            Event.newBuilder().setExercised(batch).build(),
            receipt(second, SECOND_RECEIPT),
            receipt(first, FIRST_RECEIPT));
    for (var request : List.of(first, second))
      assertThat(CantonLiquidityLedger.settlementResult(transaction, request))
          .contains(new DepositResult("10", "20", "0", "0", "14"));
    batch.setExerciseResult(
        new AddLiquidityBatchResult(
                firstResult.stateCid,
                List.of(secondResult.receiptCids.getFirst(), firstResult.receiptCids.getFirst()),
                List.of(firstResult.outcomes.getFirst(), secondResult.outcomes.getFirst()))
            .toValue()
            .toProto());
    var mismatched =
        transaction(
            Event.newBuilder().setExercised(batch).build(),
            receipt(first, FIRST_RECEIPT),
            receipt(second, SECOND_RECEIPT));
    assertThatThrownBy(() -> CantonLiquidityLedger.settlementResult(mismatched, first))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage(RECEIPT_MISMATCH);
  }

  @Test
  void correlatesEveryWithdrawalToItsReturnedReceiptInsideOneBatch() {
    var first = request(Kind.WITHDRAW);
    var second = request(Kind.WITHDRAW);
    var firstEvent = exercise(first, first.allocationCids(), false, FIRST_RECEIPT).getExercised();
    var secondEvent =
        exercise(second, second.allocationCids(), false, SECOND_RECEIPT).getExercised();
    var firstArgs =
        Pool_WithdrawLiquidity.valueDecoder()
            .decode(Value.fromProto(firstEvent.getChoiceArgument()));
    var secondArgs =
        Pool_WithdrawLiquidity.valueDecoder()
            .decode(Value.fromProto(secondEvent.getChoiceArgument()));
    var firstResult =
        WithdrawLiquidityBatchResult.valueDecoder()
            .decode(Value.fromProto(firstEvent.getExerciseResult()));
    var secondResult =
        WithdrawLiquidityBatchResult.valueDecoder()
            .decode(Value.fromProto(secondEvent.getExerciseResult()));
    var receipts = List.of(firstResult.receiptCids.getFirst(), secondResult.receiptCids.getFirst());
    var outcomes = List.of(firstResult.outcomes.getFirst(), secondResult.outcomes.getFirst());
    var batch =
        firstEvent.toBuilder()
            .setChoiceArgument(
                new Pool_WithdrawLiquidity(
                        firstArgs.configCid,
                        firstArgs.stateCid,
                        List.of(firstArgs.requests.getFirst(), secondArgs.requests.getFirst()))
                    .toValue()
                    .toProto())
            .setExerciseResult(
                new WithdrawLiquidityBatchResult(firstResult.stateCid, receipts, outcomes)
                    .toValue()
                    .toProto());
    var transaction =
        transaction(
            Event.newBuilder().setExercised(batch).build(),
            receipt(second, SECOND_RECEIPT),
            receipt(first, FIRST_RECEIPT));
    for (var request : List.of(first, second))
      assertThat(CantonLiquidityLedger.settlementResult(transaction, request))
          .contains(new WithdrawalResult("2", "1", "2"));
    batch.setExerciseResult(
        new WithdrawLiquidityBatchResult(firstResult.stateCid, receipts.reversed(), outcomes)
            .toValue()
            .toProto());
    var mismatched =
        transaction(
            Event.newBuilder().setExercised(batch).build(),
            receipt(first, FIRST_RECEIPT),
            receipt(second, SECOND_RECEIPT));
    assertThatThrownBy(() -> CantonLiquidityLedger.settlementResult(mismatched, first))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage(RECEIPT_MISMATCH);
    batch.setExerciseResult(
        new WithdrawLiquidityBatchResult(
                firstResult.stateCid, List.of(receipts.getFirst()), outcomes)
            .toValue()
            .toProto());
    var incomplete =
        transaction(Event.newBuilder().setExercised(batch).build(), receipt(first, FIRST_RECEIPT));
    assertThatThrownBy(() -> CantonLiquidityLedger.settlementResult(incomplete, first))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("Withdrawal batch receipt count differs");
  }

  @Test
  void ignoresAnotherRequestWithTheSameIdAndTermsButDifferentAllocations() {
    for (var kind : Kind.values()) {
      var request = request(kind);
      for (int index = 0; index < 3; index++) {
        var allocations = new ArrayList<>(request.allocationCids());
        allocations.set(index, "another-allocation");
        var transaction =
            transaction(
                exercise(request, allocations, false, "receipt"), receipt(request, "receipt"));
        assertThat(CantonLiquidityLedger.settlementResult(transaction, request)).isEmpty();
      }
    }
  }

  @Test
  void requiresTheSameSignedTermsEvenWhenRequestIdAndAllocationsMatch() {
    for (var kind : Kind.values()) {
      var request = request(kind);
      var transaction =
          transaction(
              exercise(request, request.allocationCids(), true, "receipt"),
              receipt(request, "receipt"));
      assertThat(CantonLiquidityLedger.settlementResult(transaction, request)).isEmpty();
    }
  }

  @Test
  void requiresTheReceiptReturnedByThePoolChoice() {
    for (var kind : Kind.values()) {
      var request = request(kind);
      assertThat(
              CantonLiquidityLedger.settlementResult(
                  transaction(receipt(request, "receipt")), request))
          .isEmpty();
      var transaction =
          transaction(
              exercise(request, request.allocationCids(), false, "returned-receipt"),
              receipt(request, "other-receipt"));
      assertThatThrownBy(() -> CantonLiquidityLedger.settlementResult(transaction, request))
          .isInstanceOf(IllegalStateException.class)
          .hasMessage("Liquidity settlement receipt is missing");
    }
  }

  @Test
  void liquidityPreviewReportsBothWithdrawalLimitsAndMintHeadroom() {
    var state = new SettlementModels.ProjectedPoolState("100", "200", "100", "2", "20000");
    var withdrawal = request(Kind.WITHDRAW);
    var step =
        CantonSettlementLedger.validStep(
            new SettlementModels.LiquidityRequest(withdrawal),
            new SettlementModels.WithdrawalFill(withdrawal.requestId(), "2", "1", "2"),
            List.of(),
            state,
            state);
    assertThat(step.outputs())
        .containsExactly(
            new SettlementModels.OutputCheck(
                withdrawal.terms().baseInstrument(), "1", "0.9", "1000"),
            new SettlementModels.OutputCheck(
                withdrawal.terms().quoteInstrument(), "2", "1.9", "500"));
    var deposit = request(Kind.DEPOSIT);
    var minted =
        CantonSettlementLedger.validStep(
            new SettlementModels.LiquidityRequest(deposit),
            new SettlementModels.DepositFill(deposit.requestId(), "10", "20", "0", "0", "14"),
            List.of(),
            state,
            state);
    assertThat(minted.outputs())
        .containsExactly(
            new SettlementModels.OutputCheck(
                deposit.terms().lpInstrument(), "14", "13", "714.2857"));
  }

  private static Request request(Kind kind) {
    return request(kind, false);
  }

  private static Request request(Kind kind, boolean zeroMinimum) {
    var base = new Instrument("issuer", "BASE");
    var quote = new Instrument("issuer", "QUOTE");
    var lp = new Instrument("dvo", "LP");
    Terms terms =
        kind == Kind.DEPOSIT
            ? new DepositTerms(
                "pool",
                "Pool",
                "trader",
                base,
                quote,
                lp,
                Mode.PROPORTIONAL,
                "10",
                "20",
                "10",
                "20",
                "0",
                "0",
                "14",
                zeroMinimum ? "0" : "13",
                "1.9",
                "2.1",
                null,
                DEADLINE)
            : new WithdrawalTerms(
                "pool",
                "Pool",
                "trader",
                base,
                quote,
                lp,
                "2",
                "1",
                "2",
                zeroMinimum ? "0" : "0.9",
                zeroMinimum ? "0" : "1.9",
                DEADLINE);
    var requestId = UUID.randomUUID();
    return new Request(
        requestId,
        UUID.randomUUID(),
        kind,
        terms,
        Status.SETTLING,
        1L,
        NOW,
        NOW,
        NOW,
        null,
        null,
        List.of(requestId + "-base", requestId + "-quote", requestId + "-lp"),
        null,
        null,
        null,
        false);
  }

  private static Token token(String admin, String id) {
    return new Token(
        new InstrumentId(admin, id),
        new AllocationFactory.ContractId("allocation-factory"),
        new SettlementFactory.ContractId("settlement-factory"),
        10L);
  }

  private static AllocationSpecification specification(Request request, int index) {
    String instrument = index == 0 ? "BASE" : index == 1 ? "QUOTE" : "LP";
    String admin = index == 2 ? "dvo" : "issuer";
    var authorizer = new Account(Optional.of("trader"), Optional.empty(), "");
    var metadata = new HashMap<String, String>();
    Optional<Map<String, BigDecimal>> funding = Optional.of(Map.of());
    List<TransferLegSide> legs = List.of();
    if (request.terms() instanceof DepositTerms terms) {
      if (index < 2) {
        funding =
            Optional.of(
                Map.of(
                    instrument,
                    decimal(index == 0 ? terms.maxBaseAmount() : terms.maxQuoteAmount())));
      } else {
        metadata.put(AllocationMetadata.MIN_LP_OUT, terms.minLpOut());
      }
    } else {
      var terms = (WithdrawalTerms) request.terms();
      if (index < 2) {
        metadata.put(
            index == 0 ? AllocationMetadata.MIN_BASE_OUT : AllocationMetadata.MIN_QUOTE_OUT,
            index == 0 ? terms.minBaseOut() : terms.minQuoteOut());
      } else {
        funding = Optional.empty();
        legs =
            List.of(
                new TransferLegSide(
                    "lp-burn",
                    TransferSide.SENDERSIDE,
                    new Account(Optional.empty(), Optional.empty(), "cip-112/burn"),
                    decimal(terms.lpAmount()),
                    instrument,
                    new Metadata(Map.of())));
      }
    }
    return new AllocationSpecification(
        admin, authorizer, legs, Optional.of(DEADLINE), funding, true, new Metadata(metadata));
  }

  private static CreatedEvent allocation(Request request, int index, AllocationSpecification spec) {
    var empty = new Metadata(Map.of());
    var view =
        new AllocationView(
            Optional.empty(),
            new SettlementInfo(
                List.of("dvo", "operator"),
                CantonLiquidityLedger.settlementId(request),
                Optional.of(new AnyContract.ContractId("pool")),
                empty),
            spec,
            List.of(),
            NOW,
            0L,
            Optional.empty(),
            Map.of(),
            empty);
    return CreatedEvent.newBuilder()
        .setContractId(request.allocationCids().get(index))
        .setTemplateId(
            new Identifier("independent-token-package", "Issuer", "Allocation").toProto())
        .addInterfaceViews(
            InterfaceView.newBuilder()
                .setInterfaceId(Allocation.INTERFACE_ID_WITH_PACKAGE_ID.toProto())
                .setViewValue(view.toValue().toProtoRecord()))
        .build();
  }

  private static Event exercise(
      Request request, List<String> allocations, boolean changedTerms, String receiptId) {
    var base = new Allocation.ContractId(allocations.get(0));
    var quote = new Allocation.ContractId(allocations.get(1));
    var lp = new Allocation.ContractId(allocations.get(2));
    var config = new PoolConfig.ContractId("config");
    var state = new PoolState.ContractId("before-state");
    Value argument;
    if (request.kind() == Kind.DEPOSIT) {
      var terms =
          new com.openzeppelin.dex.canton.generated.lib.liquidity.DepositTerms(
              request.requestId().toString(),
              DepositMode.PROPORTIONAL,
              decimal(changedTerms ? "11" : "10"),
              decimal("20"),
              decimal("13"),
              decimal("1.9"),
              decimal("2.1"),
              DEADLINE);
      argument =
          new Pool_AddLiquidity(
                  config,
                  state,
                  List.of(
                      new DepositBatchRequest<>(
                          new DepositRequest<>(POOL, "trader", terms, base, quote, lp),
                          TOKEN_ARGS)))
              .toValue();
    } else {
      var terms =
          new com.openzeppelin.dex.canton.generated.lib.liquidity.WithdrawalTerms(
              request.requestId().toString(),
              decimal(changedTerms ? "3" : "2"),
              decimal("0.9"),
              decimal("1.9"),
              DEADLINE);
      argument =
          new Pool_WithdrawLiquidity(
                  config,
                  state,
                  List.of(
                      new WithdrawalBatchRequest<>(
                          new WithdrawalRequest<>(POOL, "trader", terms, base, quote, lp),
                          TOKEN_ARGS)))
              .toValue();
    }
    Value result =
        request.kind() == Kind.DEPOSIT
            ? new AddLiquidityBatchResult(
                    new PoolState.ContractId("after-state"),
                    List.of(new LiquidityReceipt.ContractId(receiptId)),
                    List.of(
                        new DepositOutcome(
                            decimal("10"),
                            decimal("20"),
                            decimal("0"),
                            decimal("0"),
                            decimal("14"))))
                .toValue()
            : new WithdrawLiquidityBatchResult(
                    new PoolState.ContractId("after-state"),
                    List.of(new LiquidityReceipt.ContractId(receiptId)),
                    List.of(new WithdrawalOutcome(decimal("1"), decimal("2"), decimal("2"))))
                .toValue();
    return Event.newBuilder()
        .setExercised(
            ExercisedEvent.newBuilder()
                .setTemplateId(Pool.TEMPLATE_ID_WITH_PACKAGE_ID.toProto())
                .setContractId("pool")
                .setChoice(
                    request.kind() == Kind.DEPOSIT ? "Pool_AddLiquidity" : "Pool_WithdrawLiquidity")
                .addAllActingParties(List.of("dvo", "operator"))
                .setChoiceArgument(argument.toProto())
                .setExerciseResult(result.toProto()))
        .build();
  }

  private static Event receipt(Request request, String id) {
    var outcome =
        request.kind() == Kind.DEPOSIT
            ? new LiquidityDeposited(
                new DepositOutcome(
                    decimal("10"), decimal("20"), decimal("0"), decimal("0"), decimal("14")))
            : new LiquidityWithdrawn(
                new WithdrawalOutcome(decimal("1"), decimal("2"), decimal("2")));
    var receipt =
        new LiquidityReceipt(
            "dvo", "operator", "trader", POOL, request.requestId().toString(), outcome, NOW);
    return Event.newBuilder()
        .setCreated(
            CreatedEvent.newBuilder()
                .setContractId(id)
                .setTemplateId(LiquidityReceipt.TEMPLATE_ID_WITH_PACKAGE_ID.toProto())
                .setCreateArguments(receipt.toValue().toProtoRecord()))
        .build();
  }

  private static Transaction transaction(Event... events) {
    return Transaction.newBuilder().addAllEvents(List.of(events)).build();
  }

  private static BigDecimal decimal(String value) {
    return new BigDecimal(value).setScale(10);
  }
}
