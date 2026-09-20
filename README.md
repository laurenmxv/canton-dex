# Canton DEX

**Daml contracts · Java backend · TypeScript client · React app**

[Quickstart](#quickstart) · [Onboarding](#onboarding) · [Pool creation](#pool-creation) · [Swaps](#swaps) · [Development](#development)

---

## Prerequisites

- **Docker** with Compose 2.27+.
- **CLI tools:** Make and tar.

## Quickstart

From the repository root:

```sh
make docker-run
```

Extracts the bundled [LocalNet release](docker/artifacts/README.md), starts the stack, and configures Keycloak automatically. Docker downloads any missing container images.

| App | Backend | Keycloak |
| --- | --- | --- |
| [localhost:5180](http://localhost:5180/) | [localhost:18080](http://localhost:18080/) | [localhost:18082](http://localhost:18082/) |

- **Operator login:** `operator` / `test-password`
- **Stop, keeping data:** `make docker-stop`

## Onboarding

> **Trader applies → Operator approves → Trader signs**

1. **Prepare the wallet.** Install [MetaMask Flask](https://docs.metamask.io/snaps/get-started/install-flask/) in a separate Chrome profile. Unlock a test wallet without funds; disable regular MetaMask there.
2. **Submit an application.** Open the app, create an account, and select test documents in **Onboarding**.
3. **Approve as operator.** In another browser profile, open **Onboarding requests**, select the pools and party name, and approve.
4. **Register as trader.** Click **Connect MetaMask**, approve the Snap installation, then **Prepare party** → **Sign and register with MetaMask**. Confirm the wallet requests.
5. **Check the receipt.** Keep the page open until the attestation and CID appear.

> Reconnect with the same wallet, key index (`0` by default), and Snap ID (`local:http://localhost:4040`).

## Pool creation

> **Operator proposes → dvo accepts → Factory creates**

1. Create a proposal from the operator's **Pools** page and copy its UUID.
2. Run the local approver from the repository root:

   ```sh
   # Accept
   ./scripts/decide-pool.sh accept PROPOSAL_UUID

   # Or reject
   ./scripts/decide-pool.sh reject PROPOSAL_UUID
   ```

3. Watch the result in **Pools**. The script acts as `dvo`; acceptance creates the pool on Canton. Funding is outside this flow.

## Swaps

Bootstrap funds BTC/USDC and ETH/USDC pools with local test tokens. A trader signs a request that locks its input; the operator settles queued requests atomically per pool.

1. **Claim tokens as a trader.** Open **Swap**, select **Get test tokens**, then **Sign in MetaMask**. Each account can claim one bundle.
2. **Request a swap.** Choose a pool and direction, enter an amount, and select **Get a quote**. Check the exact input, minimum output and deadline before **Request swap** opens the wallet. Track confirmation under **Your requests**.
3. **Settle as operator.** Open **Settlement** and choose the pool. Set its batch target and **Save settings**. **Run batch** settles an eligible queue even below the target; **Automatic settlement** waits for the full target. Each pool saves its own settings.
4. **Check the result.** A confirmed batch records actual outputs and reserve changes. An expired request can be withdrawn with **Reclaim**, which requires a wallet signature.

See [token integration](docs/tokens.md) for the standard interfaces, package boundaries and supported settlement flow.

## Development

| Task | Command |
| --- | --- |
| Rebuild frontend / SDK | `make docker-run` |
| Restart backend | `docker compose restart backend` |
| Clear ledger and databases; keep containers stopped | `./scripts/dex-reset.sh` |
| Backend integration tests | `make test-backend` |
| Swap integration scenario | `./scripts/test-backend.sh swaps` |
| Daml tests (DPM + Java) | `make test` |
| Reset script tests (Python 3, no Docker changes) | `python3 -m unittest discover -s scripts/tests -v` |
| Validate database schema | `./scripts/test-backend.sh schema` |

`dex-reset.sh` stops the project's containers and empties the database and ledger
volumes, including Keycloak users and domain-upgrade snapshots. Containers,
volumes, networks, images, builds, dependency caches and wallet keys are retained.
Use `--dry-run` to preview or `--yes` to skip confirmation. Run `make docker-run`
afterward to initialize the databases and bootstrap fresh fixtures, then sign in
and onboard again.
