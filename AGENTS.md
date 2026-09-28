# Canton DEX

Reference DEX on Canton: React UI → TypeScript HTTP client → Node/TypeScript backend → Daml contracts.
Start with `README.md` for setup; `docs/user-stories.md` and `docs/flows/` describe intended behavior.

## Architecture

- `contracts/`: Daml ledger rules and settlement; `tests/` contains DEX Daml Script tests, `faucet/` local test tokens with their own tests in `faucet/tests/`.
- `backend/`: Node 24 / TypeScript API, workflows and PostgreSQL persistence (`src/`, `test/`, base schema in `db/schema.sql`). Business modules expose ledger ports; `canton/` implements them over the JSON Ledger API. Keep Ledger API wire and generated types inside `canton/` and module dependencies acyclic; `npm run lint` checks these rules.
- `client/`: typed HTTP API client (`@canton-dex/client`), consumed by the frontend.
- `frontend/`: React / Vite app and trader wallet signing through MetaMask Flask; operator commands run through the backend.
- Each buildable layer owns its `Dockerfile` and `.dockerignore`: `backend/`, `frontend/`, and `contracts/`. The client is a library consumed by the frontend.
- `docker/compose.dev.yaml`: the sole Compose entry point, for local development. It mounts the current sources; backend, bootstrap and tests install dependencies and compile on every start. Restart the affected service for source/package changes; recreate it for Compose/environment changes. `docker/env/`, `docker/localnet/`, and `docker/keycloak/` hold environment configuration; `scripts/` holds bootstrap and test tooling. See `docker/README.md` for contract refresh and path rules.

## Tests

Run commands from the repo root. Local prerequisites: Node 24; DPM/SDK 3.5.7 and Java 21 on `PATH` for contracts (DPM needs a JDK).
Install JS dependencies in order: `npm ci --prefix client && npm ci --prefix frontend && npm ci --prefix backend`.
For the Docker commands below, first run `make docker-run` (Docker Compose 2.27+, Make and tar).

| Layer | Local | Docker services |
| --- | --- | --- |
| Contracts | `make test` | `docker compose -f docker/compose.dev.yaml run --rm --no-deps -v "$PWD":/workspace:ro -w /workspace contract-builder make test` |
| Backend unit | `npm run typecheck --prefix backend && npm run lint --prefix backend && npm test --prefix backend` | `docker compose -f docker/compose.dev.yaml run --rm --no-deps backend-tests npm test` |
| Client | `npm test --prefix client` | `docker compose -f docker/compose.dev.yaml exec -w /app/client frontend npm test` |
| Frontend | `npm test --prefix frontend` | `docker compose -f docker/compose.dev.yaml exec frontend npm test` |

- Integration against the running Docker stack: `make test-backend`; one scenario: `./scripts/test-backend.sh onboarding` (see the script for others). The full suite stops/starts the backend to check recovery.
- Run checks for changed layers; for TypeScript also use `npm run typecheck --prefix client` and `npm run build --prefix frontend`. CI commands live in `.github/workflows/`.
- Contract builds and tests use a copy of `contracts/`, so the source tree stays unchanged; `contract-builder` writes the DARs to a volume.
- When contract changes alter a package ID, rebuild the affected DAR, read its `Main-Dalf` entry in `META-INF/MANIFEST.MF`, and update the corresponding constant in `backend/src/canton/packages.ts` in the same commit as the Daml changes. This required backend update is included even when the requested commit scope is Daml only; never commit the contracts and their package ID separately.
- `npm run generate --prefix backend` creates the Ledger API types in `backend/src/canton/generated/` from the participant's captured OpenAPI, `backend/src/canton/ledger-api/openapi.yaml`; edit sources, not generated files.
- Stop with `make docker-stop`. For an intentional state reset use `make docker-reset`; it preserves caches and volumes. Do not use `docker compose -f docker/compose.dev.yaml down --volumes` for a local reset.
