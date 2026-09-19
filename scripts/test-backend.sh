#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
scenario="${1:-all}"
case "$scenario" in
  schema|environment|iam|onboarding|pools|restart|all) ;;
  *) printf 'Usage: %s schema|environment|iam|onboarding|pools|restart|all\n' "$0" >&2; exit 2 ;;
esac

make --no-print-directory fetch-localnet

run_scenario() {
  docker compose run --rm --no-deps backend-tests ./gradlew \
    --project-cache-dir /root/.gradle/tests/project-cache --console=plain integrationTest "-Pscenario=$1"
}

if [[ "$scenario" != restart ]]; then
  run_scenario "$scenario"
fi
if [[ "$scenario" == restart || "$scenario" == all ]]; then
  mkdir -p backend/build
  restart_state="$(mktemp backend/build/restart-XXXXXX)"
  export DEX_RESTART_STATE="/workspace/$restart_state"
  trap 'rm -f "$restart_state"' EXIT
  run_scenario restart-prepare
  docker compose stop backend
  run_scenario restart-mark-uncertain
  docker compose start backend
  # The verification harness polls authenticated readiness with a bounded deadline.
  run_scenario restart-verify
fi
