# Pool Creation

## `template PoolProposal`

Stores `venueOperator`'s proposed pool settings and factory reference for `dvo` to accept or reject.

- **Signatory:** `venueOperator`.
- **Observer:** `settings.dvo`.

| Choice | Controller | Action |
| --- | --- | --- |
| **`PoolProposal_Accept`** | `settings.dvo`. | Consumes the proposal, checks the matching factory, and calls `PoolFactory_CreatePool` with the proposed settings. |
| **`PoolProposal_Reject`** | `settings.dvo`. | Consumes the proposal without creating a pool. |
| **`PoolProposal_Withdraw`** | `venueOperator`. | Consumes the proposal without creating a pool. |

## `template PoolFactory`

Creates pools authorized by `dvo`, with their configuration and initial state.

- **Signatory:** `dvo`.
- **Observer:** `venueOperator`.

| Choice | Controller | Action |
| --- | --- | --- |
| **`PoolFactory_ProposePool`** (nonconsuming) | `venueOperator`. | Validates settings and creates `PoolProposal` for `dvo`. |
| **`PoolFactory_CreatePool`** (nonconsuming) | `dvo`. | Validates settings and creates `Pool`, `PoolConfig`, and `PoolState` atomically. |

`dvo` can also call `PoolFactory_CreatePool` directly, without a proposal.

The backend submits proposals and withdrawals as `venueOperator` and tracks confirmed ledger outcomes. `dvo` accepts or rejects proposals.

![Pool creation flow](images/pool-creation.png)
