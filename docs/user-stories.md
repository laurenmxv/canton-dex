# DEX user stories

## Roles and parties

### Backend Roles
Roles define what a user can do in the app. These backend roles are assigned to user accounts.

- **`venue_user`**: an individual or organization registered with the venue that
  can swap assets and provide liquidity using its own wallet.
- **`venue_operator`**: an authorized member of the venue's operating organization
  who can administer pools within assigned permissions.

### Canton Parties

- **`dvo`**: the decentralized Canton party, independent of `venueOperator`, that governs the pools, owns their reserves, and administers their LP tokens.
- **`venueOperator`**: the venue operator that proposes pools, grants trader
  access, and settles swaps with permission from `dvo`.
- **`trader`**: the user's party that owns the tokens used to trade and
  authorizes swap requests.

### User, Role, and Party Mapping

| Backend role | Daml party field |
|---|---|
| `venue_user` | `trader` |
| `venue_operator` | `venueOperator` |

Example:

| Username | Backend role | Party hint | Party ID (example) | Daml party field |
|---|---|---|---|---|
| `alice` | `venue_user` | `alice` | `alice::1234...` | `trader` |
| `bob` | `venue_operator` | `venue_operator` | `venue_operator::5678...` | `venueOperator` |

## Layers

- **Frontend:** Presents data and collects user input.
- **Client:** Connects the frontend to backend APIs and the user's wallet.
- **Backend:** Checks access, coordinates workflows, and submits ledger
  transactions.
- **DAML:** Contract code that enforces permissions and rules and updates ledger
  state.

## Stories

### Onboarding

- **Request onboarding.** Can submit KYC information after account creation and,
  once approved, register a new external Canton party using their wallet.
  **(Required role: `venue_user`)**

  - **Frontend:** Collects KYC information and shows onboarding status and
    wallet registration controls.
  - **Client:** Submits requests, gets wallet approval to register the party,
    and fetches onboarding status.
  - **Backend:** Records requests from existing accounts and sends them for KYC
    review.
  - **DAML:** -

- **Onboard users.** Can approve or reject KYC requests and select
  the pools each approved user can access.
  **(Required role: `venue_operator`)**

  - **Frontend:** Shows requests, approval controls, party registration,
    and pool access status.
  - **Client:** Fetches onboarding requests and submits review decisions.
  - **Backend:** Registers parties with wallet approval and checks readiness
    before issuing KYC attestations and pool access.
  - **DAML:** Records KYC attestations and pool access authorized by the
    venue operator.

### Pool Creation

- **Request pool creation.** Can submit a pair, fee, and initial pool settings
  for `dvo` acceptance and track the proposal's status.
  **(Required role: `venue_operator`)**

  - **Frontend:** Collects pool settings and shows pending, created, rejected,
    or withdrawn proposals.
  - **Client:** Sends pool proposals to the backend and fetches proposal status.
  - **Backend:** Checks settings, submits proposals through the authorized participant,
    and tracks their ledger status.
  - **DAML:** Records the operator's proposal with fixed settings and a factory
    reference; allows `dvo` to reject it or the operator to withdraw it.

- **Track pool creation.** Can follow `dvo`'s decision and see when an accepted
  proposal becomes a pool.
  **(Required role: `venue_operator`)**

  - **Frontend:** Shows proposals awaiting `dvo` approval and their outcomes.
  - **Client:** Fetches proposal status and created pool details.
  - **Backend:** Detects `dvo` decisions on the ledger and records confirmed
    pools.
  - **DAML:** Consumes the proposal and creates Pool, PoolConfig, and PoolState
    atomically through the matching factory, with `dvo` as sole signatory and
    the operator as observer. `dvo` can also create directly through its factory.

  Pool funding and settlement authorization are separate from creation.

### Pool Discovery

- Can view available pools. Traders see their confirmed access; operators
  see all pool pairs, fees, reserves, and LP supply.
  **(Required role: `venue_user` or `venue_operator`)**

  - **Frontend:** Shows confirmed pool access to traders and details for all
    pools to operators.
  - **Client:** Lists pools and fetches pool details and the user's access status.
  - **Backend:** Returns the pool catalogue from the database and refreshes
    pool details from the ledger.
  - **DAML:** -

### Swaps

- **Request a swap.** Can choose a pool for the desired pair, enter an amount,
  and review a quote. Can approve the input amount, minimum output (`minOut`),
  and settlement deadline, then sign the request with their wallet and
  send the signature to the backend. **(Required role: `venue_user`)**

  - **Frontend:** Collects the pool and amount, shows the quote, and requests
    input, `minOut`, and deadline approval before wallet signing.
  - **Client:** Requests quotes and swap preparation, then sends the wallet
    signature to the backend.
  - **Backend:** Quotes swaps, prepares allocations, submits signed transactions,
    and stores requests in the internal database for later settlement.
  - **DAML:** Creates allocations at token registries to lock input tokens and
    authorize receipt of output tokens.

- **Back out of a stuck swap.** Can cancel an unsettled swap and unlock funds
  after the settlement deadline. **(Required role: `venue_user`)**

  - **Frontend:** Shows unsettled allocations, cancellation status, and withdrawal
    controls after the deadline.
  - **Client:** Requests withdrawal preparation and sends the wallet signature
    to the backend.
  - **Backend:** Checks ownership, deadlines, and ledger status; prepares withdrawals
    and records cancellation after confirmed withdrawals.
  - **DAML:** Allows withdrawal of unsettled allocations after the deadline.

### Settlement

- **Run settlements.** Can settle swaps, proportional deposits and withdrawals in batches; initial
  funding settles individually,
  following arrival order within each pool's swap, deposit or withdrawal queue,
  or manually select one eligible request to settle individually.
  **(Required role: `venue_operator`)**

  - **Frontend:** Each queue's Requests panel offers manual batch execution and its own automatic mode and batch size. Request details also allow running one eligible request as a singleton batch. Shows settlement previews and results.
  - **Client:** Sends settlement requests to the backend and fetches results.
  - **Backend:** Selects an eligible queue in turn, preserves its arrival order for batches,
    and submits one settlement per pool at a time. A blocked family does not
    stop the others. Automatic mode, batch size and policy version are independent per queue.
  - **DAML:** Atomically settles through `dvo` delegation, updating reserves and
    LP supply while enforcing signed limits and deadlines.

- **Review a batch before dispatch.** Can inspect projected reserves, payouts and signed limits,
  identify the first blocking request, and defer it while the remaining requests proceed.
  Can return deferred requests to their queue and retry rejected or cancelled attempts from current state.
  Deferral preserves locked funds and deadlines. **(Required role: `venue_operator`)**

### Provide Liquidity

- **Request to provide liquidity.** Can choose a pool, enter both token amounts,
  and review a quote with proportional deposit amounts, expected LP tokens and
  minimum LP output. Can approve the base and quote deposit allocations, LP receipt
  allocation and settlement deadline, then send signed allocation transactions to the
  backend to register the deposit request. **(Required role: `venue_user`)**

  - **Frontend:** Collects the pool, amount limits and slippage tolerance, shows
    quoted deposit amounts and expected and minimum LP tokens, and requests approval before wallet signing.
  - **Client:** Requests quotes, obtains wallet signatures for the deposit and
    LP receipt allocations, and sends signed transactions to the backend.
  - **Backend:** Quotes deposits within available balances and amount limits using
    the DVO's initial ratio for an empty pool or the current reserve ratio otherwise;
    prepares allocations, submits signed transactions,
    and stores deposit requests in the internal database for later settlement.
  - **DAML:** Creates two allocations at the token registries to lock the base
    and quote deposits, plus an unfunded LP receipt allocation. `Pool_AddLiquidity`
    recalculates against current state, checks signed limits and settles the deposits
    and LP mint through CIP-0112 atomically. Initial mint leaves a permanent
    `0.0000001 LP` minimum in supply without a redeemable holding.

- **Watch the position.** Can view the LP-token balance, pool share, and current
  redemption value for each pool. **(Required role: `venue_user`)**

  - **Frontend:** Shows LP-token balances, ownership shares, and redemption
    values per pool.
  - **Client:** Fetches pool positions and redemption values.
  - **Backend:** Calculates each position's share and redemption value from LP
    balances, pool reserves, and LP-token supply.
  - **DAML:** -

- **Request to withdraw liquidity.** Can choose a pool position, enter the LP-token
  amount to redeem, and review expected amounts of both assets. Can approve the
  allocation and settlement deadline, then send signed allocation transactions
  to the backend to register the withdrawal request. **(Required role: `venue_user`)**

  - **Frontend:** Collects the position and LP-token amount, shows payout
    estimates, and requests allocation and deadline approval before wallet signing.
  - **Client:** Requests redemption estimates, obtains wallet signatures for
    withdrawal allocations, and sends signed allocation transactions to the backend.
  - **Backend:** Estimates payouts, prepares allocations, submits signed transactions,
    and stores withdrawal requests in the internal database for later settlement.
  - **DAML:** `PoolAccess_RequestLiquidityWithdrawal` locks LP and authorizes receipt of both
    assets. Settlement burns the LP and pays both assets atomically; both
    requesting and settling a withdrawal require current KYC and pool access.

- **Recover expired liquidity allocations.** Can sign recovery of the remaining
  allocations after the settlement deadline, including when some were already
  withdrawn directly through CIP-0112. Current KYC and pool access are required.
  The UI distinguishes returned funds from released receipt permissions, and
  confirms recovery only from ledger evidence. **(Required role: `venue_user`)**

### Activity and History

- **Check activity and history.** Can view past and current activity
  across swaps, liquidity deposits, and withdrawals. **(Required role:
  `venue_user`)**

  - **Frontend:** Shows past and pending operations with status, expected
    amounts, and actual amounts after settlement.
  - **Client:** Fetches swap and liquidity activity, history, and operation
    status.
  - **Backend:** Returns the requested user's activity from the internal
    database cache and can refresh ledger results from the participant node.
  - **DAML:** -

### Venue Monitoring and Management

- Can monitor venue activity, manage treasury and traffic funding, and configure
  collection and sharing of the venue's CC app rewards.
  **(Required role: `venue_operator`)**

  - **Frontend:** Shows venue activity, balances, and reward collection status,
    with funding and reward-sharing settings.
  - **Client:** Fetches venue data and submits funding and reward-sharing
    settings with required approvals.
  - **Backend:** Summarizes authorized venue data and manages funding; uses Scan data
    for reward sharing and coordinates provider wallet collection and expiry alerts.
  - **DAML:** Existing Splice contracts handle validator traffic purchases and
    CC app reward collection.

### Authority Management

- **Manage settlement permissions.** Can coordinate granting and revoking the
  operator's settlement permissions with `dvo` approval.
  **(Required role: `venue_operator`)**

  - **Frontend:** Shows settlement permissions and available actions.
  - **Client:** Fetches permissions and submits change requests.
  - **Backend:** Coordinates changes with `dvo` authorization.
  - **DAML:** Requires `dvo` authorization to grant or revoke settlement permissions.
