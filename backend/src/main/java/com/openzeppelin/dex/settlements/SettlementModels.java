package com.openzeppelin.dex.settlements;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.openzeppelin.dex.liquidity.LiquidityModels;
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

  public record RunInput(@NotNull UUID idempotencyKey, Selection selection) {
    public RunInput(UUID idempotencyKey) {
      this(idempotencyKey, null);
    }
  }

  public record Selection(
      String type,
      UUID retryOf,
      String stateVersion,
      long policyVersion,
      List<RequestRef> requests) {
    public Selection {
      requireFamily(type);
      if (stateVersion == null || stateVersion.isBlank() || requests == null)
        throw new IllegalArgumentException("Incomplete settlement selection");
      requests = List.copyOf(requests);
      if (requests.stream().anyMatch(ref -> !ref.type().equals(type))
          || new HashSet<>(requests).size() != requests.size())
        throw new IllegalArgumentException("Invalid settlement membership");
    }
  }

  public static void requireFamily(String family) {
    if (family == null || !FAMILIES.contains(family))
      throw new IllegalArgumentException("Invalid request family");
  }

  public static final List<String> FAMILIES = List.of("swap", "deposit", "withdraw");
  public static final String POOL_CHANGED = "POOL_CHANGED";
  public static final String POLICY_CHANGED = "POLICY_CHANGED";
  public static final String QUEUE_CHANGED = "QUEUE_CHANGED";
  public static final String BATCH_IN_FLIGHT = "BATCH_IN_FLIGHT";
  public static final String IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT";
  public static final String RETRY_NOT_ALLOWED = "RETRY_NOT_ALLOWED";
  public static final String REQUEST_NOT_READY = "REQUEST_NOT_READY";

  public record DeferredInput(@NotNull Boolean deferred) {}

  public record History(List<Settlement> items, String nextCursor) {}

  public enum PreviewStatus {
    VALID,
    BLOCKED,
    NOT_EVALUATED
  }

  public record ProjectedPoolState(
      String baseReserve,
      String quoteReserve,
      String lpTokenSupply,
      String spotPrice,
      String invariant) {}

  public record OutputCheck(
      Instrument instrument, String amount, String minimum, String headroomBps) {}

  public record PreviewStep(
      RequestRef request,
      PreviewStatus status,
      Fill fill,
      ProjectedPoolState before,
      ProjectedPoolState after,
      List<OutputCheck> outputs,
      String errorCode,
      String error) {}

  public record Preview(
      Selection selection,
      Snapshot pool,
      List<PreviewStep> steps,
      UUID activeSettlementId,
      boolean executable) {}

  public record Plan(Selection selection, List<QueueRequest> requests, UUID activeSettlementId) {}

  public record Reserves(
      String stateId,
      String baseReserve,
      String quoteReserve,
      String spotPrice,
      String invariant) {}

  public record RequestRef(String type, UUID requestId) {
    public RequestRef {
      if (!FAMILIES.contains(type) || requestId == null)
        throw new IllegalArgumentException("Invalid settlement request reference");
    }
  }

  public sealed interface QueueRequest permits SwapRequest, LiquidityRequest {
    @JsonProperty
    String type();

    boolean deferred();

    RequestRef reference();

    String poolId();

    String trader();

    String status();

    Long arrivalSequence();

    Instant createdAt();

    Instant submittedAt();

    Instant settlementDeadline();

    String error();
  }

  public record SwapRequest(Swap request, boolean deferred) implements QueueRequest {
    public SwapRequest(Swap request) {
      this(request, false);
    }

    public String type() {
      return "swap";
    }

    public RequestRef reference() {
      return new RequestRef(type(), request.swapId());
    }

    public String poolId() {
      return request.poolId();
    }

    public String trader() {
      return request.trader();
    }

    public String status() {
      return request.status().name();
    }

    public Long arrivalSequence() {
      return request.arrivalSequence();
    }

    public Instant createdAt() {
      return request.createdAt();
    }

    public Instant submittedAt() {
      return request.submittedAt();
    }

    public Instant settlementDeadline() {
      return request.settlementDeadline();
    }

    public String error() {
      return request.error();
    }
  }

  public record LiquidityRequest(LiquidityModels.Request request, boolean deferred)
      implements QueueRequest {
    public LiquidityRequest(LiquidityModels.Request request) {
      this(request, false);
    }

    public String type() {
      return request.kind() == LiquidityModels.Kind.DEPOSIT ? "deposit" : "withdraw";
    }

    public RequestRef reference() {
      return new RequestRef(type(), request.requestId());
    }

    public String poolId() {
      return request.terms().poolId();
    }

    public String trader() {
      return request.terms().trader();
    }

    public String status() {
      return request.status().name();
    }

    public Long arrivalSequence() {
      return request.arrivalSequence();
    }

    public Instant createdAt() {
      return request.createdAt();
    }

    public Instant submittedAt() {
      return request.submittedAt();
    }

    public Instant settlementDeadline() {
      return request.terms().settlementDeadline();
    }

    public String error() {
      return request.error();
    }
  }

  @JsonTypeInfo(
      use = JsonTypeInfo.Id.NAME,
      include = JsonTypeInfo.As.EXISTING_PROPERTY,
      property = "type")
  @JsonSubTypes({
    @JsonSubTypes.Type(value = SwapFill.class, name = "swap"),
    @JsonSubTypes.Type(value = DepositFill.class, name = "deposit"),
    @JsonSubTypes.Type(value = WithdrawalFill.class, name = "withdraw")
  })
  public sealed interface Fill permits SwapFill, DepositFill, WithdrawalFill {
    UUID requestId();

    @JsonProperty("type")
    default String type() {
      return switch (this) {
        case SwapFill ignored -> "swap";
        case DepositFill ignored -> "deposit";
        case WithdrawalFill ignored -> "withdraw";
      };
    }

    @JsonIgnore
    default RequestRef reference() {
      return new RequestRef(type(), requestId());
    }
  }

  public record SwapFill(UUID requestId, String amountOut, Instrument outputInstrument)
      implements Fill {}

  public record DepositFill(
      UUID requestId,
      String actualBaseIn,
      String actualQuoteIn,
      String actualBaseRefund,
      String actualQuoteRefund,
      String actualLpOut)
      implements Fill {}

  public record WithdrawalFill(
      UUID requestId, String actualLpBurned, String actualBaseOut, String actualQuoteOut)
      implements Fill {}

  public record Settlement(
      UUID settlementId,
      String poolId,
      Trigger trigger,
      Status status,
      List<RequestRef> requests,
      List<Fill> fills,
      Reserves before,
      Reserves after,
      long policyVersion,
      Instant createdAt,
      Instant updatedAt,
      String updateId,
      String errorCode,
      String error,
      UUID retryOf) {}

  public record Snapshot(
      String poolId,
      String version,
      Reserves reserves,
      String feeBps,
      String health,
      String reason,
      Instant observedAt,
      long ledgerOffset,
      String lpTokenSupply,
      String initialRatio) {}

  public record Monitoring(
      String poolId,
      Policy policy,
      int readyCount,
      int pendingCount,
      RequestRef blockedRequest,
      String blockedReason,
      Instant oldestSubmittedAt,
      Instant nearestDeadline,
      Settlement activeSettlement,
      Snapshot pool) {}

  public record Pending(
      Settlement settlement,
      List<QueueRequest> requests,
      UUID commandId,
      long beginOffset,
      String stateVersion,
      Selection selection) {
    public Pending(
        Settlement settlement,
        List<QueueRequest> requests,
        UUID commandId,
        long beginOffset,
        String stateVersion) {
      this(settlement, requests, commandId, beginOffset, stateVersion, null);
    }
  }

  public record Confirmation(
      List<Fill> fills,
      Reserves before,
      Reserves after,
      String updateId,
      long offset,
      Instant confirmedAt) {}
}
