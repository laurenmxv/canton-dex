#!/usr/bin/env bash
# Extract the pinned LocalNet archive into .deps/cn-localnet after verifying its checksum.
# The marker holds the checksum of the extracted archive, so an archive update replaces
# every extracted file instead of reusing an older extraction.
set -euo pipefail
if [[ $# -ne 3 ]]; then
  printf 'Usage: %s ARCHIVE SHA256 DIRECTORY\n' "$0" >&2
  exit 2
fi
archive=$1 expected=$2 directory=$3
marker="$directory/.prepared"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$archive" | cut -d' ' -f1)
fi
if [[ "$actual" != "$expected" ]]; then
  printf 'Refusing %s: SHA-256 %s does not match the pinned %s\n' "$archive" "$actual" "$expected" >&2
  exit 1
fi
if [[ -f "$marker" && "$(cat "$marker")" == "$expected" ]]; then
  exit 0
fi
rm -rf "$directory"
mkdir -p "$directory"
tar -xzf "$archive" -C "$directory"
printf '%s\n' "$expected" > "$marker"
printf 'Prepared LocalNet from %s\n' "$archive"
