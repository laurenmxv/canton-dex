package com.openzeppelin.dex.swaps;

import static com.openzeppelin.dex.swaps.SwapModels.*;

import com.openzeppelin.dex.iam.Account;
import java.util.*;

public interface SwapLedger {
  long offset();

  /** Validate ownership, pool eligibility/backing and exact decimal quote arithmetic. */
  Quote quote(UUID quoteId, Account caller, String accessToken, QuoteInput input);

  /**
   * Prepare one atomic request/allocation transaction, using commandId as ledger command identity.
   */
  SigningPayload prepare(
      UUID swapId, UUID commandId, Account caller, String accessToken, Terms terms);

  /** Verify wallet identity and signature locally before the durable submission claim. */
  void verify(SigningPayload signing, String signature, Account caller);

  Confirmation submit(Pending pending, Account caller, String accessToken);

  /** Read evidence only. Absence is not proof of rejection and must never cause blind replay. */
  Optional<Confirmation> recover(Pending pending);

  /**
   * Detect terminal settlement or direct wallet withdrawal, including while the backend was
   * offline.
   */
  Optional<Confirmation> observe(Pending confirmedSubmission);

  SigningPayload prepareWithdrawal(UUID commandId, Swap swap, Account caller, String accessToken);

  Confirmation withdraw(Pending pending, Account caller, String accessToken);
}
