package com.openzeppelin.dex.liquidity;

import static com.openzeppelin.dex.liquidity.LiquidityModels.*;

import com.openzeppelin.dex.iam.Account;
import java.util.Optional;
import java.util.UUID;

public interface LiquidityLedger {
  long offset();

  void requireAccess(Account caller, String poolId);

  DepositQuote quoteDeposit(
      UUID quoteId, Account caller, String accessToken, DepositQuoteInput input);

  WithdrawalQuote quoteWithdrawal(
      UUID quoteId, Account caller, String accessToken, WithdrawalQuoteInput input);

  SigningPayload prepare(
      UUID requestId, UUID commandId, Account caller, String accessToken, Terms terms);

  void verify(SigningPayload signing, String signature, Account caller);

  Confirmation submit(Pending pending, Account caller, String accessToken);

  /** Evidence only: a missing transaction does not authorize replay or prove rejection. */
  Optional<Confirmation> recover(Pending pending);

  /** Observe settlement or direct allocation recovery, including while the backend was offline. */
  Optional<Confirmation> observe(Pending confirmedSubmission);

  SigningPayload prepareRecovery(
      UUID commandId, Request request, Account caller, String accessToken);

  Confirmation executeRecovery(Pending pending, Account caller, String accessToken);

  Positions positions(Account caller, String accessToken);

  final class Rejected extends RuntimeException {
    private final String code;

    public Rejected(String code, String message) {
      super(message);
      this.code = code;
    }

    public String code() {
      return code;
    }
  }
}
