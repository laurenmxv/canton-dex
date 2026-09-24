# DEX backend spec

Backend roles authorize API access. Ledger operations also require the indicated
Canton party's authorization. `dvo` signs pools, owns their reserve accounts,
and administers their LP-token instruments; `venueOperator` represents `vo`.
The `venue_operator` role does not grant authority to act as `dvo`.

## Onboarding

| Endpoint | Required role | Backend process | Ledger action |
| --- | --- | --- | --- |
| `POST /v1/onboardings` | `venue_user` | Store personal information and KYC documents -> request operator approval for pool access. | - |
| `GET /v1/onboardings/{onboardingId}` | `venue_user` (own request) or `venue_operator` | Return personal information and KYC documents, onboarding progress, review and attestation status, and missing hosting, synchronizer, or package requirements. | - |
| `GET /v1/admin/onboardings` | `venue_operator` | List requests and KYC results by review or setup status. | - |
| `POST /v1/admin/onboardings/{onboardingId}/review` | `venue_operator` | Record KYC findings and approval or rejection -> submit the attestation through the authorized participant once approved and party setup is ready. | Issue an authorized attestation once approved, bound, and ready. |
| `POST /v1/onboardings/{onboardingId}/party/prepare` | `venue_user` | Prepare wallet proof for an existing party or external-party registration with wallet public keys. | - |
| `POST /v1/onboardings/{onboardingId}/party/submit` | `venue_user` | Validate payload structure and wallet proof or signatures against the account's prepared request -> link or register the party -> check hosting, synchronizer, and packages. | New parties only: register external-party hosting and wallet public keys through Canton topology. |

`venue_user` accounts must complete onboarding before using the endpoints below.

## Pool Creation

| Endpoint | Required role | Backend process | Ledger action |
| --- | --- | --- | --- |
| `POST /v1/admin/pool-proposals` | `venue_operator` | Validate pair, registries, settings, and duplicates -> submit as the operator through participant -> track proposal status. | Record fixed pool settings and the factory reference for `dvo` acceptance. |
| `GET /v1/admin/pool-proposals` | `venue_operator` | List proposals by pending, created, rejected, or withdrawn status. | - |
| `GET /v1/admin/pool-proposals/{proposalId}` | `venue_operator` | Return fixed settings, required `dvo` authority, proposal status, and confirmed pool ID after acceptance. | - |
| `POST /v1/admin/pools` | `venue_operator` | Validate `dvo` authorization for the selected proposal -> relay acceptance through participant -> record confirmed pool. | Consume the proposal and create Pool, PoolConfig, and PoolState atomically through the matching factory; `dvo` is the sole signatory and the operator is an observer. |

Acceptance and creation are one transaction; there is no approved proposal
awaiting finalization. Rejection by `dvo` or withdrawal by the operator consumes
the proposal without creating a pool. Direct creation through the factory also
requires `dvo` authorization.

## Pool Discovery

| Endpoint | Required role | Backend process | Ledger action |
| --- | --- | --- | --- |
| `GET /v1/pools` | `venue_user` or `venue_operator` | Return cached public pools, pairs, prices, liquidity, fees, and earnings for both roles. | - |
| `GET /v1/pools/{poolId}` | `venue_user` or `venue_operator` | Return cached public details, plus permitted party-specific eligibility and disclosure status. | - |

## Swaps

| Endpoint | Required role | Backend process | Ledger action |
| --- | --- | --- | --- |
| `POST /v1/swaps/quote` | `venue_user` | Check intake, eligibility, and pool -> quote output, fees, and expiry. | - |
| `POST /v1/swaps/prepare` | `venue_user` | Validate quote, input, `minOut`, and deadline -> prepare input and receipt allocations. | - |
| `POST /v1/swaps/submit` | `venue_user` | Validate transaction structure and wallet signatures against the prepared request -> store request -> submit unchanged -> mark ready after confirmations and screening. | Lock input and create an unfunded output receipt allocation at token registries. |
| `GET /v1/swaps/{swapId}` | `venue_user` | Return swap and cancellation status, expected and settled amounts, and deadline. | - |
| `POST /v1/swaps/{swapId}/cancel/prepare` | `venue_user` | Check ownership, ledger status, and elapsed settlement deadline -> prepare withdrawals for remaining allocations. | - |
| `POST /v1/swaps/{swapId}/cancel/submit` | `venue_user` | Validate transaction structure and wallet signatures against the prepared request -> submit unchanged -> confirm cancellation once all remaining allocations are withdrawn. | Withdraw unsettled allocations after their deadlines and unlock funds. |


## Settlement

| Endpoint | Required role | Backend process | Ledger action |
| --- | --- | --- | --- |
| `GET /v1/admin/settlement-requests` | `venue_operator` | List ready swap and liquidity requests by pool. | - |
| `GET /v1/admin/settlements` | `venue_operator` | List submitted settlements and results. | - |
| `POST /v1/admin/pools/{poolId}/settlements` | `venue_operator` | Dispatch the previewed batch or individual request; without a selection, choose a ready FIFO batch. Record outcomes. | Atomically settle transfers and LP minting or burning through `dvo` delegation; update reserves and LP supply and enforce limits and deadlines. |
| `GET /v1/admin/pools/{poolId}/settlement-policy/{type}` | `venue_operator` | Read one queue's automatic mode, batch size and policy version (`swap`, `deposit`, `withdraw`). | - |
| `PUT /v1/admin/pools/{poolId}/settlement-policy/{type}` | `venue_operator` | Save that queue's settings using its expected version. Other queue policies remain unchanged. | - |
| `GET /v1/admin/settlements/{settlementId}` | `venue_operator` | Return settlement status and per-request results or failures. | - |
| `GET /v1/admin/pools/{poolId}/settlement-preview` | `venue_operator` | Project a queue's next batch, a rejected/cancelled attempt (`retryOf`), or one eligible request (`requestId`) against current reserves. | Read allocations, access and pool state; apply the settlement preflight checks. |
| `PUT /v1/admin/pools/{poolId}/settlement-requests/{type}/{requestId}/deferred` | `venue_operator` | Defer a ready request or return it to the end of its queue. | No token movement; original allocation deadlines remain. |
| `GET /v1/admin/pools/{poolId}/settlement-history` | `venue_operator` | Page through attempts, filtered by request type or batch status. | - |


Each pool has three independent FIFO queues: swaps, deposits and withdrawals.
Blocked requests hold only their own family. A persisted
round-robin selects an eligible family; swaps, proportional deposits and withdrawals form batches
up to their own configured size. Each queue has an independent automatic switch and policy version.
Automatic swaps wait for their own batch size; manual runs can settle a smaller prefix.
Initial funding settles individually.
Liquidity preflight advances reserves and LP supply for each request; automatic
liquidity settlements send the valid FIFO prefix without waiting to fill the batch. Each batch
replaces `PoolState` once and confirms each request from its own receipt.
The operator preview reports each projected reserve/supply change and output margin,
stopping at the first blocked request. Later requests remain unevaluated. It is an
estimate from the reported pool state, not confirmation of token movement.

Manual dispatch can carry the exact preview selection: request IDs, pool/config
version and the selected queue's policy version. Admission and dispatch reject a stale selection.
Changing another queue's settings does not invalidate it.
An operator can select one eligible request anywhere in its queue and run it as a
singleton batch. This preserves the queue policy and leaves other requests pending.
Deferred requests must first return to the queue. `requestId` and `retryOf` are mutually exclusive.
An uncertain response must reuse the original idempotency key and selection.
Retries create a new attempt linked by `retryOf`; submitted or unresolved attempts
must reconcile first. Deferred requests stay outside automatic selection until an
operator returns them to the queue. Deferral does not release allocations or extend
their deadlines; expired requests need the trader's recovery flow.

One executor per pool protects the shared reserves and
reconciles any uncertain settlement before submitting another. The existing
scheduler considers only queues with automation enabled, using each queue's policy.

## Provide Liquidity

| Endpoint | Required role | Backend process | Ledger action |
| --- | --- | --- | --- |
| `POST /v1/lp/deposit/quote` | `venue_user` | Check intake, eligibility, balances, and amount limits -> quote proportional base and quote amounts, expected LP tokens, `minLpOut` from slippage tolerance, and expiry. Use the DVO's initial ratio for an empty pool or the current reserve ratio otherwise. | - |
| `POST /v1/lp/deposit/prepare` | `venue_user` | Validate quote, deposits, minimum LP output, and deadline -> prepare base and quote deposit allocations and an LP receipt allocation. | - |
| `POST /v1/lp/deposit/submit` | `venue_user` | Validate transaction structure and wallet signatures against the prepared request -> store deposit request -> submit unchanged -> mark ready after confirmations and screening. | Lock base and quote deposits through two registry allocations; create an unfunded LP receipt allocation. |
| `GET /v1/lp/deposit/{depositId}` | `venue_user` | Return status, expected and minted LP tokens, and deadline. | - |
| `POST /v1/lp/deposit/{depositId}/cancel/{prepare,submit}` | `venue_user` | Check ownership and elapsed deadline -> prepare and submit recovery of remaining allocations. | Withdraw pending base, quote and LP receipt allocations. |
| `GET /v1/lp/positions` | `venue_user` | Return user LP balances, pool shares, and redemption values from balances, reserves, and supply. | - |
| `POST /v1/lp/withdraw/quote` | `venue_user` | Check LP ownership and available balance -> quote both asset payouts and expiry; current KYC and pool access are required. | - |
| `POST /v1/lp/withdraw/prepare` | `venue_user` | Validate quote, LP amount, payouts, and deadline -> prepare LP and asset receipt allocations. | - |
| `POST /v1/lp/withdraw/submit` | `venue_user` | Validate transaction structure and wallet signatures against the prepared request -> store withdrawal request -> submit unchanged -> mark ready after confirmations and screening. | Lock LP tokens and authorize asset receipt through registry allocations. |
| `GET /v1/lp/withdraw/{withdrawalId}` | `venue_user` | Return status, expected and paid amounts, and deadline. | - |
| `POST /v1/lp/withdraw/{withdrawalId}/cancel/{prepare,submit}` | `venue_user` | Check ownership and elapsed deadline -> prepare and submit recovery of remaining allocations. | Withdraw pending LP and asset receipt allocations. |

Amounts are decimal strings; instrument identity includes admin and ID. One V3
wallet signature authorizes all three allocations. Quotes distinguish `INITIAL`
from `PROPORTIONAL`, include signed limits, and keep estimates separate from
confirmed results. `stateId` identifies the quoted state without locking settlement
to that contract. Initial quotes expose the permanent `initialMinimumLp`.

LP math uses exact integer units, including an integer square root for initial
supply. The pinned LF 2.3 target does not support `BigNumeric`: Daml uses
`Numeric 0`/`Numeric 20` with overflow rejection, and the backend enforces the same bounds.

Positions come from actual LP holdings, current reserves and supply. `EXPIRED`
means recovery is available, not that funds were unlocked. `RECOVERED` requires
ledger evidence; recovery lists only pending allocations and distinguishes returned
funds from released receipt permissions. It requires current KYC and pool access.

## Allocation terms

Variable transfers use iterated CIP-0112 allocations with no initial transfer
legs. Inputs reserve their exact spending budget in `nextIterationFunding`;
receipt permissions use an empty funding map. Signed minima live in metadata:

| Minimum | Allocation | Metadata key |
| --- | --- | --- |
| Swap output | Swap input | `dex.reference.openzeppelin.com/min-out-amount` |
| LP minted | LP receipt | `dex.reference.openzeppelin.com/min-lp-out-amount` |
| Base redeemed | Base receipt | `dex.reference.openzeppelin.com/min-base-out-amount` |
| Quote redeemed | Quote receipt | `dex.reference.openzeppelin.com/min-quote-out-amount` |

Values are plain decimal strings without trailing fractional zeros (`0`, `1`,
`0.5`). Both Daml and backend validation require the exact signed metadata and
funding. Settlement checks the limits, supplies the full transfer legs, and
closes allocations with `nextIterationFunding = None`; unused deposit funding
returns to the trader. Fixed pool swap legs and issuer mint/burn allocations
remain non-iterated. The DEX requires synchronous iterated settlement, but not
support for mixing initial legs with iteration funding.

## Activity and History

| Endpoint | Required role | Backend process | Ledger action |
| --- | --- | --- | --- |
| `GET /v1/activity` | `venue_user` | Return cached user swaps, deposits, and withdrawals with status and expected and settled amounts; filter by `type=swap`, `deposit`, `withdraw` or `all` and status and paginate with `limit` and `cursor`. | - |


## Venue Monitoring and Management

| Endpoint | Required role | Backend process | Ledger action |
| --- | --- | --- | --- |
| `GET /v1/admin/monitoring` | `venue_operator` | Return authorized activity, metrics, treasury balances, traffic, and reward status. | - |
| `GET /v1/admin/treasury` | `venue_operator` | Return funding settings, balances, and operation status. | - |
| `PUT /v1/admin/treasury` | `venue_operator` | Save funding settings -> configure treasury-authorized top-ups and intake thresholds. | Automation purchases traffic through Splice contracts. |
| `GET /v1/admin/rewards` | `venue_operator` | Return settings, Scan-based calculations, provider approvals, collection status, and expiry alerts. | - |
| `PUT /v1/admin/rewards` | `venue_operator` | Save sharing and collection settings -> obtain provider authorization -> coordinate wallet collection and track changes. | Automation collects CC app rewards through Splice contracts. |


## Authority Management

| Endpoint | Required role | Backend process | Ledger action |
| --- | --- | --- | --- |
| `GET /v1/admin/authority` | `venue_operator` | Return authorized on-ledger assignments and pending and completed changes by ID. | - |
| `POST /v1/admin/role-changes` | `venue_operator` | Check admin scope, role, action, and parties -> submit change through participant -> update confirmed assignments. | Grant, revoke, or transfer roles under required authority. |
