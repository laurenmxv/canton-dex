#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf 'Usage: %s\n' "$0" >&2
  exit 2
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
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

# Build a copy so the source tree, its vendored DARs and package pins stay unchanged.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/contracts"
tar -C contracts --exclude=.daml -cf - . | tar -C "$work/contracts" -xf -
cd "$work/contracts"

printf '\nBuilding contracts and tests...\n'
"$dpm_bin" build --all

DAML_PACKAGE=tests "$dpm_bin" test
DAML_PACKAGE=faucet/tests "$dpm_bin" test

printf '\nTests passed.\n'
