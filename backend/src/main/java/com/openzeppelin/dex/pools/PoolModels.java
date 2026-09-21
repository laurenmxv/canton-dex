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
      String lpTokenSupply) {
    public String pairKey() {
      var identities =
          new ArrayList<>(
              List.of(
                  baseInstrumentId.admin() + "\n" + baseInstrumentId.id(),
                  quoteInstrumentId.admin() + "\n" + quoteInstrumentId.id()));
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
  }

  public record Create(
      @NotBlank @Size(max = 120) String name,
      @NotNull @Valid Instrument baseInstrumentId,
      @NotNull @Valid Instrument quoteInstrumentId,
      @NotBlank @Size(max = 128) String baseAccountId,
      @NotBlank @Size(max = 128) String quoteAccountId,
      @NotBlank @Size(max = 128) String lpTokenId,
      @NotNull String feeBps,
      @NotNull String baseReserve,
      @NotNull String quoteReserve,
      @NotNull String lpTokenSupply) {
    public Terms terms(Options options) {
      // Both parts of an instrument are checked here too, and not only against
      // the catalogue: pairKey joins them with a newline, so a newline inside
      // either part would let two different pairs key the same claim.
      for (String value :
          List.of(
              name,
              baseAccountId,
              quoteAccountId,
              lpTokenId,
              baseInstrumentId.admin(),
              baseInstrumentId.id(),
              quoteInstrumentId.admin(),
              quoteInstrumentId.id()))
        if (!value.equals(value.trim())
            || value.isBlank()
            || value.chars().anyMatch(Character::isISOControl))
          throw new IllegalArgumentException("Invalid pool identifier");
      // An instrument is its administrator and that administrator's own
      // identifier together, so both parts have to name a registered one.
      var registered =
          options.instruments().stream().map(RegisteredInstrument::instrument).toList();
      if (!registered.contains(baseInstrumentId))
        throw new IllegalArgumentException("The venue does not register the base instrument");
      if (!registered.contains(quoteInstrumentId))
        throw new IllegalArgumentException("The venue does not register the quote instrument");
      if (baseInstrumentId.equals(quoteInstrumentId))
        throw new IllegalArgumentException("Instruments must differ");
      BigDecimal fee = decimal(feeBps);
      if (fee.signum() < 0 || fee.compareTo(new BigDecimal("10000")) >= 0)
        throw new IllegalArgumentException("Invalid fee");
      for (String value : List.of(baseReserve, quoteReserve, lpTokenSupply))
        if (decimal(value).signum() <= 0)
          throw new IllegalArgumentException("Initial amounts must be positive");
      return new Terms(
          options.dvo(),
          baseInstrumentId,
          quoteInstrumentId,
          new ReserveAccount(options.dvo(), null, baseAccountId),
          new ReserveAccount(options.dvo(), null, quoteAccountId),
          new Instrument(options.dvo(), lpTokenId),
          feeBps,
          baseReserve,
          quoteReserve,
          lpTokenSupply);
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
      Terms settings,
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
