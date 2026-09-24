#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
compose=(docker compose -f docker/compose.dev.yaml)
scenario="${1:-all}"
case "$scenario" in
  schema|environment|iam|onboarding|pools|swaps|liquidity|restart|all) ;;
  *) printf 'Usage: %s schema|environment|iam|onboarding|pools|swaps|liquidity|restart|all\n' "$0" >&2; exit 2 ;;
esac

make --no-print-directory prepare-localnet

run_scenario() {
  "${compose[@]}" run --rm --no-deps -e "DEX_SCENARIO=$1" backend-tests
}

if [[ "$scenario" != restart ]]; then
  run_scenario "$scenario"
fi
if [[ "$scenario" == restart || "$scenario" == all ]]; then
  mkdir -p backend/build
  restart_state="$(mktemp backend/build/restart-XXXXXX)"
  chmod 600 "$restart_state"
  export DEX_RESTART_STATE="/app/build/${restart_state#backend/build/}"
  cleanup_restart() {
    local result=$?
    trap - EXIT
    if [[ "$result" != 0 && -s "$restart_state" ]]; then
      if "${compose[@]}" start backend && run_scenario restart-restore; then
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
  "${compose[@]}" stop backend
  run_scenario restart-mark-uncertain
  "${compose[@]}" start backend
  # The verification harness polls authenticated readiness with a bounded deadline.
  run_scenario restart-verify
fi
