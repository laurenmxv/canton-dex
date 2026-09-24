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
| `POST /v1/swaps/quote` | `TRADER` | Check pool readiness, current KYC and pool access, and input balance -> quote output, fees, and expiry. | - |
| `POST /v1/swaps/prepare` | `TRADER` | Validate quote, input, `minOut`, and deadline -> prepare input and receipt allocations -> persist the request and signing payload. | - |
| `POST /v1/swaps/submit` | `TRADER` | Validate the wallet signature and current access -> execute the stored prepared transaction -> mark `READY` from confirmed allocations. | Lock input and create an unfunded output receipt allocation at token registries. |
| `GET /v1/swaps/{swapId}` | `TRADER` | Return the caller's swap and cancellation status, expected and settled amounts, deadline, and `canWithdraw`. | - |
| `POST /v1/swaps/{swapId}/cancel/prepare` | `TRADER` | Check ownership, current KYC and pool access, ledger status, and elapsed settlement deadline -> prepare withdrawals for remaining allocations. | - |
| `POST /v1/swaps/{swapId}/cancel/submit` | `TRADER` | Validate the wallet signature and current access -> execute the stored withdrawal transaction -> mark `WITHDRAWN` once all remaining allocations are confirmed withdrawn. | Withdraw unsettled allocations after their deadlines and unlock funds. |

Swap and liquidity submission endpoints, including cancellation, accept
`preparationId` and `signature`; the prepared transaction stays in the backend.
Uncertain submissions are reconciled from ledger evidence without resubmitting.

## Settlement

| Endpoint | Required role | Backend process | Ledger action |
| --- | --- | --- | --- |
| `GET /v1/admin/settlement-requests` | `OPERATOR` | Require `poolId`; default `status=READY` lists non-deferred ready requests. `status=active` includes other queue states and deferred requests. | - |
| `GET /v1/admin/settlements` | `OPERATOR` | List the latest 100 settlement attempts and results, optionally filtered by `poolId`. | - |
| `POST /v1/admin/pools/{poolId}/settlements` | `OPERATOR` | Dispatch the previewed batch or individual request; without a selection, choose an eligible FIFO batch. Record outcomes. | Atomically settle transfers and LP minting or burning through `dvo` delegation; update reserves and LP supply and enforce limits and deadlines. |
| `GET /v1/admin/pools/{poolId}/settlement-policy/{type}` | `OPERATOR` | Read one queue's automatic mode, batch size and policy version (`swap`, `deposit`, `withdraw`). | - |
| `PUT /v1/admin/pools/{poolId}/settlement-policy/{type}` | `OPERATOR` | Save `automaticEnabled` and `batchSize` using `expectedVersion`. Other queue policies remain unchanged. | - |
| `GET /v1/admin/settlements/{settlementId}` | `OPERATOR` | Return settlement status, request references, fills, and any batch error. | - |
| `GET /v1/admin/pools/{poolId}/settlement-preview` | `OPERATOR` | Require `type` (`swap`, `deposit`, `withdraw`); project the queue's next batch, a rejected/cancelled attempt (`retryOf`), or one eligible request (`requestId`) against current reserves. | Read allocations, access and pool state; apply the settlement preflight checks. |
| `PUT /v1/admin/pools/{poolId}/settlement-requests/{type}/{requestId}/deferred` | `OPERATOR` | Set `deferred` for an unexpired `READY` or `BLOCKED` request; returning it places it at the end of its queue. Requires no active settlement for the pool. | No token movement; original allocation deadlines remain. |
| `GET /v1/admin/pools/{poolId}/settlement-history` | `OPERATOR` | Page through attempts with optional `type` and `status` filters; use `limit` (default 25, 1–100) and pass the returned `nextCursor` as `before`. | - |


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

Manual dispatch requires a UUID `idempotencyKey` and can carry the exact preview
`selection`: request references, `type`, `retryOf`, `stateVersion` and `policyVersion`.
Admission and dispatch reject a stale selection.
Changing another queue's settings does not invalidate it.
Explicit selections and automatic swap batches must pass preflight in full;
manual runs without a selection and automatic liquidity runs can keep a valid FIFO prefix.
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
| `POST /v1/lp/deposit/quote` | `TRADER` | Check pool readiness, current KYC and pool access, balances, and amount limits -> quote base and quote amounts, refunds, expected LP tokens, `minLpOut`, ratio bounds from slippage tolerance, and expiry. Use the DVO's initial ratio for an empty pool or the current reserve ratio otherwise. | - |
| `POST /v1/lp/deposit/prepare` | `TRADER` | Validate quote, deposits, `minLpOut`, `minRatio`, `maxRatio`, and deadline -> prepare base and quote deposit allocations and an LP receipt allocation -> persist the request and signing payload. | - |
| `POST /v1/lp/deposit/submit` | `TRADER` | Validate the wallet signature and current access -> execute the stored prepared transaction -> mark `READY` from confirmed allocations. | Lock base and quote deposits through two registry allocations; create an unfunded LP receipt allocation. |
| `GET /v1/lp/deposit/{requestId}` | `TRADER` | Return the caller's request status, expected and minted LP tokens, deadline, and `canRecover`. | - |
| `POST /v1/lp/deposit/{requestId}/cancel/{prepare,submit}` | `TRADER` | Check ownership, current KYC and pool access, and elapsed deadline -> prepare and submit recovery of remaining allocations. | Withdraw pending base, quote and LP receipt allocations. |
| `GET /v1/lp/positions` | `TRADER` | Return user LP balances, pool shares, and redemption values from balances, reserves, and supply. | - |
| `POST /v1/lp/withdraw/quote` | `TRADER` | Check LP ownership and available balance -> quote both asset payouts and expiry; current KYC and pool access are required. | - |
| `POST /v1/lp/withdraw/prepare` | `TRADER` | Validate quote, LP amount, `minBaseOut`, `minQuoteOut`, and deadline -> prepare LP and asset receipt allocations -> persist the request and signing payload. | - |
| `POST /v1/lp/withdraw/submit` | `TRADER` | Validate the wallet signature and current access -> execute the stored prepared transaction -> mark `READY` from confirmed allocations. | Lock LP tokens and authorize asset receipt through registry allocations. |
| `GET /v1/lp/withdraw/{requestId}` | `TRADER` | Return the caller's request status, expected and paid amounts, deadline, and `canRecover`. | - |
| `POST /v1/lp/withdraw/{requestId}/cancel/{prepare,submit}` | `TRADER` | Check ownership, current KYC and pool access, and elapsed deadline -> prepare and submit recovery of remaining allocations. | Withdraw pending LP and asset receipt allocations. |

Amounts are decimal strings; instrument identity includes admin and ID. One V3
wallet signature authorizes all three allocations. Deposit quotes distinguish `INITIAL`
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
| `GET /v1/activity` | `TRADER` | Return the caller's stored requests with status and expected and settled amounts; choose `type=swap` (default), `deposit`, `withdraw` or `all`, optionally filter by `status`, and paginate with `limit` (default 50, 1–100) and `cursor`. | - |

Responses contain `items` and `nextCursor`, ordered newest first. Single-type
items are request records; `type=all` wraps each record as `{ type, request, deferred }`.
Pass `nextCursor` as `cursor` for the next page.

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
