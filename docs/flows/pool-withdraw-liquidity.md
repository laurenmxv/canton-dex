# Pool Withdraw Liquidity

A `trader` redeems LP tokens for proportional base and quote reserves. Withdrawal requires current KYC and `PoolAccess`.

## Request

| Choice | Controller | Action |
| --- | --- | --- |
| **`PoolAccess_RequestLiquidityWithdrawal`** on `PoolAccess` (nonconsuming) | `trader`. | Locks LP tokens for burning and authorizes receipt of base and quote through three CIP-0112 allocations. |

Returns a **`WithdrawalRequest` record** with the trader, pool, allocation IDs and signed terms: LP amount, `minBaseOut`, `minQuoteOut` and `settlementDeadline`.

## Settlement

| Choice | Controller | Action |
| --- | --- | --- |
| **`VenueDelegation_WithdrawLiquidity`** on `VenueDelegation` (nonconsuming) | `venueOperator`. | Rechecks each trader's access and KYC, then calls `Pool_WithdrawLiquidity` with `dvo`'s authorization. |
| **`Pool_WithdrawLiquidity`** on `Pool` (nonconsuming) | `dvo` and `venueOperator`. | Settles an ordered batch of LP burns and base/quote payouts atomically, checking each request's signed limits and deadline. |

The base and quote receipt allocations carry their minimum outputs in metadata and start without transfer legs. Settlement checks these limits and supplies both full payouts; the LP burn amount is fixed at request time.

Each payout is `LP amount × reserve / total LP supply`, rounded down to the asset's precision. Only circulating LP can be redeemed: the permanent `0.0000001` LP minimum and its backing remain.

Each withdrawal uses the updated reserves, supply and holding IDs from the previous withdrawal. Settlement consolidates the remaining reserves, creates one **`LiquidityReceipt`** per request with its `LiquidityWithdrawn` outcome, and replaces `PoolState` once. If any request fails, the whole batch rolls back.

- **Receipt signatories:** `dvo` and `venueOperator`.
- **Receipt observer:** `trader`.

## Optional recovery

After `settlementDeadline`, a trader with current access and KYC can exercise **`PoolAccess_RecoverAllocations`** on `PoolAccess`. **`Allocation_Withdraw`** returns any still-allocated LP tokens and closes the remaining receipt authorizations. Allocations already withdrawn directly are omitted.

Diagram source: [pool-withdraw-liquidity.puml](pool-withdraw-liquidity.puml). The DEX app renders it under Dev -> Docs -> Daml flows.
