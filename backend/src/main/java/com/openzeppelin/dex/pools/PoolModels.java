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
      String dvv,
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
      for (String value :
          List.of(
              name,
              baseInstrumentId.admin(),
              baseInstrumentId.id(),
              quoteInstrumentId.admin(),
              quoteInstrumentId.id(),
              baseAccountId,
              quoteAccountId,
              lpTokenId))
        if (!value.equals(value.trim())
            || value.isBlank()
            || value.chars().anyMatch(Character::isISOControl))
          throw new IllegalArgumentException("Invalid pool identifier");
      var admins = options.instrumentAdmins().stream().map(Admin::partyId).toList();
      if (!admins.contains(baseInstrumentId.admin()) || !admins.contains(quoteInstrumentId.admin()))
        throw new IllegalArgumentException("Unknown instrument administrator");
      if (baseInstrumentId.equals(quoteInstrumentId))
        throw new IllegalArgumentException("Instruments must differ");
      BigDecimal fee = decimal(feeBps);
      if (fee.signum() < 0 || fee.compareTo(new BigDecimal("10000")) >= 0)
        throw new IllegalArgumentException("Invalid fee");
      for (String value : List.of(baseReserve, quoteReserve, lpTokenSupply))
        if (decimal(value).signum() <= 0)
          throw new IllegalArgumentException("Initial amounts must be positive");
      return new Terms(
          options.dvv(),
          baseInstrumentId,
          quoteInstrumentId,
          new ReserveAccount(options.dvv(), null, baseAccountId),
          new ReserveAccount(options.dvv(), null, quoteAccountId),
          new Instrument(options.dvv(), lpTokenId),
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

  public record Admin(String partyId, String label) {}

  public record Options(
      String factoryId, String dvv, String venueOperator, List<Admin> instrumentAdmins) {}

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
