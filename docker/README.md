# Docker structure

Run `make docker-run` or `docker compose -f docker/compose.yaml` from the repository
root. This directory's `compose.yaml` is the sole entry point and fixes the project
name to `canton-dex`.

- `backend/Dockerfile`: API and bootstrap runtime, plus the `test` target.
- `frontend/Dockerfile`: development tools; Compose mounts `frontend/` and `client/`.
- `contracts/Dockerfile`: Daml tools and the contract build helper.
- `client/`: library used by the frontend; no separate image.

`compose.yaml` owns service wiring, ports, healthchecks, volumes, and environment
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
