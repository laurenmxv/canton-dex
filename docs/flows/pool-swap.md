# Pool Swap

An approved `trader` requests a swap through the `PoolAccess` granted during [onboarding](onboarding.md); `venueOperator` later settles it using `dvo`'s authorization through `VenueDelegation`.

## `template VenueDelegation`

Lets the operator settle swaps with the pool authority's permission.

- **Signatory:** `dvo`.
- **Observer:** `venueOperator`.

| Choice | Controller | Action |
| --- | --- | --- |
| **`VenueDelegation_SettleBatch`** (nonconsuming) | `venueOperator`. | Rechecks each trader's access and KYC, then calls `Pool_Swap` with `dvo`'s authorization. |

## `template Pool`

Settles the batch against the current `PoolConfig` and `PoolState`.

- **Signatory:** `dvo`.
- **Observer:** `venueOperator`.

| Choice | Controller | Action |
| --- | --- | --- |
| **`Pool_Swap`** (nonconsuming) | `dvo` and `venueOperator`. | Prices each swap in order, checks `minOut` and the deadline, allocates the pool's legs, and settles both tokens through CIP-0112. |
| **`PoolAccess_RecoverAllocations`** (nonconsuming) | `trader`. | Checks current access and KYC; calls `Allocation_Withdraw` to recover unsettled allocations after `settlementDeadline`. |

`minOut` is signed in the input allocation metadata. The input reserves the swap amount; the output authorizes receipt. Both start without transfer legs, which settlement supplies in full after checking the minimum.

The transfers, one `SwapReceipt` per swap, and one replacement `PoolState` for the batch commit atomically.

## `template SwapReceipt`

Records the settled terms, actual output, allocations, and batch reference.

- **Signatories:** `dvo` and `venueOperator`.
- **Observer:** `trader`.

Diagram source: [pool-swap.puml](pool-swap.puml). The DEX app renders it under Dev -> Docs -> Daml flows.
