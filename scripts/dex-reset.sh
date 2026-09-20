#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: dex-reset.sh [--yes | --dry-run]

Stop the local canton-dex services and clear ledger and database contents.
This resets Canton history, parties, contracts, Keycloak users, application
data and domain-upgrade snapshots. Containers, volumes, networks, images,
builds and dependency caches are retained. Services remain stopped.
Browser storage and wallet keys are not touched. The next make docker-run
initializes the databases and runs the contract and Keycloak bootstrap.

  --yes      Reset without the interactive confirmation.
  --dry-run  Show what will be removed without changing anything.
EOF
}

mode=confirm
if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi
case "${1:-}" in
  '') ;;
  --yes) mode=yes ;;
  --dry-run) mode=preview ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

# Refuse remote Docker endpoints; this command resets local development only.
docker_host="${DOCKER_HOST:-}"
if [[ -n "${DOCKER_CONTEXT:-}" || -z "$docker_host" ]]; then
  docker_host="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
fi
case "$docker_host" in
  unix://*|npipe://*) ;;
  *) printf 'Refusing to reset a non-local Docker endpoint: %s\n' "$docker_host" >&2; exit 1 ;;
esac

project_filter='label=com.docker.compose.project=canton-dex'
volumes=()
# Select only persistent application/ledger state, never Gradle caches.
for name in application-postgres localnet-postgres domain-upgrade-dump; do
  matches="$(docker volume ls --filter "$project_filter" \
    --filter "label=com.docker.compose.volume=$name" --format '{{.Name}}')"
  while IFS= read -r volume; do
    [[ -n "$volume" ]] || continue
    volumes+=("$volume")
  done <<< "$matches"
done

printf 'Local Docker project: canton-dex\nContainers:\n'
docker ps -a --filter "$project_filter" --format '  {{.Names}}'
printf 'Volume contents to clear (volume objects are kept):\n'
if [[ ${#volumes[@]} -gt 0 ]]; then
  printf '  %s\n' "${volumes[@]}"
else
  printf '  None; no persisted state exists.\n'
fi

if [[ "$mode" == preview ]]; then
  exit 0
fi
if [[ "$mode" == confirm ]]; then
  printf '\nThis permanently deletes the local DEX state. Type RESET to continue: '
  if ! read -r answer || [[ "$answer" != RESET ]]; then
    printf 'Reset cancelled.\n'
    exit 1
  fi
fi

# Labels keep the target independent of inherited COMPOSE_* settings and cover
# old services too. Stop containers without removing or recreating them.
running="$(docker ps -q --filter "$project_filter")"
containers=()
while IFS= read -r container; do
  [[ -n "$container" ]] || continue
  containers+=("$container")
done <<< "$running"
if [[ ${#containers[@]} -gt 0 ]]; then
  docker stop "${containers[@]}"
fi
if [[ -n "$(docker ps -q --filter "$project_filter")" ]]; then
  printf 'Project containers are still running; refusing to clear data.\n' >&2
  exit 1
fi

# A temporary helper empties each data volume, preserving its identity and root
# permissions. The PostgreSQL image is already used by both database services.
if [[ ${#volumes[@]} -gt 0 ]]; then
  for volume in "${volumes[@]}"; do
    docker run --rm --network none --entrypoint sh \
      --mount "type=volume,source=$volume,target=/reset-state" postgres:14 \
      -c 'find /reset-state -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'
  done
fi

printf '\nLedger and database state cleared. Containers are retained and stopped.\n'
printf 'Run make docker-run to initialize the databases and bootstrap fresh fixtures.\n'
printf 'Sign in again after restarting; existing wallet keys can be reused.\n'
