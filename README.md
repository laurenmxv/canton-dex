# Canton DEX

**Daml contracts · Java backend · TypeScript client · React app**

[Quickstart](#quickstart) · [Onboarding](#onboarding-and-creating-users) · [Pool creation](#pool-creation) · [Swaps](#swaps) · [Development](#development)

---

## Prerequisites

- **Docker** with Compose 2.27+.
- **CLI tools:** Make and tar.
- **DPM and Java** installed locally to run Daml tests with `make test`.
- **[MetaMask Flask](https://docs.metamask.io/snaps/get-started/install-flask/)** for signing in this local development setup.

## Quickstart

From the repository root:

```sh
make docker-run
```

| App | Backend | Keycloak |
| --- | --- | --- |
| [localhost:5180](http://localhost:5180/) | [localhost:18080](http://localhost:18080/) | [localhost:18082](http://localhost:18082/) |

- **Operator login:** `operator` / `operator`
- **Stop, keeping data:** `make docker-stop`

## Onboarding and creating users

Create a trader and approve access to the test pools.
Use separate browser profiles: trader with Flask; operator signed in with `operator` / `operator`.

1. **Trader:** Open the [app](http://localhost:5180/), click **Create an account**, and complete the form.
2. **Trader:** In **Onboarding**, enter a legal name and country code (`AR`), select test documents, and click **Submit application**.
3. **Operator:** In **Onboarding requests**, open the application, select BTC/USDC or ETH/USDC, keep the suggested party name, and click **Accept with … pools**.
4. **Trader:** Return to **Onboarding**, click **Connect MetaMask**, and approve the Canton Snap installation and wallet prompts.
5. **Trader:** Click **Prepare party** → **Sign and register with MetaMask**, then confirm in the wallet.
6. Wait for **Completed**; the trader is ready to swap.

## Pool creation

A pool lets traders exchange two tokens. Skip this section to try the funded BTC/USDC and ETH/USDC test pools.

1. **Operator:** Open **Pools** → **New pool** and fill in token admins, token IDs, fee, reserves, and LP supply.
2. Click **Review** → **Submit proposal**, then wait for pending approval.
3. Open the proposal's **Details** and copy its **Proposal ID**.
4. From the repository root, run `./scripts/decide-pool.sh accept PROPOSAL_UUID`, replacing `PROPOSAL_UUID` with the copied ID (approves the proposal as `dvo`).
5. Return to **Pools** and wait for **Created**.

New pools need separate funding and authorization for the operator to settle swaps; these steps only create the pool.

## Swaps

After onboarding, exchange local test tokens: the trader signs a request and the operator processes it.

1. **Trader:** Open **Swap** → **Get test tokens** → **Sign in MetaMask**, confirm, and wait for your balances.
2. Choose a pool, swap direction, and amount, then click **Get a quote**.
3. Review the quote, click **Request swap**, confirm in MetaMask, and wait for **Queued for settlement** under **Your requests**.
4. **Operator:** Open **Settlement**, choose the same pool, and click **Run batch**.
5. **Trader:** Check the final status and tokens received under **Your requests**.

## Development

| Task | Command |
| --- | --- |
| Refresh frontend and backend | `docker compose restart frontend backend` |
| Backend integration tests (Docker stack running) | `make test-backend` |
| Daml tests (local DPM and Java required) | `make test` |
