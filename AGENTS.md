# Canton DEX

Reference DEX on Canton: React UI → TypeScript HTTP client → Java backend → Daml contracts.
Start with `README.md` for setup; `docs/user-stories.md` and `docs/flows/` describe intended behavior.

## Architecture

- `contracts/`: Daml ledger rules and settlement; `tests/` contains Daml Script tests, `test-faucet/` local test tokens.
- `backend/`: Java 21 / Spring Boot API, workflows and PostgreSQL persistence. Business modules expose ledger ports; `canton/` implements them. Keep Daml/gRPC/generated types inside `canton/` and module dependencies acyclic.
- `client/`: typed HTTP API client (`@canton-dex/client`), consumed by the frontend.
- `frontend/`: React / Vite app and trader wallet signing through MetaMask Flask; operator commands run through the backend.
- `docker/`, `compose*.yaml`, `scripts/`: local Canton/Keycloak/PostgreSQL stack, bootstrap and test tooling.

## Tests

Run commands from the repo root. Local prerequisites: Java 21, DPM/SDK 3.5.7 on `PATH`, Node 24.
Install JS dependencies in order: `npm ci --prefix client && npm ci --prefix frontend`.
For the Docker commands below, first run `make docker-run` (Docker Compose 2.27+, Make and tar).

| Layer | Local | Docker services |
| --- | --- | --- |
| Contracts | `make test` | `docker compose run --rm --no-deps -w /workspace/contracts backend-tests sh -c 'dpm build --all && DAML_PACKAGE=tests dpm test'` |
| Backend unit | `(cd backend && ./gradlew test)` | `docker compose run --rm --no-deps backend-tests ./gradlew --project-cache-dir /root/.gradle/tests/project-cache test` |
| Client | `npm test --prefix client` | `docker compose exec -w /app/client frontend npm test` |
| Frontend | `npm test --prefix frontend` | `docker compose exec frontend npm test` |

- Integration against the running Docker stack: `make test-backend`; one scenario: `./scripts/test-backend.sh onboarding` (see the script for others). The full suite stops/starts the backend to check recovery.
- Run checks for changed layers; for TypeScript also use `npm run typecheck --prefix client` and `npm run build --prefix frontend`. CI commands live in `.github/workflows/`.
- Backend compilation builds contracts and generates Java bindings automatically; edit sources, not generated bindings.
- Stop with `make docker-stop`. For an intentional state reset use `make docker-reset`; it preserves caches and volumes. Do not use `docker compose down --volumes` for a local reset.
