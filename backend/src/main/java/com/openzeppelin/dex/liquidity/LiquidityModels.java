package com.openzeppelin.dex.liquidity;

import com.openzeppelin.dex.pools.PoolModels.Instrument;
import jakarta.validation.constraints.*;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class LiquidityModels {
  private LiquidityModels() {}

  public enum Kind {
    DEPOSIT,
    WITHDRAW
  }

  public enum Mode {
    INITIAL,
    PROPORTIONAL
  }

  public enum Action {
    SUBMIT,
    RECOVER
  }

  public enum Status {
    PREPARED,
    SUBMITTING,
    UNRESOLVED,
    READY,
    BLOCKED,
    SETTLING,
    SETTLED,
    EXPIRED,
    RECOVERING,
    RECOVERY_UNRESOLVED,
    RECOVERED,
    FAILED
  }

  public enum RecoveryKind {
    RETURN_FUNDS,
    RELEASE_PERMISSION
  }

  public record DepositQuoteInput(
      @NotBlank String poolId,
      @NotBlank String maxBaseAmount,
      @NotBlank String maxQuoteAmount,
      @Min(0) @Max(5000) int slippageBps) {}

  public record WithdrawalQuoteInput(
      @NotBlank String poolId, @NotBlank String lpAmount, @Min(0) @Max(5000) int slippageBps) {}

  public record DepositQuote(
      UUID quoteId,
      String poolId,
      String poolName,
      String trader,
      Instrument baseInstrument,
      Instrument quoteInstrument,
      Instrument lpInstrument,
      Mode mode,
      String maxBaseAmount,
      String maxQuoteAmount,
      String expectedBaseAmount,
      String expectedQuoteAmount,
      String expectedBaseRefund,
      String expectedQuoteRefund,
      String expectedLpOut,
      String minLpOut,
      String minRatio,
      String maxRatio,
      String initialMinimumLp,
      int slippageBps,
      String stateId,
      Instant quoteExpiresAt,
      Instant settlementDeadline) {}

  public record WithdrawalQuote(
      UUID quoteId,
      String poolId,
      String poolName,
      String trader,
      Instrument baseInstrument,
      Instrument quoteInstrument,
      Instrument lpInstrument,
      String lpAmount,
      String expectedBaseOut,
      String expectedQuoteOut,
      String minBaseOut,
      String minQuoteOut,
      int slippageBps,
      String stateId,
      Instant quoteExpiresAt,
      Instant settlementDeadline) {}

  public record PrepareDepositInput(
      @NotNull UUID quoteId,
      @NotBlank String minLpOut,
      @NotBlank String minRatio,
      @NotBlank String maxRatio,
      @NotNull Instant settlementDeadline) {}

  public record PrepareWithdrawalInput(
      @NotNull UUID quoteId,
      @NotBlank String minBaseOut,
      @NotBlank String minQuoteOut,
      @NotNull Instant settlementDeadline) {}

  public record SubmitInput(@NotNull UUID preparationId, @NotBlank String signature) {}

  public sealed interface Terms permits DepositTerms, WithdrawalTerms {
    String poolId();

    String poolName();

    String trader();

    Instrument baseInstrument();

    Instrument quoteInstrument();

    Instrument lpInstrument();

    Instant settlementDeadline();
  }

  public record DepositTerms(
      String poolId,
      String poolName,
      String trader,
      Instrument baseInstrument,
      Instrument quoteInstrument,
      Instrument lpInstrument,
      Mode mode,
      String maxBaseAmount,
      String maxQuoteAmount,
      String expectedBaseAmount,
      String expectedQuoteAmount,
      String expectedBaseRefund,
      String expectedQuoteRefund,
      String expectedLpOut,
      String minLpOut,
      String minRatio,
      String maxRatio,
      String initialMinimumLp,
      Instant settlementDeadline)
      implements Terms {}

  public record WithdrawalTerms(
      String poolId,
      String poolName,
      String trader,
      Instrument baseInstrument,
      Instrument quoteInstrument,
      Instrument lpInstrument,
      String lpAmount,
      String expectedBaseOut,
      String expectedQuoteOut,
      String minBaseOut,
      String minQuoteOut,
      Instant settlementDeadline)
      implements Terms {}

  public sealed interface Result permits DepositResult, WithdrawalResult {}

  public record DepositResult(
      String actualBaseIn,
      String actualQuoteIn,
      String actualBaseRefund,
      String actualQuoteRefund,
      String actualLpOut)
      implements Result {}

  public record WithdrawalResult(String actualLpBurned, String actualBaseOut, String actualQuoteOut)
      implements Result {}

  public record RecoveryEffect(
      String allocationCid, Instrument instrument, String amount, RecoveryKind kind) {}

  /** The opaque transaction remains server-side; wallets sign its participant hash. */
  public record SigningPayload(
      String preparedTransaction,
      String preparedTransactionHash,
      int hashingSchemeVersion,
      String partyId,
      String publicKeyFingerprint,
      Instant expiresAt,
      List<RecoveryEffect> recoveryEffects) {
    public SigningPayload {
      recoveryEffects = List.copyOf(recoveryEffects);
    }
  }

  public record Preparation(
      UUID preparationId,
      UUID requestId,
      Action action,
      Terms terms,
      String preparedTransactionHash,
      String hashEncoding,
      int hashingSchemeVersion,
      String partyId,
      String publicKeyFingerprint,
      Instant expiresAt,
      List<RecoveryEffect> recoveryEffects) {}

  public record Request(
      UUID requestId,
      UUID quoteId,
      Kind kind,
      Terms terms,
      Status status,
      Long arrivalSequence,
      Instant createdAt,
      Instant submittedAt,
      Instant updatedAt,
      UUID settlementId,
      Result result,
      List<String> allocationCids,
      String updateId,
      String errorCode,
      String error,
      boolean canRecover) {
    public Request {
      allocationCids = List.copyOf(allocationCids);
    }
  }

  public record Activity(List<Request> items, String nextCursor) {}

  public record Pending(
      Request request,
      UUID accountId,
      UUID preparationId,
      UUID commandId,
      Action action,
      SigningPayload signing,
      String signature,
      long beginOffset) {}

  public record Confirmation(
      Status status,
      List<String> allocationCids,
      Result result,
      String updateId,
      long offset,
      Instant confirmedAt) {
    public Confirmation {
      allocationCids = List.copyOf(allocationCids);
    }
  }

  public record Position(
      String poolId,
      String poolName,
      Instrument baseInstrument,
      Instrument quoteInstrument,
      Instrument lpInstrument,
      String availableLp,
      String allocatedLp,
      String totalLp,
      String lpTokenSupply,
      String share,
      String baseValue,
      String quoteValue) {}

  public record Positions(List<Position> items, long asOfOffset) {
    public Positions {
      items = List.copyOf(items);
    }
  }
}
