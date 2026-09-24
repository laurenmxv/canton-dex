# Development Docker stack

Run `make docker-run` or `docker compose -f docker/compose.dev.yaml` from the
repository root. `compose.dev.yaml` is the sole Compose entry point, explicitly
for local development, and fixes the project name to `canton-dex`.

- `backend/Dockerfile`: Compose uses the `development` target for API, bootstrap,
  tests and CLI commands. Each start installs dependencies and compiles the mounted
  `backend/`. Per-container volumes isolate `node_modules`, `dist` and generated
  types. The `runtime` and `test` targets remain available for standalone builds
  and CI.
- `frontend/Dockerfile`: development tools; Compose mounts `frontend/` and
  `client/`. Each start installs their dependencies, and Vite reads both sources.
- `contracts/Dockerfile`: Daml tools; Compose mounts `contracts/` and runs its
  current build helper, compiling a temporary copy into the DAR volume.
- `client/`: library used by the frontend; no separate image.

## Apply changes

For backend, frontend or client source/package changes, restart the affected
service without rebuilding its image:

```sh
docker compose -f docker/compose.dev.yaml restart backend frontend
```

Vite also reloads frontend/client source changes while running. Bootstrap, tests
and CLI commands prepare the current backend sources each time they run.

For contract changes, rebuild the mounted sources, publish the DARs, then restart
the API in that order (with the stack running):

```sh
docker compose -f docker/compose.dev.yaml run --rm --no-deps contract-builder && \
docker compose -f docker/compose.dev.yaml run --rm --no-deps contract-bootstrap && \
docker compose -f docker/compose.dev.yaml restart backend
```

Contract package IDs must match `backend/src/canton/packages.ts`. Incompatible
contract generations or database schemas still require an intentional local state
reset with `make docker-reset`; restarts never reset state automatically.

Dockerfile/toolchain changes require an image rebuild. Compose or environment
changes require container recreation, for example:

```sh
docker compose -f docker/compose.dev.yaml up -d --force-recreate backend frontend
```

## Paths

`compose.dev.yaml` owns service wiring, ports, healthchecks, volumes, and environment
files. Paths in it are relative to `docker/`. Each image uses its layer as the
build context and keeps a `.dockerignore` there. Use absolute host paths for extra
CLI bind mounts, such as `-v "$PWD":/workspace:ro`, to avoid resolving them under
`docker/`.

`localnet/compose.override.yaml` customizes the vendored LocalNet participant and
Keycloak. Its paths are relative to the first file in that include group,
`.deps/cn-localnet/infra/compose.yaml`. Keep the Keycloak theme's frontend assets
as directory mounts. LocalNet release archives remain in `artifacts/`.

`env/` contains local development configuration. Preserve the project name and
named volumes when reorganizing the stack; use `make docker-reset` only for an
intentional state reset.
