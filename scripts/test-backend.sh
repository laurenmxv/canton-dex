#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
scenario="${1:-all}"
case "$scenario" in
  schema|environment|iam|onboarding|pools|swaps|restart|all) ;;
  *) printf 'Usage: %s schema|environment|iam|onboarding|pools|swaps|restart|all\n' "$0" >&2; exit 2 ;;
esac

make --no-print-directory prepare-localnet

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
  chmod 600 "$restart_state"
  export DEX_RESTART_STATE="/workspace/$restart_state"
  cleanup_restart() {
    local result=$?
    trap - EXIT
    if [[ "$result" != 0 && -s "$restart_state" ]]; then
      if docker compose start backend && run_scenario restart-restore; then
        rm -f "$restart_state"
      else
        printf 'Restart cleanup incomplete; wallet recovery state retained at %s\n' "$restart_state" >&2
      fi
    else
      rm -f "$restart_state"
    fi
    exit "$result"
  }
  trap cleanup_restart EXIT
  run_scenario restart-prepare
  docker compose stop backend
  run_scenario restart-mark-uncertain
  docker compose start backend
  # The verification harness polls authenticated readiness with a bounded deadline.
  run_scenario restart-verify
fi
