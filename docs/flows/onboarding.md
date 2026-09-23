# Onboarding

## `template KycAttestation`

Records that a trader passed the operator's KYC checks for the listed pools.

- **Signatory:** `venueOperator`.
- **Observer:** `trader`.

## `template PoolAccess`

Gives an approved trader visibility of `PoolAccess` and authority to call its choices, following the [Vault Access pattern](https://github.com/Moonsong-Labs/canton-vaults/tree/main/patterns/01-vault-access).
This contract authorizes swaps, deposits, [liquidity withdrawals](pool-withdraw-liquidity.md) and expired-allocation recovery while access and KYC remain active.

- **Signatory:** `venueOperator`.
- **Observer:** `trader`.

| Choice | Controller | Action |
| --- | --- | --- |
| **`PoolAccess_RequestSwap`** (nonconsuming) | `trader`. | Validates KYC and pool access; creates swap input and receipt allocations. |
| **`PoolAccess_RequestLiquidityDeposit`** (nonconsuming) | `trader`. | Validates KYC and pool access; creates base and quote deposit allocations and an LP receipt allocation. |
| **`PoolAccess_RequestLiquidityWithdrawal`** (nonconsuming) | `trader`. | Validates KYC; locks LP and authorizes receipt of base and quote. |
| **`PoolAccess_RecoverAllocations`** (nonconsuming) | `trader`. | Validates KYC; recovers expired allocations belonging to this trader and pool. |

The backend confirms the party's registration before issuing `KycAttestation` and then one `PoolAccess` per approved pool, as `venueOperator`. Onboarding completes after all contracts are confirmed.

![Onboarding flow](images/onboarding.png)
