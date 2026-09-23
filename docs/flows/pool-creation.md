# Pool Creation

`venueOperator` proposes the pool's tokens, factories and fee; `dvo` approves it and sets the initial ratio (quote units per base unit).

## `template PoolProposal`

Stores the proposed settings and factory reference.

- **Signatories:** `venueOperator`; also `settings.dvo` when accepted.
- **Observer:** `settings.dvo`.

| Choice | Controller | Action |
| --- | --- | --- |
| **`PoolProposal_Accept`** | `settings.dvo`. | Consumes the pending proposal, creates its accepted successor with the initial ratio, and calls `PoolFactory_CreatePool`. |
| **`PoolProposal_Reject`** | `settings.dvo`. | Consumes a pending proposal. |
| **`PoolProposal_Withdraw`** | `venueOperator`. | Consumes a pending proposal. |

## `template PoolFactory`

- **Signatory:** `dvo`.
- **Observer:** `venueOperator`.

| Choice | Controller | Action |
| --- | --- | --- |
| **`PoolFactory_ProposePool`** (nonconsuming) | `venueOperator`. | Validates settings and creates a pending `PoolProposal`. |
| **`PoolFactory_CreatePool`** (nonconsuming) | `dvo` and `venueOperator`, through `PoolProposal_Accept`. | Validates and archives the accepted proposal; creates `Pool`, `PoolConfig` and `PoolState` atomically. |

![Pool creation flow](images/pool-creation.png)

## Created pool contracts

### `template Pool`

Fixes the base, quote and LP instruments, their precision and CIP-0112 factories. The approved proposal's `poolId` determines the LP instrument ID (`lp:<poolId>`) and both reserve account IDs.

`baseAccount` and `quoteAccount` have `dvo` as owner and `venueOperator` as provider. Base and quote retain their token issuers as admins; the LP instrument has `dvo` as admin and 10 decimals.

- **Signatory:** `dvo`.
- **Observer:** `venueOperator`.
- **Lifecycle:** Remains active across settlements and configuration changes.

| Choice | Controller | Action |
| --- | --- | --- |
| **`Pool_Swap`** (nonconsuming) | `dvo` and `venueOperator`. | Settles a [swap batch](pool-swap.md) and replaces `PoolState`. |
| **`Pool_AddLiquidity`** (nonconsuming) | `dvo` and `venueOperator`. | Settles [deposits](pool-provide-liquidity.md), mints LP tokens and replaces `PoolState`. |
| **`Pool_WithdrawLiquidity`** (nonconsuming) | `dvo` and `venueOperator`. | Settles [LP redemption](pool-withdraw-liquidity.md), burns LP tokens and replaces `PoolState`. |

`VenueDelegation` supplies `dvo`'s authorization when `venueOperator` settles swaps or liquidity.

### `template PoolConfig`

Stores the swap fee and initial ratio.

- **Signatory:** `dvo`.
- **Observer:** `venueOperator`.

| Choice | Controller | Action |
| --- | --- | --- |
| **`PoolConfig_Update`** | `dvo`. | Replaces the configuration with a new fee, preserving the initial ratio. |

### `template PoolState`

Tracks reserves, their backing holding IDs and total LP supply. All amounts start at zero, with no holdings. The first [settled deposit](pool-provide-liquidity.md) creates the reserve holdings.

- **Signatory:** `dvo`.
- **Observer:** `venueOperator`.
- **Lifecycle:** Replaced once per swap batch or liquidity settlement.
