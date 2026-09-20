# Token integration

The DEX consumes CIP-0112 through the Splice `Holding`, `AllocationFactory`,
`Allocation` and `SettlementFactory` interfaces. Issuers supply token contracts;
the DEX supplies the pool, swap request, price, minimum-output checks and atomic
batch execution. The token contracts do not import or know the DEX.

## Packages

- `contracts/` builds `canton-dex-ri` against the standard API DARs.
- `contracts/test-faucet/` builds `canton-dex-test-faucet`, which consumes the
  original OpenZeppelin test-token DAR for development minting.
- `contracts/tests/` holds Daml Script tests and is not deployed.
- `contracts/dars/manifest.yaml` pins vendored artifact identities and checksums.

`Lib/Tokens.daml` contains the standard operations shared by pool funding and
swap settlement. It contains no OpenZeppelin template casts or issuer-specific
rules. Allocation and settlement factories may have different contract IDs.

## Registry configuration

The backend stores issuer registration in `token_registries`, instrument
metadata in `token_instruments`, and local factory disclosures in
`token_registry_contracts`. The development bootstrap seeds these records for
the unmodified OZ token. Faucet configuration is separate from swap routing.

The runtime reads token balances and allocations through standard interface
views. Concrete token types are used only for development issuance. Operator
credentials do not gain issuer rights.

## Settlement scope

The trader signs `PoolAccess_RequestSwap`. It checks access and KYC, locks the
input through the token's allocation factory, creates a receipt allocation and
returns a `SwapRequest` record. The allocations bind the pool, trader, request
ID, exact input, minimum output and deadline. No separate intent contract is
needed to retain those signed terms.

The backend queues the confirmed record by pool. `VenueDelegation_SettleBatch`
rechecks access and authorizes `Pool_Swap`, which prices each request against the
reserves left by the preceding request. Settlement checks the record against the
signed allocations. The receipt's initial receiver leg fixes `minOut`; any
additional output uses a standard extra receiver leg. A zero minimum uses only
the extra leg. The batch settles both token legs and replaces `PoolState` once.
Any failure rolls back the entire batch. Only final settled results count as
swaps.

After the deadline, the trader can withdraw the allocations through
`Pool_WithdrawSwap` without current pool access or KYC. Standard token withdrawal
remains available independently.

This backend integration uses configured factories and empty `ExtraArgs`. It
supports allocations that complete, settle and withdraw synchronously, and
reserves represented by standard on-ledger holdings. Pending or non-final
results abort the transaction. Amounts use the Daml `Decimal` range (28 integer
digits and ten decimal places) and each token's configured precision. Pricing
uses exact integer atoms and rounds output down to that precision. Calculations
abort if an intermediate exceeds the native 38-digit numeric range.

The Daml choices accept independent `ExtraArgs` for each operation. The backend
does not yet resolve remote registry contexts or run asynchronous issuer
workflows. Pool allocations are created inside the batch, so issuers requiring
their future contract IDs before producing settlement context need a different
preparation flow. The current fixture validates this synchronous profile, not
universal support for every CIP-0112 implementation.

## Local development

Contract refactors use fresh local participant and application databases. Run
`./scripts/dex-reset.sh` from the repository root, then `make docker-run` to
rebuild and bootstrap the current DARs. The reset clears local ledger, Keycloak
and application data while retaining containers, volumes and build caches.
Traders sign in and repeat onboarding with their existing wallet keys.
Bootstrap rejects application pools
from another package generation; there are no compatibility migrations for
this disposable development data.

The local test issuer is `test-token-issuer-cip112`, with its own party and
service identity. Its instruments represent test USDC, BTC and ETH. Bootstrap
creates funded pools and persists each pool's batch policy in the application
database. Restarting does not replenish reserves or reset the policy.

Run `make test` for contracts and `make test-backend` for the authenticated
participant and backend integration scenarios. These tests use generated test
keys and do not require the browser wallet.
