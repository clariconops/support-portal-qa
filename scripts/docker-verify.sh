#!/bin/sh
# Verification pipeline run inside node:20-bookworm-slim via Docker
# (host has no Node). Installs Linux deps into the qafw_deps volume so the
# Windows node_modules on the host is never touched.
set -e
cd /app

echo "== npm install =="
if npm install --no-audit --no-fund --loglevel=error > /tmp/npm.log 2>&1; then
  tail -n 2 /tmp/npm.log
else
  echo "npm install FAILED:"; tail -n 25 /tmp/npm.log; exit 1
fi

echo "== generate automation matrix =="
node ./node_modules/tsx/dist/cli.mjs scripts/generate-automation-matrix.ts

echo "== qa list =="
node ./node_modules/tsx/dist/cli.mjs src/cli.ts list

echo "== qa validate =="
node ./node_modules/tsx/dist/cli.mjs src/cli.ts validate

echo "== typecheck (tsc --noEmit) =="
./node_modules/.bin/tsc --noEmit --pretty false

echo "ALL_CHECKS_PASSED"
