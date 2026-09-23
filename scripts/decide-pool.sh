#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ $# -lt 2 || ! "$1" =~ ^(accept|reject)$ || ! "$2" =~ ^[0-9a-fA-F-]{36}$ ]] || [[ "$1" == accept && $# != 3 ]] || [[ "$1" == reject && $# != 2 ]]; then
  printf 'Usage: %s accept PROPOSAL_UUID INITIAL_RATIO | reject PROPOSAL_UUID\n' "$0" >&2
  exit 2
fi
ratio_arg=()
if [[ "$1" == accept ]]; then ratio_arg=("-PinitialRatio=$3"); fi
make --no-print-directory prepare-localnet
docker compose run --rm --no-deps backend-tests ./gradlew \
  --project-cache-dir /root/.gradle/tests/project-cache --console=plain \
  poolDecision "-Pdecision=$1" "-Pproposal=$2" "${ratio_arg[@]}"
