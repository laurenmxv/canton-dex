#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ $# -lt 2 || ! "$1" =~ ^(accept|reject)$ || ! "$2" =~ ^[0-9a-fA-F-]{36}$ ]] || [[ "$1" == accept && $# != 3 ]] || [[ "$1" == reject && $# != 2 ]]; then
  printf 'Usage: %s accept PROPOSAL_UUID INITIAL_RATIO | reject PROPOSAL_UUID\n' "$0" >&2
  exit 2
fi
make --no-print-directory prepare-localnet
docker compose -f docker/compose.yaml run --rm --no-deps backend node dist/cli/decide-pool.js "$@"
