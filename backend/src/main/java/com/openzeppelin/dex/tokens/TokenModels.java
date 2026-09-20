package com.openzeppelin.dex.tokens;

import com.openzeppelin.dex.onboarding.Onboarding;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class TokenModels {
  private TokenModels() {}

  public record Instrument(String admin, String id) {}

  public record Amount(Instrument instrument, String symbol, int decimals, String amount) {}

  public record Balance(
      Instrument instrument,
      String symbol,
      int decimals,
      String available,
      String locked,
      String total) {}

  public record Balances(List<Balance> balances, long asOfOffset) {
    public Balances {
      balances = List.copyOf(balances);
    }
  }

  public record Registry(
      String issuerPartyId,
      String rulesId,
      String packageId,
      String faucetFactoryId,
      String rulesCreatedEventBlob,
      String synchronizerId) {}

  public record Token(String symbol, String instrumentId, int decimals, String initialClaimAmount) {
    public Amount amount(String issuer) {
      return new Amount(new Instrument(issuer, instrumentId), symbol, decimals, initialClaimAmount);
    }
  }

  public record Signer(String userId, Onboarding.PartyPreparation party) {}

  public enum Status {
    AVAILABLE,
    PREPARED,
    SUBMITTING,
    UNRESOLVED,
    COMPLETED
  }

  public enum GrantStatus {
    PENDING,
    SUBMITTING,
    UNRESOLVED,
    CONFIRMED
  }

  public record Result(Status status, String updateId, String errorCode, String error) {}

  public record Preparation(
      UUID preparationId,
      String preparedTransactionHash,
      String hashEncoding,
      int hashingSchemeVersion,
      String partyId,
      String publicKeyFingerprint,
      Instant expiresAt,
      List<Amount> amounts) {
    public Preparation {
      amounts = List.copyOf(amounts);
    }
  }

  public record Submission(@NotNull UUID preparationId, @NotBlank String signature) {}

  public record Prepared(
      String preparedTransaction,
      String preparedTransactionHash,
      int hashingSchemeVersion,
      Instant expiresAt) {}

  public record Confirmation(String contractId, String updateId) {}

  public record Claim(
      UUID accountId,
      UUID grantId,
      UUID grantCommandId,
      String grantCid,
      Long grantBeginOffset,
      GrantStatus grantStatus,
      UUID preparationId,
      Prepared prepared,
      Long claimBeginOffset,
      Status status,
      String updateId,
      String errorCode,
      String error) {
    public Claim submittingAt(long offset) {
      return new Claim(
          accountId,
          grantId,
          grantCommandId,
          grantCid,
          grantBeginOffset,
          grantStatus,
          preparationId,
          prepared,
          offset,
          Status.SUBMITTING,
          null,
          null,
          null);
    }

    public Result result() {
      var visibleStatus =
          grantStatus == GrantStatus.SUBMITTING
              ? Status.SUBMITTING
              : grantStatus == GrantStatus.UNRESOLVED ? Status.UNRESOLVED : status;
      return new Result(visibleStatus, updateId, errorCode, error);
    }

    public Preparation preparation(Signer signer, List<Amount> amounts) {
      return new Preparation(
          preparationId,
          prepared.preparedTransactionHash(),
          "base64",
          prepared.hashingSchemeVersion(),
          signer.party().partyId(),
          signer.party().publicKeyFingerprint(),
          prepared.expiresAt(),
          amounts);
    }
  }
}
