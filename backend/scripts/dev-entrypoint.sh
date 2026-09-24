#!/bin/sh
set -eu

npm ci --no-audit --no-fund
# Remove outputs for sources that were deleted or renamed between restarts.
find dist -mindepth 1 -maxdepth 1 -exec rm -rf {} +
npm run build
exec "$@"
