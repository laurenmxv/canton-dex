package com.openzeppelin.dex.tokens;

import com.openzeppelin.dex.tokens.TokenModels.*;
import java.time.Instant;
import java.util.Optional;

public interface TokenLedger {
  final class Rejected extends RuntimeException {
    public Rejected(String message, Throwable cause) {
      super(message, cause);
    }
  }

  long ledgerEnd();

  Confirmation issueGrant(Claim claim, Signer signer);

  Optional<Confirmation> recoverGrant(Claim claim, Signer signer);

  Prepared prepareClaim(Claim claim, Signer signer, String callerToken, Instant expiresAt);

  Confirmation claim(Claim claim, Signer signer, String callerToken, String signature);

  Optional<Confirmation> recoverClaim(Claim claim, Signer signer);

  Balances balances(Signer signer, String callerToken);

  void verify(Claim claim, Signer signer, String signature);
}
