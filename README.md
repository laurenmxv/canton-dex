# Canton DEX

**Daml contracts · Java backend · TypeScript client · React app**

[Quickstart](#quickstart) · [Onboarding](#onboarding) · [Pool creation](#pool-creation) · [Development](#development)

---

## Prerequisites

- **Docker** with Compose 2.27+.
- **CLI tools:** Make, curl, tar, and `sha256sum` or `shasum`.

## Quickstart

From the repository root:

```sh
make docker-run
```

Downloads LocalNet, starts the stack, and configures Keycloak automatically.

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

> **Operator proposes → dvv accepts → Factory creates**

1. Create a proposal from the operator's **Pools** page and copy its UUID.
2. Run the local approver from the repository root:

   ```sh
   # Accept
   ./scripts/decide-pool.sh accept PROPOSAL_UUID

   # Or reject
   ./scripts/decide-pool.sh reject PROPOSAL_UUID
   ```

3. Watch the result in **Pools**. The script acts as `dvv`; acceptance creates the pool on Canton. Funding is outside this flow.

## Development

| Task | Command |
| --- | --- |
| Rebuild frontend / SDK | `make docker-run` |
| Restart backend | `docker compose restart backend` |
| Backend integration tests | `make test-backend` |
| Daml tests (DPM + Java) | `make test` |
| Validate database schema | `./scripts/test-backend.sh schema` |
