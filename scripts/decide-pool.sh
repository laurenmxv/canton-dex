#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ $# != 2 || ! "$1" =~ ^(accept|reject)$ || ! "$2" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  printf 'Usage: %s accept|reject PROPOSAL_UUID\n' "$0" >&2
  exit 2
fi
make --no-print-directory prepare-localnet
docker compose run --rm --no-deps backend-tests ./gradlew \
  --project-cache-dir /root/.gradle/tests/project-cache --console=plain \
  poolDecision "-Pdecision=$1" "-Pproposal=$2"
