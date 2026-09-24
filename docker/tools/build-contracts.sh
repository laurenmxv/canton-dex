#!/usr/bin/env bash
# Build the Daml packages from a copy of the read-only /contracts sources into /dars.
# The source tree is never written, so its vendored DARs and package pins stay byte-identical.
set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/contracts"
tar -C /contracts --exclude=.daml -cf - . | tar -C "$work/contracts" -xf -
cd "$work/contracts"
unset DAML_PACKAGE
dpm build --all
install -m 0644 .daml/dist/canton-dex-ri-0.1.0.dar test-faucet/.daml/dist/canton-dex-test-faucet-0.1.0.dar /dars/
sha256sum /dars/*.dar
