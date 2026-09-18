#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf 'Usage: %s\n' "$0" >&2
  exit 2
fi

cd "$(dirname "${BASH_SOURCE[0]}")/../contracts"
unset DAML_PACKAGE

dpm_bin="${DPM_BIN:-}"
if [[ -z "$dpm_bin" ]]; then
  dpm_bin="$(command -v dpm || printf '%s' "$HOME/.dpm/bin/dpm")"
fi
if ! command -v "$dpm_bin" >/dev/null 2>&1; then
  printf 'DPM not found. Install DPM or set DPM_BIN.\n' >&2
  exit 1
fi

java_bin="${JAVA_HOME:+$JAVA_HOME/bin/}java"
if ! "$java_bin" -version >/dev/null 2>&1; then
  printf 'Java not found. Set JAVA_HOME to a working JDK.\n' >&2
  exit 1
fi

printf '\nBuilding contracts and tests...\n'
"$dpm_bin" build --all

for module in Onboarding PoolCreation Swaps; do
  printf '\n%s\n' "$module"
  "$dpm_bin" script \
    --dar tests/.daml/dist/oz-dex-ri-tests-0.0.0.dar \
    --ide-ledger --static-time --script-name "$module:main"
done

printf '\nTests passed.\n'
