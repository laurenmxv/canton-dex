package com.openzeppelin.dex.settlements;

import com.openzeppelin.dex.pools.PoolModels.Instrument;
import com.openzeppelin.dex.swaps.SwapModels.Swap;
import jakarta.validation.constraints.*;
import java.time.Instant;
import java.util.*;

public final class SettlementModels {
  private SettlementModels() {}

  public enum Status {
    PREPARING,
    SUBMITTING,
    UNRESOLVED,
    CONFIRMED,
    REJECTED,
    CANCELLED
  }

  public enum Trigger {
    MANUAL,
    AUTOMATIC
  }

  public record Policy(
      String poolId,
      boolean automaticEnabled,
      int batchSize,
      int maxBatchSize,
      long version,
      Instant updatedAt) {}

  public record UpdatePolicy(
      boolean automaticEnabled, @Min(1) int batchSize, @Min(0) long expectedVersion) {}

  public record RunInput(@NotNull UUID idempotencyKey) {}

  public record Reserves(
      String stateId,
      String baseReserve,
      String quoteReserve,
      String spotPrice,
      String invariant) {}

  /**
   * Legacy stored fills have no outputInstrument; new fills preserve the exact instrument tuple.
   */
  public record Fill(UUID swapId, String amountOut, Instrument outputInstrument) {}

  public record Settlement(
      UUID settlementId,
      String poolId,
      Trigger trigger,
      Status status,
      List<UUID> swapIds,
      List<Fill> fills,
      Reserves before,
      Reserves after,
      long policyVersion,
      Instant createdAt,
      Instant updatedAt,
      String updateId,
      String errorCode,
      String error) {}

  public record Snapshot(
      String poolId,
      String version,
      Reserves reserves,
      String feeBps,
      String health,
      String reason,
      Instant observedAt,
      long ledgerOffset) {}

  public record Monitoring(
      String poolId,
      Policy policy,
      int readyCount,
      int pendingCount,
      UUID blockedSwapId,
      String blockedReason,
      Instant oldestSubmittedAt,
      Instant nearestDeadline,
      Settlement activeSettlement,
      Snapshot pool) {}

  public record Pending(
      Settlement settlement,
      List<Swap> swaps,
      UUID commandId,
      long beginOffset,
      String stateVersion) {}

  public record Confirmation(
      List<Fill> fills,
      Reserves before,
      Reserves after,
      String updateId,
      long offset,
      Instant confirmedAt) {}
}
