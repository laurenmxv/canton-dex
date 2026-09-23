package com.openzeppelin.dex.pools;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

public final class PoolModels {
  private PoolModels() {}

  public record Instrument(
      @NotBlank @Size(max = 255) String admin, @NotBlank @Size(max = 128) String id) {}

  public record ReserveAccount(String owner, String provider, String id) {}

  public record ProposalTerms(
      String dvo, Instrument baseInstrumentId, Instrument quoteInstrumentId, String feeBps) {
    public String pairKey() {
      return PoolModels.pairKey(baseInstrumentId, quoteInstrumentId);
    }
  }

  public record Terms(
      String dvo,
      Instrument baseInstrumentId,
      Instrument quoteInstrumentId,
      ReserveAccount baseAccount,
      ReserveAccount quoteAccount,
      Instrument lpTokenInstrumentId,
      String feeBps,
      String baseReserve,
      String quoteReserve,
      String lpTokenSupply,
      String initialRatio) {
    public String pairKey() {
      return PoolModels.pairKey(baseInstrumentId, quoteInstrumentId);
    }

    public ProposalTerms proposal() {
      return new ProposalTerms(dvo, baseInstrumentId, quoteInstrumentId, feeBps);
    }
  }

  private static String pairKey(Instrument base, Instrument quote) {
    var identities =
        new ArrayList<>(
            List.of(base.admin() + "\n" + base.id(), quote.admin() + "\n" + quote.id()));
    Collections.sort(identities);
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(String.join("\n", identities).getBytes(StandardCharsets.UTF_8)));
    } catch (java.security.NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  public record Create(
      @NotBlank @Size(max = 120) String name,
      @NotNull @Valid Instrument baseInstrumentId,
      @NotNull @Valid Instrument quoteInstrumentId,
      @NotNull String feeBps) {
    public ProposalTerms terms(Options options) {
      for (String value :
          List.of(
              name,
              baseInstrumentId.admin(),
              baseInstrumentId.id(),
              quoteInstrumentId.admin(),
              quoteInstrumentId.id()))
        if (!value.equals(value.trim())
            || value.isBlank()
            || value.chars().anyMatch(Character::isISOControl))
          throw new IllegalArgumentException("Invalid pool identifier");
      var registered =
          options.instruments().stream().map(RegisteredInstrument::instrument).toList();
      if (!registered.contains(baseInstrumentId) || !registered.contains(quoteInstrumentId))
        throw new IllegalArgumentException("Both instruments must be registered by the venue");
      if (baseInstrumentId.equals(quoteInstrumentId))
        throw new IllegalArgumentException("Instruments must differ");
      BigDecimal fee = decimal(feeBps);
      if (fee.signum() < 0
          || fee.compareTo(new BigDecimal("10000")) >= 0
          || fee.stripTrailingZeros().scale() > 0)
        throw new IllegalArgumentException("Fee must be whole basis points below 10000");
      return new ProposalTerms(options.dvo(), baseInstrumentId, quoteInstrumentId, feeBps);
    }
  }

  static BigDecimal decimal(String value) {
    if (value == null || !value.matches("(?:0|[1-9][0-9]{0,27})(?:\\.[0-9]{1,10})?"))
      throw new IllegalArgumentException("Invalid decimal");
    return new BigDecimal(value);
  }

  /** An instrument the venue registers, as a proposal may choose it. */
  public record RegisteredInstrument(String admin, String id, String symbol, int decimals) {
    public Instrument instrument() {
      return new Instrument(admin, id);
    }
  }

  /**
   * What a proposal is built against.
   *
   * <p>The caller chooses none of the parties, and picks its pair out of {@code instruments}.
   */
  public record Options(
      String factoryId, String dvo, String venueOperator, List<RegisteredInstrument> instruments) {}

  public enum Status {
    SUBMITTING,
    PENDING,
    CREATED,
    REJECTED,
    WITHDRAWN,
    UNRESOLVED,
    FAILED
  }

  public record Proposal(
      UUID proposalId,
      String name,
      ProposalTerms settings,
      Status status,
      Instant createdAt,
      Instant updatedAt,
      String proposedBy,
      String proposalCid,
      String factoryId,
      String poolId,
      String updateId,
      String error) {}

  public record Detail(
      String poolId,
      String name,
      Terms settings,
      String configId,
      String stateId,
      String packageId,
      Instant createdAt,
      Instant updatedAt) {}

  public record Pending(Proposal proposal, UUID commandId, long beginOffset) {}
}
