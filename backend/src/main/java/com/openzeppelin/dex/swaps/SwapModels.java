package com.openzeppelin.dex.swaps;

import com.openzeppelin.dex.pools.PoolModels.Instrument;
import jakarta.validation.constraints.*;
import java.time.Instant;
import java.util.*;

public final class SwapModels {
  private SwapModels() {}

  public enum Direction {
    BaseToQuote,
    QuoteToBase
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
    WITHDRAWING,
    WITHDRAWAL_UNRESOLVED,
    WITHDRAWN,
    FAILED
  }

  public enum Action {
    SUBMIT,
    WITHDRAW
  }

  public record QuoteInput(
      @NotBlank String poolId,
      @NotNull Direction direction,
      @NotBlank String amountIn,
      @Min(0) @Max(5000) int slippageBps) {}

  public record Quote(
      UUID quoteId,
      String poolId,
      String poolName,
      String trader,
      Direction direction,
      Instrument inputInstrument,
      Instrument outputInstrument,
      String amountIn,
      String expectedOut,
      String feeAmount,
      String minOut,
      int slippageBps,
      String stateId,
      Instant quoteExpiresAt,
      Instant settlementDeadline) {}

  public record PrepareInput(
      @NotNull UUID quoteId, @NotBlank String minOut, @NotNull Instant settlementDeadline) {}

  public record SubmitInput(@NotNull UUID preparationId, @NotBlank String signature) {}

  public record Terms(
      String poolId,
      String poolName,
      String trader,
      Direction direction,
      Instrument inputInstrument,
      Instrument outputInstrument,
      String amountIn,
      String expectedOut,
      String feeAmount,
      String minOut,
      Instant settlementDeadline) {}

  /** The opaque transaction stays in the backend; the wallet signs the participant's hash. */
  public record SigningPayload(
      String preparedTransaction,
      String preparedTransactionHash,
      int hashingSchemeVersion,
      String partyId,
      String publicKeyFingerprint,
      Instant expiresAt) {}

  public record Preparation(
      UUID preparationId,
      UUID swapId,
      Action action,
      Terms terms,
      String preparedTransactionHash,
      String hashEncoding,
      int hashingSchemeVersion,
      String partyId,
      String publicKeyFingerprint,
      Instant expiresAt) {}

  public record Swap(
      UUID swapId,
      UUID quoteId,
      String poolId,
      String poolName,
      String trader,
      Direction direction,
      Instrument inputInstrument,
      Instrument outputInstrument,
      String amountIn,
      String expectedOut,
      String feeAmount,
      String minOut,
      Instant settlementDeadline,
      Status status,
      Long arrivalSequence,
      Instant createdAt,
      Instant submittedAt,
      Instant updatedAt,
      UUID settlementId,
      String amountOut,
      List<String> allocationCids,
      String updateId,
      String errorCode,
      String error,
      boolean canWithdraw) {}

  public record Activity(List<Swap> items, String nextCursor) {}

  /** Persisted work, also the ledger adapter's immutable submission/recovery input. */
  public record Pending(
      Swap swap,
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
      String amountOut,
      String updateId,
      long offset,
      Instant confirmedAt) {
    public Confirmation {
      allocationCids = List.copyOf(allocationCids);
    }
  }
}
